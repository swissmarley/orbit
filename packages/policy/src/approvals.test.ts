import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunEventBody, type Tier, OrbitError, inputHash } from '@orbit/core';
import { type OrbitDb, openDatabase } from '@orbit/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Approval, type AuditSink, type EventSink, ApprovalQueue } from './approvals';
import type { ApprovalCard } from './card';

const T0 = '2026-10-04T12:00:00.000Z';

function clock(start: string) {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function card(toolName: string, tier: Tier, what = `do ${toolName}`): ApprovalCard {
  return {
    what,
    why: 'because',
    toolName,
    tier,
    payload: {},
    diff: null,
    botId: 'bot_1',
    botName: 'Inbox Triage',
    runId: 'run_1',
    untrusted: [],
    risk: 'r',
  };
}

const SEND = 'mcp__gmail__send_email';
const ORIGINAL = { to: 'ada@example.com', subject: 'Hi', body: 'draft v1' };
const EDITED = { to: 'ada@example.com', subject: 'Hi', body: 'edited by owner' };

function spies() {
  const audit = { append: vi.fn<AuditSink['append']>() };
  const events = { append: vi.fn<EventSink['append']>() };
  return { audit, events };
}

/** Event bodies passed to the EventSink spy, flattened with their run/bot. */
function emitted(events: { append: ReturnType<typeof vi.fn<EventSink['append']>> }) {
  return events.append.mock.calls.flatMap(([runId, botId, bodies]) =>
    bodies.map((b: RunEventBody) => ({ runId, botId, ...b })),
  );
}

describe('ApprovalQueue', () => {
  let db: OrbitDb;
  let c: ReturnType<typeof clock>;
  let s: ReturnType<typeof spies>;
  let q: ApprovalQueue;

  const request = (over: Partial<Parameters<ApprovalQueue['create']>[0]> = {}): Approval =>
    q.create({
      runId: 'run_1',
      botId: 'bot_1',
      toolUseId: 'tu_1',
      toolName: SEND,
      input: ORIGINAL,
      tier: 'EXTERNAL',
      card: card(SEND, 'EXTERNAL', 'send email → ada@example.com'),
      ...over,
    });

  beforeEach(() => {
    db = openDatabase(':memory:');
    c = clock(T0);
    s = spies();
    q = new ApprovalQueue(db, s, c.now);
  });
  afterEach(() => db.close());

  describe('create', () => {
    it('persists a pending approval bound to the canonical input hash', () => {
      const a = request();
      expect(a.id).toMatch(/^apr_/);
      expect(a).toMatchObject({
        runId: 'run_1',
        botId: 'bot_1',
        toolUseId: 'tu_1',
        toolName: SEND,
        input: ORIGINAL,
        inputHash: inputHash(ORIGINAL),
        tier: 'EXTERNAL',
        status: 'pending',
        decision: null,
        createdAt: T0,
        decidedAt: null,
        expiresAt: null,
      });
      expect(q.get(a.id)).toEqual(a);
      expect(q.require(a.id)).toEqual(a);
    });

    it('emits approval.requested to the EventSink and audits approval.requested', () => {
      const a = request();
      expect(emitted(s.events)).toEqual([
        {
          runId: 'run_1',
          botId: 'bot_1',
          type: 'approval.requested',
          data: {
            approvalId: a.id,
            toolUseId: 'tu_1',
            toolName: SEND,
            tier: 'EXTERNAL',
            summary: 'send email → ada@example.com',
          },
        },
      ]);
      expect(s.audit.append).toHaveBeenCalledTimes(1);
      expect(s.audit.append).toHaveBeenCalledWith({
        actor: 'bot:bot_1',
        action: 'approval.requested',
        subject: a.id,
        data: {
          runId: 'run_1',
          toolName: SEND,
          tier: 'EXTERNAL',
          what: 'send email → ada@example.com',
          inputHash: a.inputHash,
        },
      });
    });

    it('refuses FINANCIAL actions: nothing persisted, emitted or audited', () => {
      expect(() =>
        request({
          toolName: 'mcp__stripe__pay_invoice',
          tier: 'FINANCIAL',
          card: card('mcp__stripe__pay_invoice', 'FINANCIAL'),
        }),
      ).toThrow(OrbitError);
      expect(q.list()).toEqual([]);
      expect(s.events.append).not.toHaveBeenCalled();
      expect(s.audit.append).not.toHaveBeenCalled();
    });

    it('works without sinks', () => {
      const bare = new ApprovalQueue(db);
      expect(
        bare.create({
          runId: 'r',
          botId: 'b',
          toolUseId: null,
          toolName: SEND,
          input: {},
          tier: 'EXTERNAL',
          card: card(SEND, 'EXTERNAL'),
        }).status,
      ).toBe('pending');
    });

    it('get → undefined and require → not_found for unknown ids', () => {
      expect(q.get('apr_missing')).toBeUndefined();
      expect(() => q.require('apr_missing')).toThrow(/not found/);
    });
  });

  describe('list', () => {
    it('filters by status, bot and run, oldest first', () => {
      const a1 = request();
      c.advance(1);
      const a2 = request({ runId: 'run_2' });
      c.advance(1);
      const a3 = request({ botId: 'bot_2', runId: 'run_3' });
      q.decide(a2.id, { approve: false, by: 'user:owner' });
      expect(q.list().map((a) => a.id)).toEqual([a1.id, a2.id, a3.id]);
      expect(q.list({ status: 'pending' }).map((a) => a.id)).toEqual([a1.id, a3.id]);
      expect(q.list({ status: 'denied' }).map((a) => a.id)).toEqual([a2.id]);
      expect(q.list({ botId: 'bot_2' }).map((a) => a.id)).toEqual([a3.id]);
      expect(q.list({ runId: 'run_1' }).map((a) => a.id)).toEqual([a1.id]);
      expect(q.list({ botId: 'bot_1', status: 'pending' }).map((a) => a.id)).toEqual([a1.id]);
    });
  });

  describe('decide', () => {
    it.each<[string, boolean, string | null, Approval['status']]>([
      ['owner approves', true, null, 'approved'],
      ['owner approves with a note', true, 'looks right', 'approved'],
      ['owner denies with a reason', false, 'wrong recipient', 'denied'],
      ['owner denies without a reason', false, null, 'denied'],
    ])('%s → %s, reason kept, event + audit', (_scenario, approve, reason, status) => {
      const a = request();
      c.advance(5000);
      s.events.append.mockClear();
      const d = q.decide(a.id, { approve, by: 'user:owner', reason });
      const expectedDecision = {
        decision: status,
        by: 'user:owner',
        reason,
        editedInput: null,
        ruleId: null,
      };
      expect(d).toMatchObject({
        status,
        decision: expectedDecision,
        decidedAt: '2026-10-04T12:00:05.000Z',
      });
      expect(q.get(a.id)).toEqual(d);
      expect(emitted(s.events)).toEqual([
        {
          runId: 'run_1',
          botId: 'bot_1',
          type: 'approval.decided',
          data: {
            approvalId: a.id,
            decision: status,
            by: 'user:owner',
            edited: false,
            reason,
            ruleId: null,
          },
        },
      ]);
      expect(s.audit.append).toHaveBeenLastCalledWith({
        actor: 'user:owner',
        action: 'approval.decided',
        subject: a.id,
        data: {
          runId: 'run_1',
          toolName: SEND,
          decision: status,
          edited: false,
          inputHash: a.inputHash,
          editedInputHash: null,
          reason,
          ruleId: null,
        },
      });
    });

    it('a denial creates no grant', () => {
      const a = request();
      q.decide(a.id, { approve: false, by: 'user:owner', reason: 'no' });
      expect(q.consumeGrant('run_1', 'bot_1', SEND, ORIGINAL)).toBeNull();
    });

    it.each<[string, boolean]>([
      ['approve after approve', true],
      ['deny after approve', false],
    ])('rejects a second decision (%s) and leaves the first intact', (_scenario, approve) => {
      const a = request();
      const first = q.decide(a.id, { approve: true, by: 'user:owner' });
      const auditCalls = s.audit.append.mock.calls.length;
      const eventCalls = s.events.append.mock.calls.length;
      expect(() => q.decide(a.id, { approve, by: 'user:other' })).toThrow(/already approved/);
      expect(q.get(a.id)).toEqual(first);
      expect(s.audit.append.mock.calls.length).toBe(auditCalls);
      expect(s.events.append.mock.calls.length).toBe(eventCalls);
    });

    it('rejects deciding an unknown approval', () => {
      expect(() => q.decide('apr_missing', { approve: true, by: 'u' })).toThrow(/not found/);
    });

    it('ignores editedInput on a denial', () => {
      const a = request();
      const d = q.decide(a.id, { approve: false, by: 'u', editedInput: EDITED });
      expect(d.decision?.editedInput).toBeNull();
    });
  });

  describe('one-shot grants', () => {
    it('plain approval: exactly this input, once, updatedInput null', () => {
      const a = request();
      q.decide(a.id, { approve: true, by: 'user:owner' });
      // Different input → no grant (and does not burn the real one).
      expect(
        q.consumeGrant('run_1', 'bot_1', SEND, { ...ORIGINAL, to: 'eve@evil.com' }),
      ).toBeNull();
      // Same input with keys in a different order is the same call.
      const reordered = { body: ORIGINAL.body, to: ORIGINAL.to, subject: ORIGINAL.subject };
      expect(q.consumeGrant('run_1', 'bot_1', SEND, reordered)).toEqual({
        id: expect.stringMatching(/^grt_/) as unknown,
        approvalId: a.id,
        updatedInput: null,
      });
      expect(q.consumeGrant('run_1', 'bot_1', SEND, ORIGINAL)).toBeNull();
    });

    it.each<
      [string, Record<string, unknown>, Record<string, unknown> | null, Record<string, unknown>]
    >([
      ['retry with ORIGINAL input runs the edited version', ORIGINAL, EDITED, EDITED],
      ['retry with EDITED input runs as-is', EDITED, null, ORIGINAL],
    ])(
      'edit-then-approve: %s; consuming it consumes the sibling too',
      (_scenario, first, expectedUpdated, second) => {
        const a = request();
        const d = q.decide(a.id, { approve: true, by: 'user:owner', editedInput: EDITED });
        expect(d.decision?.editedInput).toEqual(EDITED);
        expect(emitted(s.events).at(-1)).toMatchObject({
          type: 'approval.decided',
          data: { edited: true },
        });

        const g = q.consumeGrant('run_1', 'bot_1', SEND, first);
        expect(g).toMatchObject({ approvalId: a.id, updatedInput: expectedUpdated });
        expect(q.consumeGrant('run_1', 'bot_1', SEND, second)).toBeNull();
        expect(q.consumeGrant('run_1', 'bot_1', SEND, first)).toBeNull();
      },
    );

    it.each<[string, string, string, string]>([
      ['another Run of the same Bot', 'run_2', 'bot_1', SEND],
      ['another Bot claiming the same Run id', 'run_1', 'bot_2', SEND],
      ['another tool with identical input', 'run_1', 'bot_1', 'mcp__slack__post_message'],
    ])('grant is not usable by %s', (_scenario, runId, botId, toolName) => {
      const a = request();
      q.decide(a.id, { approve: true, by: 'user:owner' });
      expect(q.consumeGrant(runId, botId, toolName, ORIGINAL)).toBeNull();
      // Positive control: the rightful owner can still use it.
      expect(q.consumeGrant('run_1', 'bot_1', SEND, ORIGINAL)?.approvalId).toBe(a.id);
    });

    it('two approvals of the same call yield two independent single uses', () => {
      const a1 = request();
      const a2 = request();
      q.decide(a1.id, { approve: true, by: 'u' });
      q.decide(a2.id, { approve: true, by: 'u' });
      const ids = [
        q.consumeGrant('run_1', 'bot_1', SEND, ORIGINAL)?.approvalId,
        q.consumeGrant('run_1', 'bot_1', SEND, ORIGINAL)?.approvalId,
      ];
      expect(ids.sort()).toEqual([a1.id, a2.id].sort());
      expect(q.consumeGrant('run_1', 'bot_1', SEND, ORIGINAL)).toBeNull();
    });
  });

  describe('always allow', () => {
    it.each<[string, 'bot' | 'global', string | null, string | null]>([
      ['scoped to this Bot, expiring tomorrow', 'bot', '2026-10-05T12:00:00.000Z', 'bot_1'],
      ['global, never expiring', 'global', null, null],
    ])('creates an allow rule %s', (_scenario, scope, expiresAt, botId) => {
      const a = request();
      const d = q.decide(a.id, { approve: true, by: 'user:owner', always: { scope, expiresAt } });
      const ruleId = d.decision?.ruleId;
      expect(ruleId).toMatch(/^rul_/);
      const rule = q.ruleStore.list({ includeInactive: true }).find((r) => r.id === ruleId);
      expect(rule).toMatchObject({
        botId,
        toolPattern: SEND,
        inputMatch: null,
        effect: 'allow',
        createdBy: 'user:owner',
        expiresAt,
        reason: `Always allow from approval ${a.id}`,
      });
      expect(emitted(s.events).at(-1)).toMatchObject({
        type: 'approval.decided',
        data: { ruleId },
      });
      expect(s.audit.append).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ruleId }) as unknown }),
      );
      // Bot scope: visible to bot_1; to bot_2 only when global.
      expect(q.ruleStore.matching('bot_1', SEND, {}).map((r) => r.id)).toEqual([ruleId]);
      expect(q.ruleStore.matching('bot_2', SEND, {}).length).toBe(scope === 'global' ? 1 : 0);
      // The approval itself still yields its one-shot grant.
      expect(q.consumeGrant('run_1', 'bot_1', SEND, ORIGINAL)?.approvalId).toBe(a.id);
    });

    it('a denial with "always" creates no rule', () => {
      const a = request();
      const d = q.decide(a.id, {
        approve: false,
        by: 'user:owner',
        always: { scope: 'global', expiresAt: null },
      });
      expect(d.decision?.ruleId).toBeNull();
      expect(q.ruleStore.list({ includeInactive: true })).toEqual([]);
    });
  });

  describe('cancelForRun', () => {
    it('closes every pending approval of that Run only, with events and audit', () => {
      const p1 = request();
      const p2 = request({ toolUseId: 'tu_2' });
      const decided = request({ toolUseId: 'tu_3' });
      q.decide(decided.id, { approve: true, by: 'user:owner' });
      const otherRun = request({ runId: 'run_2' });
      s.events.append.mockClear();
      s.audit.append.mockClear();
      c.advance(1000);

      const closed = q.cancelForRun('run_1', 'system:kill');
      expect(closed.map((a) => a.id).sort()).toEqual([p1.id, p2.id].sort());
      for (const id of [p1.id, p2.id]) {
        expect(q.get(id)).toMatchObject({
          status: 'cancelled',
          decidedAt: '2026-10-04T12:00:01.000Z',
          decision: {
            decision: 'cancelled',
            by: 'system:kill',
            reason: null,
            editedInput: null,
            ruleId: null,
          },
        });
      }
      expect(q.get(decided.id)?.status).toBe('approved');
      expect(q.get(otherRun.id)?.status).toBe('pending');

      expect(s.events.append).toHaveBeenCalledTimes(1);
      expect(emitted(s.events)).toEqual(
        [p1.id, p2.id].map((approvalId) => ({
          runId: 'run_1',
          botId: 'bot_1',
          type: 'approval.decided',
          data: {
            approvalId,
            decision: 'cancelled',
            by: 'system:kill',
            edited: false,
            reason: null,
            ruleId: null,
          },
        })),
      );
      expect(s.audit.append.mock.calls.map(([e]) => [e.action, e.subject])).toEqual([
        ['approval.cancelled', p1.id],
        ['approval.cancelled', p2.id],
      ]);

      // A cancelled approval can no longer be decided.
      expect(() => q.decide(p1.id, { approve: true, by: 'user:owner' })).toThrow(
        /already cancelled/,
      );
      expect(q.consumeGrant('run_1', 'bot_1', SEND, ORIGINAL)).not.toBeNull(); // from `decided` only
      expect(q.consumeGrant('run_1', 'bot_1', SEND, ORIGINAL)).toBeNull();
    });

    it('can mark them expired instead', () => {
      const a = request();
      const [closed] = q.cancelForRun('run_1', 'system:timeout', 'expired');
      expect(closed?.status).toBe('expired');
      expect(q.get(a.id)?.status).toBe('expired');
      expect(emitted(s.events).at(-1)).toMatchObject({ data: { decision: 'expired' } });
      expect(s.audit.append).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'approval.expired' }),
      );
    });

    it('does nothing (no events) when the Run has nothing pending', () => {
      s.events.append.mockClear();
      expect(q.cancelForRun('run_none', 'system')).toEqual([]);
      expect(s.events.append).not.toHaveBeenCalled();
    });
  });

  describe('waitForDecision (in-process)', () => {
    it('returns immediately when already decided', async () => {
      const a = request();
      q.decide(a.id, { approve: false, by: 'u', reason: 'no' });
      await expect(q.waitForDecision(a.id, 10_000)).resolves.toMatchObject({ status: 'denied' });
    });

    it('returns null on timeout and leaves the approval pending (the Run parks)', async () => {
      const a = request();
      const started = Date.now();
      await expect(q.waitForDecision(a.id, 40, undefined, 5)).resolves.toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(35);
      expect(q.get(a.id)?.status).toBe('pending');
    });

    it('returns null when aborted mid-wait, well before the timeout', async () => {
      const a = request();
      const ac = new AbortController();
      const started = Date.now();
      setTimeout(() => ac.abort(), 20);
      await expect(q.waitForDecision(a.id, 10_000, ac.signal, 1_000)).resolves.toBeNull();
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('returns null for an already-aborted signal', async () => {
      const a = request();
      await expect(q.waitForDecision(a.id, 10_000, AbortSignal.abort())).resolves.toBeNull();
    });

    it('rejects for an unknown approval', async () => {
      await expect(q.waitForDecision('apr_missing', 10)).rejects.toThrow(/not found/);
    });
  });
});

describe('ApprovalQueue across processes (file-backed db, two connections)', () => {
  let dir: string;
  let dbA: OrbitDb;
  let dbB: OrbitDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-approvals-'));
    const path = join(dir, 'orbit.db');
    dbA = openDatabase(path);
    dbB = openDatabase(path);
  });
  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a Run waiting in one process sees a decision made in another, and can use the grant', async () => {
    const runner = new ApprovalQueue(dbA);
    const api = new ApprovalQueue(dbB);
    const a = runner.create({
      runId: 'run_1',
      botId: 'bot_1',
      toolUseId: 'tu_1',
      toolName: SEND,
      input: ORIGINAL,
      tier: 'EXTERNAL',
      card: card(SEND, 'EXTERNAL'),
    });
    // The other connection sees the pending request.
    expect(api.list({ status: 'pending' }).map((x) => x.id)).toEqual([a.id]);

    const waiting = runner.waitForDecision(a.id, 5_000, undefined, 10);
    setTimeout(() => {
      api.decide(a.id, { approve: true, by: 'user:owner', editedInput: EDITED });
    }, 50);
    const decided = await waiting;
    expect(decided).toMatchObject({
      id: a.id,
      status: 'approved',
      decision: { by: 'user:owner', editedInput: EDITED },
    });
    // The grant written by the other connection is usable (once) by the runner.
    expect(runner.consumeGrant('run_1', 'bot_1', SEND, ORIGINAL)?.updatedInput).toEqual(EDITED);
    expect(api.consumeGrant('run_1', 'bot_1', SEND, EDITED)).toBeNull();
  });

  it('times out with null when the other process never decides', async () => {
    const runner = new ApprovalQueue(dbA);
    const a = runner.create({
      runId: 'run_1',
      botId: 'bot_1',
      toolUseId: null,
      toolName: SEND,
      input: ORIGINAL,
      tier: 'EXTERNAL',
      card: card(SEND, 'EXTERNAL'),
    });
    await expect(runner.waitForDecision(a.id, 50, undefined, 10)).resolves.toBeNull();
    expect(new ApprovalQueue(dbB).get(a.id)?.status).toBe('pending');
  });
});
