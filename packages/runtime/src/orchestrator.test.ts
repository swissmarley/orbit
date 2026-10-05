import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BotSpecInput,
  OrbitConfig,
  Redactor,
  type RunEvent,
  type RunState,
  event,
  replayRun,
} from '@orbit/core';
import { ApprovalQueue, AuditLog, PolicyEngine, RuleStore } from '@orbit/policy';
import { BotRepo, Controls, EventStore, type OrbitDb, openDatabase } from '@orbit/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockDriver, type MockDriverOptions } from './drivers/mock';
import type { AgentDriver } from './drivers/types';
import { Orchestrator } from './orchestrator';

interface World {
  home: string;
  db: OrbitDb;
  store: EventStore;
  bots: BotRepo;
  controls: Controls;
  approvals: ApprovalQueue;
  rules: RuleStore;
  audit: AuditLog;
  redactor: Redactor;
  orchestrator: (driver?: AgentDriver) => Orchestrator;
  bot: (spec: Partial<BotSpecInput> & { fixture: string }) => ReturnType<BotRepo['create']>;
}

function world(dbPath = ':memory:', mock: MockDriverOptions = {}): World {
  const home = mkdtempSync(join(tmpdir(), 'orbit-orch-'));
  const db = openDatabase(dbPath === ':memory:' ? dbPath : join(home, dbPath));
  const redactor = new Redactor(['launch window opens']);
  const store = new EventStore(db, new Redactor());
  const audit = new AuditLog(db, redactor);
  const approvals = new ApprovalQueue(db, { audit, events: store });
  const rules = new RuleStore(db);
  const bots = new BotRepo(db);
  const controls = new Controls(db);
  let n = 0;
  return {
    home,
    db,
    store,
    bots,
    controls,
    approvals,
    rules,
    audit,
    redactor,
    orchestrator: (driver = new MockDriver(mock)) =>
      new Orchestrator({
        config: OrbitConfig.parse({ home }),
        store,
        bots,
        controls,
        approvals,
        policy: new PolicyEngine(approvals, rules),
        driver,
        redactor,
        audit,
        killPollMs: 20,
      }),
    bot: ({ fixture, ...spec }) =>
      bots.create({
        name: `Bot ${++n}`,
        goal: 'Do the task',
        mock: { fixture },
        approvals: { parkWindowSeconds: 0 },
        ...spec,
      }),
  };
}

const types = (events: RunEvent[]) => events.map((e) => e.type);

describe('Orchestrator', () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });
  afterEach(() => {
    w.db.close();
    rmSync(w.home, { recursive: true, force: true });
  });

  describe('tiers', () => {
    it('auto-allows reads and writes inside the workspace, and records the tier', async () => {
      const run = await w.orchestrator().run(w.bot({ fixture: 'read-then-write-denied' }));
      expect(run.status).toBe('completed');
      const decisions = w.store
        .listRunEvents(run.runId)
        .flatMap((d) =>
          d.type === 'permission.decision' ? [[d.data.toolName, d.data.behavior, d.data.tier]] : [],
        );
      expect(decisions).toEqual([
        ['Read', 'allow', 'READ'],
        ['Write', 'allow', 'WRITE_LOCAL'],
      ]);
    });

    it('hands FINANCIAL actions back to the human and audits the denial', async () => {
      const run = await w.orchestrator().run(w.bot({ fixture: 'financial' }));
      const d = w.store.listRunEvents(run.runId).find((e) => e.type === 'permission.decision');
      expect(d?.type === 'permission.decision' && d.data.behavior).toBe('deny');
      expect(d?.type === 'permission.decision' && d.data.tier).toBe('FINANCIAL');
      expect(d?.type === 'permission.decision' && d.data.reason).toMatch(/never executes/);
      expect(w.approvals.list()).toEqual([]);
      expect(w.audit.list({ action: 'policy.denied' })).toHaveLength(1);
    });

    it('asks before uncontained shell commands', async () => {
      const run = await w.orchestrator().run(w.bot({ fixture: 'bash' }));
      expect(run.status).toBe('waiting_approval');
      expect(w.approvals.list()[0]?.tier).toBe('EXTERNAL');
    });
  });

  describe('approvals: park and resume', () => {
    it('parks the Run when an EXTERNAL action is not decided in time', async () => {
      const bot = w.bot({ fixture: 'send-email' });
      const run = await w.orchestrator().run(bot);
      expect(run.status).toBe('waiting_approval');
      expect(run.endedAt).toBeNull();
      const [approval] = w.approvals.list({ status: 'pending' });
      expect(run.pendingApprovals).toEqual([approval!.id]);
      expect(approval!.card).toMatchObject({
        what: 'send email (gmail) → ada@example.com',
        why: 'I drafted the reply to Ada and will send it now.',
        tier: 'EXTERNAL',
        botName: bot.spec.name,
      });
      const events = types(w.store.listRunEvents(run.runId));
      expect(events).toContain('approval.requested');
      expect(events.at(-1)).toBe('run.parked');
      expect(w.audit.list({ action: 'approval.requested' })).toHaveLength(1);
    });

    it('resumes after approval and runs exactly the approved call', async () => {
      const o = w.orchestrator();
      const parked = await o.run(w.bot({ fixture: 'send-email' }));
      const [approval] = w.approvals.list({ status: 'pending' });
      await expect(o.resume(parked.runId)).rejects.toThrow(/still waits/);
      w.approvals.decide(approval!.id, { approve: true, by: 'owner' });
      const done = await o.resume(parked.runId);
      expect(done.status).toBe('completed');
      const events = w.store.listRunEvents(parked.runId);
      expect(types(events)).toContain('run.resumed');
      const allowed = events.filter(
        (e) => e.type === 'permission.decision' && e.data.behavior === 'allow',
      );
      const lastAllowed = allowed.at(-1);
      expect(lastAllowed?.type === 'permission.decision' && lastAllowed.data.approvalId).toBe(
        approval!.id,
      );
      // the projection is still a pure fold of the log
      expect(replayRun(events)).toEqual(w.store.getRun(parked.runId));
    });

    it('edit-then-approve runs the edited input', async () => {
      const o = w.orchestrator();
      const parked = await o.run(w.bot({ fixture: 'send-email' }));
      const [approval] = w.approvals.list({ status: 'pending' });
      const edited = {
        ...approval!.input,
        body: 'Confirmed: Tuesday 09:00 UTC. — Sent by my assistant',
      };
      w.approvals.decide(approval!.id, { approve: true, by: 'owner', editedInput: edited });
      await o.resume(parked.runId);
      const allowed = w.store
        .listRunEvents(parked.runId)
        .filter((e) => e.type === 'permission.decision' && e.data.behavior === 'allow');
      const lastAllowed = allowed.at(-1);
      expect(lastAllowed?.type === 'permission.decision' && lastAllowed.data.input).toEqual(edited);
    });

    it('a decision inside the park window is applied without parking (deny with reason)', async () => {
      const bot = w.bot({ fixture: 'send-email', approvals: { parkWindowSeconds: 5 } });
      const run = await w.orchestrator().run(bot, {
        onEvent: (e) => {
          if (e.type === 'approval.requested') {
            setTimeout(
              () =>
                w.approvals.decide(e.data.approvalId, {
                  approve: false,
                  by: 'owner',
                  reason: 'wrong recipient',
                }),
              10,
            );
          }
        },
      });
      expect(run.status).toBe('completed');
      const d = w.store
        .listRunEvents(run.runId)
        .filter((e) => e.type === 'permission.decision')
        .at(-1);
      expect(d?.type === 'permission.decision' && d.data.reason).toMatch(
        /denied this: wrong recipient/,
      );
    });

    it('"always allow" creates a scoped rule that auto-allows the next Run', async () => {
      const o = w.orchestrator();
      const bot = w.bot({ fixture: 'send-email' });
      const parked = await o.run(bot);
      const [approval] = w.approvals.list({ status: 'pending' });
      w.approvals.decide(approval!.id, {
        approve: true,
        by: 'owner',
        always: { scope: 'bot', expiresAt: null },
      });
      await o.resume(parked.runId);
      const next = await o.run(bot);
      expect(next.status).toBe('completed');
      const d = w.store
        .listRunEvents(next.runId)
        .find(
          (e) => e.type === 'permission.decision' && e.data.toolName === 'mcp__gmail__send_email',
        );
      expect(d?.type === 'permission.decision' && d.data.ruleId).toBe(
        approval && w.approvals.get(approval.id)?.decision?.ruleId,
      );
    });
  });

  describe('untrusted content', () => {
    it('asks before a web request once the Run is tainted (exfiltration guard)', async () => {
      const bot = w.bot({ fixture: 'web-then-send' });
      const run = await w.orchestrator().run(bot);
      // The first WebFetch runs untainted; the send afterwards asks.
      expect(run.taintSources).toEqual(['WebFetch']);
      const asks = w.approvals.list({ runId: run.runId });
      expect(asks.map((a) => a.toolName)).toEqual(['mcp__gmail__send_email']);
    });

    it('audits approved actions when they actually run', async () => {
      const o = w.orchestrator();
      const parked = await o.run(w.bot({ fixture: 'send-email' }));
      const [approval] = w.approvals.list({ status: 'pending' });
      w.approvals.decide(approval!.id, { approve: true, by: 'owner' });
      await o.resume(parked.runId);
      expect(w.audit.list({ action: 'policy.allowed_by_approval' })).toHaveLength(1);
    });

    it('taints the Run and requires approval despite a standing allow rule', async () => {
      w.rules.create({
        botId: null,
        toolPattern: 'mcp__gmail__send_email',
        effect: 'allow',
        createdBy: 'owner',
      });
      const run = await w.orchestrator().run(w.bot({ fixture: 'web-then-send' }));
      expect(run.status).toBe('waiting_approval');
      expect(run.taintSources).toEqual(['WebFetch']);
      const [approval] = w.approvals.list({ status: 'pending' });
      expect(approval!.card.untrusted).toEqual(['WebFetch']);
      expect(approval!.card.risk).toMatch(/Untrusted content/);
      expect(approval!.input.to).toBe('attacker@evil.example');
    });

    it('the same rule auto-allows when no untrusted content is involved', async () => {
      w.rules.create({
        botId: null,
        toolPattern: 'mcp__gmail__send_email',
        effect: 'allow',
        createdBy: 'owner',
      });
      const run = await w.orchestrator().run(w.bot({ fixture: 'send-email' }));
      expect(run.status).toBe('completed');
    });
  });

  describe('budgets', () => {
    it('stops a Run that exceeds its tool-call budget', async () => {
      const run = await w
        .orchestrator()
        .run(w.bot({ fixture: 'many-reads', budgets: { maxToolCallsPerRun: 2 } }));
      expect(run.status).toBe('failed');
      expect(run.error?.code).toBe('budget_exceeded');
      expect(run.budgetExceeded).toBe('toolCalls');
      expect(run.counts.toolCalls).toBeLessThanOrEqual(3);
    });

    it('stops a Run that exceeds its token budget', async () => {
      const run = await w
        .orchestrator()
        .run(w.bot({ fixture: 'many-reads', budgets: { maxTokensPerRun: 200 } }));
      expect(run.error?.code).toBe('budget_exceeded');
      expect(run.budgetExceeded).toBe('tokens');
    });

    it('stops a Run that exceeds its wall-clock budget', async () => {
      const run = await w
        .orchestrator(new MockDriver({ delayMs: 200 }))
        .run(w.bot({ fixture: 'many-reads', budgets: { maxWallClockMinutes: 0.005 } }));
      expect(run.budgetExceeded).toBe('wallClock');
      expect(run.status).toBe('failed');
    });

    it('refuses new Runs beyond the daily run budget (recorded, not silent)', async () => {
      const o = w.orchestrator();
      const bot = w.bot({ fixture: 'pong', budgets: { maxRunsPerDay: 1 } });
      expect((await o.run(bot)).status).toBe('completed');
      const second = await o.run(bot);
      expect(second.status).toBe('failed');
      expect(second.budgetExceeded).toBe('runsPerDay');
      expect(types(w.store.listRunEvents(second.runId))).not.toContain('run.started');
    });

    it('a resume cannot reset per-Run budgets (tokens accumulate across segments)', async () => {
      const o = w.orchestrator();
      const bot = w.bot({ fixture: 'usage-limit', budgets: { maxTokensPerRun: 50 } });
      const limited = await o.run(bot);
      expect(limited.status).toBe('rate_limited');
      expect(limited.totals.tokens).toBe(70);
      const resumed = await o.resume(limited.runId);
      expect(resumed.status).toBe('failed');
      expect(resumed.budgetExceeded).toBe('tokens');
      expect(types(w.store.listRunEvents(limited.runId))).not.toContain('run.resumed');
    });

    it('enforces the per-Run cost budget from usage events', async () => {
      const run = await w
        .orchestrator()
        .run(w.bot({ fixture: 'pong', budgets: { maxCostUsdPerRun: 0.001 } }));
      expect(run.status).toBe('failed');
      expect(run.budgetExceeded).toBe('costPerRun');
    });

    it('refuses new Runs beyond the daily cost budget', async () => {
      const o = w.orchestrator();
      const bot = w.bot({ fixture: 'pong', budgets: { maxCostUsdPerDay: 0.001 } });
      await o.run(bot); // the recorded pong run cost ~$0.014
      expect((await o.run(bot)).budgetExceeded).toBe('costPerDay');
    });
  });

  describe('kill switches', () => {
    it('global: refuses to start while engaged', async () => {
      const o = w.orchestrator();
      o.killAll('owner');
      await expect(o.run(w.bot({ fixture: 'pong' }))).rejects.toMatchObject({ code: 'blocked' });
      o.killAll('owner', false);
      expect((await o.run(w.bot({ fixture: 'pong' }))).status).toBe('completed');
    });

    it('global: stops running Runs', async () => {
      const o = w.orchestrator(new MockDriver({ delayMs: 50 }));
      const run = await o.run(w.bot({ fixture: 'many-reads' }), {
        onEvent: (e) => {
          if (e.type === 'session.init') o.killAll('owner');
        },
      });
      expect(run.status).toBe('cancelled');
      expect(run.killedBy).toBe('global');
      expect(w.audit.list({ action: 'killswitch.global' })).toHaveLength(1);
    });

    it('bot: pausing stops its Runs and blocks new ones', async () => {
      const o = w.orchestrator(new MockDriver({ delayMs: 50 }));
      const bot = w.bot({ fixture: 'many-reads' });
      const run = await o.run(bot, {
        onEvent: (e) => {
          if (e.type === 'session.init') o.pauseBot(bot.id, 'owner');
        },
      });
      expect(run.killedBy).toBe('bot');
      await expect(o.run(bot)).rejects.toMatchObject({ code: 'blocked' });
      o.resumeBot(bot.id, 'owner');
      expect(w.bots.get(bot.id).pausedAt).toBeNull();
    });

    it('run: a stop requested from another process reaches the Run', async () => {
      const o = w.orchestrator(new MockDriver({ delayMs: 50 }));
      const otherProcess = new Controls(w.db);
      const run = await o.run(w.bot({ fixture: 'many-reads' }), {
        onEvent: (e) => {
          if (e.type === 'session.init') otherProcess.requestStop(e.runId, 'owner@other-terminal');
        },
      });
      expect(run.status).toBe('cancelled');
      expect(run.killedBy).toBe('run');
      expect(w.controls.stopRequested(run.runId)).toBeNull();
    });

    it('run: stopping a parked Run cancels its pending approvals', async () => {
      const o = w.orchestrator();
      const parked = await o.run(w.bot({ fixture: 'send-email' }));
      o.stop(parked.runId, 'owner');
      expect(w.store.getRun(parked.runId)?.status).toBe('cancelled');
      expect(w.approvals.list({ status: 'pending' })).toEqual([]);
      expect(w.approvals.list({ status: 'cancelled' })).toHaveLength(1);
    });
  });

  it('redacts secrets from tool output before the model sees it', async () => {
    const run = await w.orchestrator().run(w.bot({ fixture: 'read-then-write-denied' }));
    const result = w.store.listRunEvents(run.runId).find((e) => e.type === 'tool.result');
    expect(result?.type === 'tool.result' && result.data.content).toContain('[REDACTED:secret]');
    expect(result?.type === 'tool.result' && result.data.content).not.toContain(
      'launch window opens',
    );
  });

  it('turns a driver that throws into a failed Run', async () => {
    const broken: AgentDriver = {
      kind: 'mock',
      authMethod: 'mock',
      // eslint-disable-next-line require-yield
      async *run() {
        throw new Error('kaboom');
      },
    };
    const run = await w.orchestrator(broken).run(w.bot({ fixture: 'pong' }));
    expect(run.status).toBe('failed');
    expect(run.error?.message).toBe('kaboom');
  });
});

describe('Orchestrator — queueing, compare-and-set and M3 scoping', () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });
  afterEach(() => {
    w.db.close();
    rmSync(w.home, { recursive: true, force: true });
  });

  it('enqueue records a queued Run with priority and fixture; execute runs it once', async () => {
    const o = w.orchestrator();
    const bot = w.bot({ fixture: 'pong', priority: 2 });
    const manual = o.enqueue(bot, { mockFixture: 'read-then-write-denied' });
    expect(manual).toMatchObject({ status: 'queued', priority: 12, prompt: 'Do the task' });
    const cron = o.enqueue(bot, { trigger: { kind: 'cron', source: 'daily' }, prompt: 'check' });
    expect(cron).toMatchObject({ priority: 2, prompt: 'check' });
    const done = await o.execute(manual.runId);
    expect(done.status).toBe('completed');
    // The fixture chosen at enqueue time was used.
    expect(types(w.store.listRunEvents(manual.runId))).toContain('permission.decision');
    await expect(o.execute(manual.runId)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a queued Run can be cancelled; a cancelled Run cannot execute', async () => {
    const o = w.orchestrator();
    const q = o.enqueue(w.bot({ fixture: 'pong' }));
    o.stop(q.runId, 'owner');
    expect(w.store.getRun(q.runId)?.status).toBe('cancelled');
    await expect(o.execute(q.runId)).rejects.toMatchObject({ code: 'conflict' });
    const q2 = o.enqueue(w.bot({ fixture: 'pong' }));
    expect(o.cancelQueued(q2.runId, 'owner').status).toBe('cancelled');
  });

  it('two concurrent resumes of a parked Run: exactly one wins (compare-and-set)', async () => {
    const o1 = w.orchestrator();
    const o2 = w.orchestrator();
    const parked = await o1.run(w.bot({ fixture: 'send-email' }));
    const [approval] = w.approvals.list({ status: 'pending' });
    w.approvals.decide(approval!.id, { approve: true, by: 'owner' });
    const results = await Promise.allSettled([o1.resume(parked.runId), o2.resume(parked.runId)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: 'conflict' });
    const events = types(w.store.listRunEvents(parked.runId));
    expect(events.filter((t) => t === 'run.resumed')).toHaveLength(1);
    expect(w.store.getRun(parked.runId)?.status).toBe('completed');
  });

  it('a stop racing a resume: the stop wins once the Run is cancelled; resume conflicts', async () => {
    const o = w.orchestrator();
    const parked = await o.run(w.bot({ fixture: 'send-email' }));
    const [approval] = w.approvals.list({ status: 'pending' });
    w.approvals.decide(approval!.id, { approve: true, by: 'owner' });
    o.stop(parked.runId, 'owner');
    await expect(o.resume(parked.runId)).rejects.toThrow(/only parked, paused or rate-limited/);
    expect(w.store.getRun(parked.runId)?.status).toBe('cancelled');
  });

  it('sets approval expiry from the Bot and tells the Bot about expired approvals', async () => {
    const o = w.orchestrator();
    const bot = w.bot({
      fixture: 'send-email',
      approvals: { parkWindowSeconds: 0, expireAfterHours: 2 },
    });
    const parked = await o.run(bot);
    const [approval] = w.approvals.list({ status: 'pending' });
    const ttl = Date.parse(approval!.expiresAt!) - Date.parse(approval!.createdAt);
    expect(Math.abs(ttl - 2 * 3_600_000)).toBeLessThan(5_000);
    // Force expiry: rewrite expires_at into the past, then sweep.
    w.db.sqlite.prepare('UPDATE approvals SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    expect(w.approvals.expireDue().map((a) => a.id)).toEqual([approval!.id]);
    expect(w.store.getRun(parked.runId)?.pendingApprovals).toEqual([]);
    let prompt = '';
    const spy: AgentDriver = {
      kind: 'mock',
      authMethod: 'mock',
      run: (req) => {
        prompt = req.prompt;
        return new MockDriver().run({ ...req, mockFixture: 'pong' });
      },
    };
    await w.orchestrator(spy).resume(parked.runId);
    expect(prompt).toMatch(/NOT APPROVED \(no decision in time\)/);
  });

  it('grants are scoped to the next segment: unused ones are revoked when it ends', async () => {
    const o = w.orchestrator();
    const parked = await o.run(w.bot({ fixture: 'send-email' }));
    const [approval] = w.approvals.list({ status: 'pending' });
    w.approvals.decide(approval!.id, { approve: true, by: 'owner' });
    // The next segment does not retry the approved call…
    await o.resume(parked.runId, { mockFixture: 'pong' });
    // …so the grant is gone: a later segment cannot replay the approval.
    expect(
      w.approvals.consumeGrant(parked.runId, approval!.botId, approval!.toolName, approval!.input),
    ).toBeNull();
    const revoked = w.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM grants WHERE revoked_at IS NOT NULL')
      .get() as { n: number };
    expect(revoked.n).toBeGreaterThan(0);
  });

  it('stops the Run when a failed tool error contains a secret (fail closed)', async () => {
    const run = await w.orchestrator().run(w.bot({ fixture: 'tool-error-secret' }));
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('secret_exposure_blocked');
    const events = w.store.listRunEvents(run.runId);
    // The assistant turn after the failure never happened.
    expect(events.some((e) => e.type === 'message.assistant')).toBe(false);
    // (This test world's EventStore has its own redactor; orbitd shares one.)
    expect(w.audit.list({ action: 'run.secret_exposure_blocked' })).toHaveLength(1);
  });

  it('a workspace that cannot be prepared fails the Run (start and resume), never leaves it running', async () => {
    let failing = false;
    const o = new Orchestrator({
      config: OrbitConfig.parse({ home: w.home }),
      store: w.store,
      bots: w.bots,
      controls: w.controls,
      approvals: w.approvals,
      policy: new PolicyEngine(w.approvals, w.rules),
      driver: new MockDriver(),
      redactor: w.redactor,
      workspaces: (bot) =>
        failing
          ? Promise.reject(new Error('git worktree add failed'))
          : Promise.resolve({
              path: join(w.home, bot.id),
              shellContained: false,
              engineSandbox: null,
            }),
    });
    const parked = await o.run(w.bot({ fixture: 'send-email' }));
    failing = true;
    const started = await o.run(w.bot({ fixture: 'pong' }));
    expect(started).toMatchObject({
      status: 'failed',
      error: { code: 'workspace_unavailable', retryable: true },
    });
    const [approval] = w.approvals.list({ status: 'pending' });
    w.approvals.decide(approval!.id, { approve: true, by: 'owner' });
    const resumed = await o.resume(parked.runId);
    expect(resumed.status).toBe('failed');
    expect(resumed.error?.message).toMatch(/git worktree add failed/);
    expect(o.activeRuns()).toEqual([]);
  });

  it('a kill switch engaged while the workspace is prepared stops the Run before the engine starts', async () => {
    let started = false;
    const spy: AgentDriver = {
      kind: 'mock',
      authMethod: 'mock',
      run: (req) => {
        started = true;
        return new MockDriver().run(req);
      },
    };
    const o = new Orchestrator({
      config: OrbitConfig.parse({ home: w.home }),
      store: w.store,
      bots: w.bots,
      controls: w.controls,
      approvals: w.approvals,
      policy: new PolicyEngine(w.approvals, w.rules),
      driver: spy,
      redactor: w.redactor,
      workspaces: (bot) => {
        w.controls.setGlobalKill(true, 'owner'); // engaged mid-preparation
        return Promise.resolve({
          path: join(w.home, bot.id),
          shellContained: false,
          engineSandbox: null,
        });
      },
    });
    const run = await o.run(w.bot({ fixture: 'pong' }));
    expect(run.status).toBe('cancelled');
    expect(run.killedBy).toBe('global');
    expect(started).toBe(false);
  });

  it('shutdown aborts executing Runs as retryable interruptions (onInterrupt: fail)', async () => {
    const w2 = world(':memory:', { delayMs: 50 });
    try {
      const o = w2.orchestrator();
      const pending = o.run(w2.bot({ fixture: 'many-reads', onInterrupt: 'fail' }));
      await new Promise((r) => setTimeout(r, 30));
      expect(o.activeRuns()).toHaveLength(1);
      o.shutdown();
      const run = await pending;
      expect(run.status).toBe('failed');
      expect(run.error).toMatchObject({ code: 'interrupted', retryable: true });
      await o.drain(1000);
      expect(o.activeRuns()).toEqual([]);
    } finally {
      w2.db.close();
      rmSync(w2.home, { recursive: true, force: true });
    }
  });
});

describe('Orchestrator across processes', () => {
  it('a decision made by another process (another connection) is seen by a waiting Run', async () => {
    const w = world('orbit.db');
    try {
      const bot = w.bot({ fixture: 'send-email', approvals: { parkWindowSeconds: 5 } });
      const other = new ApprovalQueue(openDatabase(join(w.home, 'orbit.db')));
      const run = await w.orchestrator().run(bot, {
        onEvent: (e) => {
          if (e.type === 'approval.requested')
            setTimeout(() => other.decide(e.data.approvalId, { approve: true, by: 'owner' }), 50);
        },
      });
      expect(run.status).toBe('completed');
    } finally {
      w.db.close();
      rmSync(w.home, { recursive: true, force: true });
    }
  });
});

describe('Orchestrator — per-Run pause and interruptions (ADR-016)', () => {
  let w: World;
  beforeEach(() => {
    w = world(':memory:', { delayMs: 30 });
  });
  afterEach(() => {
    w.db.close();
    rmSync(w.home, { recursive: true, force: true });
  });

  /** A MockDriver that records the prompt of each segment. */
  const spying = (prompts: string[], fixture?: string): AgentDriver => ({
    kind: 'mock',
    authMethod: 'mock',
    run: (req) => {
      prompts.push(req.prompt);
      return new MockDriver().run(fixture ? { ...req, mockFixture: fixture } : req);
    },
  });

  it('pauses at the next tool-call decision: that call is denied, the engine stops, the slot is free', async () => {
    const o = w.orchestrator();
    const run = await o.run(w.bot({ fixture: 'many-reads' }), {
      onEvent: (e) => {
        if (e.type === 'session.init') queueMicrotask(() => o.pause(e.runId, 'owner'));
      },
    });
    expect(run.status).toBe('paused');
    expect(run.endedAt).toBeNull();
    expect(run.pause).toMatchObject({
      reason: 'owner',
      by: 'owner',
      interruptedTurn: false,
      toolName: 'Read',
      toolUseId: 'toolu_rd_0',
    });
    expect(o.activeRuns()).toEqual([]);
    const events = w.store.listRunEvents(run.runId);
    expect(types(events)).toEqual(
      expect.arrayContaining(['run.pause_requested', 'permission.decision', 'run.paused']),
    );
    const decision = events.find((e) => e.type === 'permission.decision');
    expect(decision?.type === 'permission.decision' && decision.data).toMatchObject({
      behavior: 'deny',
      toolUseId: 'toolu_rd_0',
    });
    // Nothing of the paused call ran: no successful result for it.
    expect(
      events.some(
        (e) => e.type === 'tool.result' && e.data.toolUseId === 'toolu_rd_0' && !e.data.isError,
      ),
    ).toBe(false);
    expect(types(events).at(-1)).toBe('run.paused');
    expect(w.audit.list({ action: 'run.pause_requested' })).toHaveLength(1);
    expect(replayRun(events)).toEqual(w.store.getRun(run.runId));
  });

  it('resumes through the resume path, telling the Bot who paused it and which call did not run', async () => {
    const o = w.orchestrator();
    const paused = await o.run(w.bot({ fixture: 'many-reads' }), {
      onEvent: (e) => {
        if (e.type === 'session.init') queueMicrotask(() => o.pause(e.runId, 'owner'));
      },
    });
    const prompts: string[] = [];
    const done = await w.orchestrator(spying(prompts)).resume(paused.runId);
    expect(done.status).toBe('completed');
    expect(prompts[0]).toMatch(/Your owner \(owner\) paused this run before your call to Read/);
    expect(prompts[0]).toMatch(/did not run/);
    const resumed = w.store.listRunEvents(paused.runId).find((e) => e.type === 'run.resumed');
    expect(resumed?.type === 'run.resumed' && resumed.data.reason).toBe('pause');
  });

  it('a request that meets no tool call lapses: the Run finishes and the timeline says so', async () => {
    const o = w.orchestrator();
    const run = await o.run(w.bot({ fixture: 'pong' }), {
      onEvent: (e) => {
        if (e.type === 'session.init') queueMicrotask(() => o.pause(e.runId, 'owner'));
      },
    });
    expect(run.status).toBe('completed');
    expect(run.pauseRequested).toBeNull();
    const t = types(w.store.listRunEvents(run.runId));
    expect(t.slice(-2)).toEqual(['run.pause_lapsed', 'run.completed']);
  });

  it('now: interrupts the engine at once and ends paused (not cancelled), counting the active time', async () => {
    const o = w.orchestrator();
    const run = await o.run(w.bot({ fixture: 'many-reads' }), {
      onEvent: (e) => {
        if (e.type === 'tool.result')
          queueMicrotask(() => o.pause(e.runId, 'owner', { now: true }));
      },
    });
    expect(run.status).toBe('paused');
    expect(run.killedBy).toBeNull();
    expect(run.pause).toMatchObject({ reason: 'owner', interruptedTurn: true, toolName: null });
    const paused = w.store.listRunEvents(run.runId).find((e) => e.type === 'run.paused');
    expect(paused?.type === 'run.paused' && paused.data.activeMs).toBeGreaterThan(0);
    expect(run.totals.activeMs).toBeGreaterThan(0);
    const prompts: string[] = [];
    await w.orchestrator(spying(prompts, 'pong')).resume(run.runId);
    expect(prompts[0]).toMatch(/interrupting your last turn/);
    expect(prompts[0]).toMatch(/may or may not have happened/);
  });

  it('a second request is idempotent; now upgrades an open one', async () => {
    const o = w.orchestrator(new MockDriver({ delayMs: 60 }));
    let first: RunState | undefined;
    let again: RunState | undefined;
    const run = await o.run(w.bot({ fixture: 'pong' }), {
      onEvent: (e) => {
        if (e.type === 'session.init')
          queueMicrotask(() => {
            first = o.pause(e.runId, 'owner');
            again = o.pause(e.runId, 'owner');
            o.pause(e.runId, 'owner', { now: true });
          });
      },
    });
    expect(first?.pauseRequested).toMatchObject({ now: false });
    expect(again?.lastSeq).toBe(first?.lastSeq);
    expect(run.status).toBe('paused');
    const requests = w.store
      .listRunEvents(run.runId)
      .flatMap((e) => (e.type === 'run.pause_requested' ? [e.data.now] : []));
    expect(requests).toEqual([false, true]);
  });

  it('refuses to pause a queued, parked, paused or ended Run, with a hint', async () => {
    const o = w.orchestrator(new MockDriver());
    const queued = o.enqueue(w.bot({ fixture: 'pong' }));
    expect(() => o.pause(queued.runId, 'owner')).toThrow(/queued, not running/);
    try {
      o.pause(queued.runId, 'owner');
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/orbit stop .*orbit bot pause/);
    }
    const parked = await o.run(w.bot({ fixture: 'send-email' }));
    expect(parked.status).toBe('waiting_approval');
    expect(() => o.pause(parked.runId, 'owner')).toThrow(/only a running Run can be paused/);
    const done = await o.run(w.bot({ fixture: 'pong' }));
    expect(() => o.pause(done.runId, 'owner')).toThrow(/completed/);
  });

  it('stop closes a paused Run; nothing resumes it by itself', async () => {
    const o = w.orchestrator();
    const run = await o.run(w.bot({ fixture: 'many-reads' }), {
      onEvent: (e) => {
        if (e.type === 'session.init') queueMicrotask(() => o.pause(e.runId, 'owner'));
      },
    });
    expect(() => o.pause(run.runId, 'owner')).toThrow(/already paused/);
    o.stop(run.runId, 'owner');
    expect(w.store.getRun(run.runId)).toMatchObject({ status: 'cancelled', killedBy: 'run' });
  });

  it('a pause keeps pending approvals pending; resuming waits for them', async () => {
    const bot = w.bot({ fixture: 'send-email', approvals: { parkWindowSeconds: 5 } });
    const o = w.orchestrator();
    const run = await o.run(bot, {
      onEvent: (e) => {
        if (e.type === 'approval.requested')
          queueMicrotask(() => o.pause(e.runId, 'owner', { now: true }));
      },
    });
    expect(run.status).toBe('paused');
    expect(run.pendingApprovals).toHaveLength(1);
    await expect(o.resume(run.runId)).rejects.toThrow(/still waits on/);
  });

  it('wall clock: paused time is not active time (like a park); only engine time counts', async () => {
    const o = w.orchestrator();
    const bot = w.bot({ fixture: 'many-reads', budgets: { maxWallClockMinutes: 0.01 } });
    const run = await o.run(bot, {
      onEvent: (e) => {
        if (e.type === 'session.init') queueMicrotask(() => o.pause(e.runId, 'owner'));
      },
    });
    expect(run.status).toBe('paused');
    // Longer than the whole budget (600 ms) passes while paused.
    await new Promise((r) => setTimeout(r, 700));
    const done = await w.orchestrator(new MockDriver()).resume(run.runId);
    expect(done.status).toBe('completed');
    expect(done.budgetExceeded).toBeNull();
  });

  it('wall clock: time a `now` pause cut off counts against the budget on resume', async () => {
    const o = w.orchestrator(new MockDriver({ delayMs: 100 }));
    const bot = w.bot({ fixture: 'many-reads', budgets: { maxWallClockMinutes: 0.01 } });
    const run = await o.run(bot, {
      onEvent: (e) => {
        if (e.type === 'tool.result')
          queueMicrotask(() => o.pause(e.runId, 'owner', { now: true }));
      },
    });
    expect(run.status).toBe('paused');
    expect(run.totals.activeMs).toBeGreaterThanOrEqual(150);
    // ~490 ms of engine time fits the 600 ms budget only if the cut-off time were forgotten.
    const resumed = await w
      .orchestrator(new MockDriver({ delayMs: 70 }))
      .resume(run.runId, { mockFixture: 'pong' });
    expect(resumed.status).toBe('failed');
    expect(resumed.budgetExceeded).toBe('wallClock');
  });

  describe('interruptions (orbitd stopped under a Run)', () => {
    it('shutdown pauses a Run that is safe to retry (reads only, session known)', async () => {
      const o = w.orchestrator();
      const pending = o.run(w.bot({ fixture: 'many-reads' }));
      await new Promise((r) => setTimeout(r, 80));
      o.shutdown();
      const run = await pending;
      expect(run.status).toBe('paused');
      expect(run.pause).toMatchObject({
        reason: 'interrupted',
        by: 'system',
        autoResume: true,
        interruptedTurn: true,
      });
      expect(run.interruptions).toBe(1);
      expect(w.audit.list({ action: 'run.interrupted' })).toHaveLength(1);
      const prompts: string[] = [];
      const done = await w.orchestrator(spying(prompts, 'pong')).resume(run.runId);
      expect(done.status).toBe('completed');
      expect(prompts[0]).toMatch(/stopped while you were working/);
      expect(prompts[0]).toMatch(/verify its effect/);
      const resumed = w.store.listRunEvents(run.runId).find((e) => e.type === 'run.resumed');
      expect(resumed?.type === 'run.resumed' && resumed.data.reason).toBe('interrupted');
    });

    it('onInterrupt: fail keeps the old outcome (run.failed: interrupted, retryable)', async () => {
      const o = w.orchestrator();
      const pending = o.run(w.bot({ fixture: 'many-reads', onInterrupt: 'fail' }));
      await new Promise((r) => setTimeout(r, 80));
      o.shutdown();
      const run = await pending;
      expect(run.status).toBe('failed');
      expect(run.error).toMatchObject({ code: 'interrupted', retryable: true });
    });

    it('an allowed EXTERNAL call without a result is unsafe: paused for the owner, naming the call', async () => {
      const bot = w.bot({ fixture: 'send-email' });
      w.rules.create(
        {
          botId: bot.id,
          toolPattern: 'mcp__gmail__send_email',
          inputMatch: null,
          effect: 'allow',
          reason: null,
          createdBy: 'owner',
          expiresAt: null,
        },
        'EXTERNAL',
      );
      const o = w.orchestrator(new MockDriver({ delayMs: 60 }));
      const run = await o.run(bot, {
        onEvent: (e) => {
          if (e.type === 'permission.decision' && e.data.behavior === 'allow') o.shutdown();
        },
      });
      expect(run.status).toBe('paused');
      expect(run.pause).toMatchObject({
        reason: 'interrupted',
        autoResume: false,
        toolName: 'mcp__gmail__send_email',
        toolUseId: 'toolu_send_1',
      });
      expect(run.pause?.detail).toMatch(/may or may not have happened/);
      const prompts: string[] = [];
      await w.orchestrator(spying(prompts, 'pong')).resume(run.runId);
      expect(prompts[0]).toMatch(/mcp__gmail__send_email \(toolu_send_1\) was allowed/);
    });

    it('unknown session or too many retries: paused for the owner', () => {
      const o = w.orchestrator();
      const bot = w.bot({ fixture: 'pong' });
      const run = o.enqueue(bot);
      const started = event('run.started', {
        driver: 'mock',
        authMethod: 'mock',
        model: null,
        cwd: w.home,
        resumeSessionId: null,
      });
      w.store.append(run.runId, bot.id, [started]);
      const [noSession] = o.interruption(run.runId, { allowResume: true });
      expect(noSession?.type === 'run.paused' && noSession.data.autoResume).toBe(false);
      expect(noSession?.type === 'run.paused' && noSession.data.detail).toMatch(
        /engine session is unknown/,
      );
      // Two earlier interruptions: the third waits for the owner.
      const init = event('session.init', {
        sessionId: 's1',
        model: null,
        tools: [],
        engineVersion: null,
        permissionMode: null,
        apiKeySource: null,
      });
      for (let i = 0; i < 2; i++) {
        w.store.append(run.runId, bot.id, [
          init,
          ...o.interruption(run.runId, { allowResume: true }),
          event('run.resumed', { reason: 'interrupted', sessionId: 's1' }),
          started,
        ]);
      }
      expect(w.store.getRun(run.runId)?.interruptions).toBe(2);
      const [third] = o.interruption(run.runId, { allowResume: true });
      expect(third?.type === 'run.paused' && third.data.autoResume).toBe(false);
      expect(third?.type === 'run.paused' && third.data.detail).toMatch(/retries at most 2 times/);
      // A kill switch (allowResume false) keeps today's outcome.
      const [killed] = o.interruption(run.runId, { allowResume: false });
      expect(killed?.type).toBe('run.failed');
    });
  });
});
