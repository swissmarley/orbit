import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitConfig, Redactor, replayRun } from '@orbit/core';
import { BotRepo, EventStore, openDatabase } from '@orbit/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockDriver } from './drivers/mock';
import type { AgentDriver, PermissionHandler } from './drivers/types';
import { Orchestrator } from './orchestrator';

const readOnly: PermissionHandler = (r) =>
  Promise.resolve(
    r.toolName === 'Read'
      ? { behavior: 'allow', reason: 'read' }
      : { behavior: 'deny', reason: 'writes need approval' },
  );

describe('Orchestrator', () => {
  let home: string;
  let db: ReturnType<typeof openDatabase>;
  let store: EventStore;
  let bots: BotRepo;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orbit-orch-'));
    db = openDatabase(':memory:');
    store = new EventStore(db, new Redactor());
    bots = new BotRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const orchestrator = (driver: AgentDriver = new MockDriver()) =>
    new Orchestrator({
      config: OrbitConfig.parse({ home }),
      store,
      driver,
      permissionFor: () => readOnly,
    });

  it('runs one Bot once, persists every event and returns the projection', async () => {
    const bot = bots.create({
      name: 'Notes',
      goal: 'Summarize notes.txt',
      mock: { fixture: 'read-then-write-denied' },
    });
    const seen: string[] = [];
    const run = await orchestrator().run(bot, { onEvent: (e) => seen.push(e.type) });
    expect(run.status).toBe('completed');
    expect(run.driver).toBe('mock');
    // run.started records the configured alias; session.init the model the engine resolved.
    const started = store.listRunEvents(run.runId).find((e) => e.type === 'run.started');
    expect(started?.type === 'run.started' && started.data.model).toBe('opus');
    expect(run.model).toBe('claude-haiku-4-5-20251001');
    expect(run.prompt).toBe('Summarize notes.txt');
    expect(run.counts.denied).toBe(1);
    expect(run.cwd).toBe(join(home, 'workspaces', 'notes'));
    expect(seen[0]).toBe('run.queued');
    expect(seen.at(-1)).toBe('run.completed');
    const events = store.listRunEvents(run.runId);
    expect(events).toHaveLength(seen.length);
    expect(replayRun(events)).toEqual(run);
  });

  it('records a usage-limit pause as rate_limited', async () => {
    const bot = bots.create({ name: 'Limited', goal: 'x', mock: { fixture: 'usage-limit' } });
    const run = await orchestrator().run(bot);
    expect(run.status).toBe('rate_limited');
    expect(run.usageLimit?.resetsAt).toBe('2026-10-05T00:00:00.000Z');
  });

  it('cancels when the caller aborts', async () => {
    const bot = bots.create({ name: 'Slow', goal: 'x', mock: { fixture: 'subagent-delegation' } });
    const controller = new AbortController();
    const run = await orchestrator(new MockDriver({ delayMs: 5000 })).run(bot, {
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'session.init') controller.abort();
      },
    });
    expect(run.status).toBe('cancelled');
  });

  it('turns a driver that breaks the contract into a failed run', async () => {
    const bot = bots.create({ name: 'Broken', goal: 'x' });
    const broken: AgentDriver = {
      kind: 'mock',
      authMethod: 'mock',
      // eslint-disable-next-line require-yield
      async *run() {
        throw new Error('kaboom');
      },
    };
    const run = await orchestrator(broken).run(bot);
    expect(run.status).toBe('failed');
    expect(run.error?.message).toBe('kaboom');
  });
});
