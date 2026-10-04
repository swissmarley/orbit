import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BotSpecInput, OrbitConfig, Redactor, type RunEvent, replayRun } from '@orbit/core';
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
