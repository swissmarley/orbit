import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { OrbitConfig, Redactor } from '@orbit/core';
import { ApprovalQueue, AuditLog, PolicyEngine, RuleStore } from '@orbit/policy';
import { BotRepo, Controls, EventStore, type OrbitDb, openDatabase } from '@orbit/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliDriver } from '../src/drivers/cli';
import { FIXTURES_DIR } from '../src/drivers/fixtures';
import { HookBridge } from '../src/drivers/hook-bridge';
import { type QueryFn, SdkDriver } from '../src/drivers/sdk';
import type { AgentDriver } from '../src/drivers/types';
import { Orchestrator } from '../src/orchestrator';
import { readFixture, replay } from './fake-engine.mjs';

/**
 * Per-Run pause (ADR-016) through each real permission path: the SDK
 * engine's PreToolUse hook callback and the CLI engine's hook command via
 * the loopback bridge. The pause lands on the next tool-call decision.
 */

const FAKE_CLAUDE = join(import.meta.dirname, 'fake-claude.mjs');
const FIXTURE = (name: string) => join(FIXTURES_DIR, 'claude-2.1.289', `${name}.jsonl`);
const env = { PATH: process.env.PATH, HOME: process.env.HOME };

let bridge: HookBridge;
const dirs: string[] = [];

beforeAll(async () => {
  bridge = await HookBridge.start();
});
afterAll(async () => {
  await bridge.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Fake Agent SDK query(): replays a fixture through the driver's real PreToolUse hook. */
function fakeQuery(fixture: string): QueryFn {
  return async function* ({ options }) {
    const signal = options.abortController!.signal;
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const decide = (input: Record<string, unknown>) =>
      hook(input as Parameters<HookCallback>[0], input.tool_use_id as string, { signal });
    const messages = readFixture(fixture).map((m) =>
      m.type === 'system' && m.subtype === 'init' ? { ...m, apiKeySource: 'ANTHROPIC_API_KEY' } : m,
    );
    for await (const m of replay(messages, {
      decide,
      sessionId: options.resume ?? options.sessionId,
      cwd: options.cwd ?? '/',
    })) {
      yield m as unknown as SDKMessage;
    }
  };
}

function setup(driver: AgentDriver, workspace: string) {
  const db: OrbitDb = openDatabase(':memory:');
  const store = new EventStore(db, new Redactor());
  const approvals = new ApprovalQueue(db, { audit: new AuditLog(db), events: store });
  const bots = new BotRepo(db);
  const orchestrator = new Orchestrator({
    config: OrbitConfig.parse({ home: workspace }),
    store,
    bots,
    controls: new Controls(db),
    approvals,
    policy: new PolicyEngine(approvals, new RuleStore(db)),
    driver,
    redactor: new Redactor(),
    workspaces: () =>
      Promise.resolve({ path: workspace, shellContained: false, engineSandbox: null }),
    killPollMs: 20,
  });
  const bot = bots.create({ name: 'Reader', goal: 'Read the notes' });
  return { db, store, orchestrator, bot };
}

function workspace(control: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-pause-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.fake-claude.json'), JSON.stringify(control));
  return dir;
}

const drivers: [string, () => { driver: AgentDriver; cwd: string }][] = [
  [
    'SdkDriver (PreToolUse hook callback)',
    () => ({
      driver: new SdkDriver({
        authMethod: 'api_key',
        env: { ...env, ANTHROPIC_API_KEY: 'sk-ant-api03-test-000000' },
        bare: true,
        apiKeyHelper: null,
        queryFn: fakeQuery(FIXTURE('many-reads')),
      }),
      cwd: workspace({ behavior: 'normal' }),
    }),
  ],
  [
    'CliDriver (hook command through the bridge)',
    () => ({
      driver: new CliDriver({
        claudePath: FAKE_CLAUDE,
        authMethod: 'subscription',
        env,
        bridge,
        killGraceMs: 500,
      }),
      cwd: workspace({ behavior: 'normal', fixture: FIXTURE('many-reads') }),
    }),
  ],
];

describe.each(drivers)('pause at the next tool call — %s', (_name, make) => {
  it('denies that call, stops the engine and ends the segment paused', async () => {
    const { driver, cwd } = make();
    const { db, store, orchestrator, bot } = setup(driver, cwd);
    try {
      const run = await orchestrator.run(bot, {
        onEvent: (e) => {
          if (e.type === 'session.init') queueMicrotask(() => orchestrator.pause(e.runId, 'owner'));
        },
      });
      expect(run.status).toBe('paused');
      expect(run.pause).toMatchObject({ reason: 'owner', toolName: 'Read' });
      const events = store.listRunEvents(run.runId);
      const decisions = events.filter((e) => e.type === 'permission.decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.type === 'permission.decision' && decisions[0].data.behavior).toBe(
        'deny',
      );
      expect(events.at(-1)?.type).toBe('run.paused');
      expect(orchestrator.activeRuns()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
