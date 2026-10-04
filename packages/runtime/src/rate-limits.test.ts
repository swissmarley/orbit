import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitConfig, Redactor, type RunState } from '@orbit/core';
import { ApprovalQueue, PolicyEngine, RuleStore } from '@orbit/policy';
import { BotRepo, Controls, EventStore, type OrbitDb, openDatabase } from '@orbit/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockDriver } from './drivers/mock';
import { Orchestrator } from './orchestrator';
import { RateLimitManager } from './rate-limits';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('RateLimitManager', () => {
  let home: string;
  let db: OrbitDb;
  let store: EventStore;
  let bots: BotRepo;
  let orchestrator: Orchestrator;
  let t: number;
  let resumed: string[];
  let manager: RateLimitManager;
  let off: () => void;

  const make = () =>
    new RateLimitManager({
      store,
      bots,
      resume: (run: RunState) => resumed.push(run.runId),
      now: () => new Date(t),
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orbit-rl-'));
    db = openDatabase(':memory:');
    store = new EventStore(db, new Redactor());
    bots = new BotRepo(db);
    const approvals = new ApprovalQueue(db, { events: store });
    orchestrator = new Orchestrator({
      config: OrbitConfig.parse({ home }),
      store,
      bots,
      controls: new Controls(db),
      approvals,
      policy: new PolicyEngine(approvals, new RuleStore(db)),
      driver: new MockDriver(),
      redactor: new Redactor(),
    });
    t = Date.parse('2026-10-04T12:00:00.000Z');
    resumed = [];
    manager = make();
    off = manager.start();
  });
  afterEach(() => {
    off();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('holds the queue until the reset and schedules "resumes at" for the Run', async () => {
    const run = await orchestrator.run(
      bots.create({ name: 'A', goal: 'g', mock: { fixture: 'usage-limit' } }),
    );
    expect(run.status).toBe('rate_limited');
    await flush();
    const resetsAt = store.getRun(run.runId)!.usageLimit!.resetsAt!;
    expect(manager.hold()).toBe(`usage limit reached — resumes at ${resetsAt}`);
    expect(manager.pausedUntilIso()).toBe(resetsAt);
    const state = store.getRun(run.runId)!;
    const expectedAt = new Date(Date.parse(resetsAt) + 30_000).toISOString();
    expect(state.resumeAt).toBe(expectedAt);
    expect(store.listRunEvents(run.runId).at(-1)).toMatchObject({
      type: 'run.resume_scheduled',
      data: { at: expectedAt, reason: 'usage_limit' },
    });

    t = Date.parse(resetsAt) + 1000;
    manager.tick();
    expect(manager.hold()).toBeNull();
    expect(resumed).toEqual([]);
    t = Date.parse(expectedAt);
    manager.tick();
    expect(resumed).toEqual([run.runId]);
    manager.tick();
    expect(resumed).toEqual([run.runId]);
  });

  it('does not schedule a resume when the Bot opted out, but still holds the queue', async () => {
    const run = await orchestrator.run(
      bots.create({
        name: 'B',
        goal: 'g',
        mock: { fixture: 'usage-limit' },
        autoResumeAfterUsageLimit: false,
      }),
    );
    await flush();
    expect(store.getRun(run.runId)?.resumeAt).toBeNull();
    expect(manager.hold()).not.toBeNull();
    t += 7 * 24 * 3_600_000;
    manager.tick();
    expect(resumed).toEqual([]);
  });

  it('skips Runs that were stopped or resumed by hand before their time', async () => {
    const run = await orchestrator.run(
      bots.create({ name: 'C', goal: 'g', mock: { fixture: 'usage-limit' } }),
    );
    await flush();
    orchestrator.stop(run.runId, 'owner');
    t += 30 * 24 * 3_600_000;
    manager.tick();
    expect(resumed).toEqual([]);
  });

  it('recovers holds and schedules from the log after a restart', async () => {
    const run = await orchestrator.run(
      bots.create({ name: 'D', goal: 'g', mock: { fixture: 'usage-limit' } }),
    );
    await flush();
    off();
    const at = store.getRun(run.runId)!.resumeAt!;
    const restarted = make();
    restarted.recover();
    expect(restarted.hold()).not.toBeNull();
    t = Date.parse(at);
    restarted.tick();
    expect(resumed).toEqual([run.runId]);
  });

  it('uses a fallback pause when the engine gives no reset time', () => {
    const bot = bots.create({ name: 'E', goal: 'g' });
    const queued = orchestrator.enqueue(bot);
    store.append(queued.runId, bot.id, [
      {
        type: 'run.rate_limited',
        data: { resetsAt: null, limitType: null, message: 'limit', sessionId: 's' },
      },
    ]);
    const m = make();
    m.recover();
    expect(m.pausedUntilIso()).toBe(new Date(t + 30 * 60_000).toISOString());
    expect(store.getRun(queued.runId)?.resumeAt).toBe(
      new Date(t + 30 * 60_000 + 30_000).toISOString(),
    );
  });
});
