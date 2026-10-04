import { type RunEventBody, TERMINAL_EVENT_TYPES, isTerminalEvent } from '@orbit/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentDriver, DriverRunRequest, PermissionHandler } from '../src/drivers/types';

export type Scenario =
  'pong' | 'read-then-write-denied' | 'usage-limit' | 'subagent-delegation' | 'max-turns' | 'hang';

export interface Harness {
  /** Prepare a driver + request fields that make it replay `scenario`. */
  prepare(scenario: Scenario): Promise<{ driver: AgentDriver; base: Partial<DriverRunRequest> }>;
  cleanup(): Promise<void>;
}

export const readOnlyPolicy: PermissionHandler = (r) =>
  Promise.resolve(
    ['Read', 'Glob', 'Grep', 'Task', 'Agent'].includes(r.toolName)
      ? { behavior: 'allow', reason: 'read-only tool' }
      : { behavior: 'deny', reason: 'writes need approval' },
  );
export const allowAll: PermissionHandler = () =>
  Promise.resolve({ behavior: 'allow', reason: 'allow all' });
export const denyAll: PermissionHandler = () =>
  Promise.resolve({ behavior: 'deny', reason: 'deny all' });
export const throwing: PermissionHandler = () => Promise.reject(new Error('policy engine down'));

export async function collect(
  driver: AgentDriver,
  base: Partial<DriverRunRequest>,
  overrides: Partial<DriverRunRequest> = {},
  onEvent?: (e: RunEventBody, controller: AbortController) => void,
): Promise<RunEventBody[]> {
  const controller = new AbortController();
  const req: DriverRunRequest = {
    runId: 'run_contract',
    prompt: 'Read notes.txt, then write a one-sentence summary of it to summary.txt.',
    cwd: process.cwd(),
    model: null,
    appendSystemPrompt: null,
    tools: null,
    maxTurns: null,
    resumeSessionId: null,
    sessionId: null,
    permission: readOnlyPolicy,
    signal: controller.signal,
    ...base,
    ...overrides,
  };
  if (overrides.signal === undefined) req.signal = controller.signal;
  const events: RunEventBody[] = [];
  for await (const e of driver.run(req)) {
    events.push(e);
    onEvent?.(e, controller);
  }
  return events;
}

function indexOf(events: RunEventBody[], pred: (e: RunEventBody) => boolean): number {
  return events.findIndex(pred);
}

/** Invariants every driver must satisfy, whatever the scenario. */
export function expectWellFormed(events: RunEventBody[]): void {
  const terminals = events.filter(isTerminalEvent);
  expect(terminals, 'exactly one terminal event').toHaveLength(1);
  expect(TERMINAL_EVENT_TYPES).toContain(events.at(-1)!.type);
  // every permission decision sits between its tool.call and tool.result
  for (const [i, e] of events.entries()) {
    if (e.type !== 'permission.decision' || !e.data.toolUseId) continue;
    const id = e.data.toolUseId;
    const call = indexOf(events, (x) => x.type === 'tool.call' && x.data.toolUseId === id);
    const result = indexOf(events, (x) => x.type === 'tool.result' && x.data.toolUseId === id);
    expect(call, `tool.call for ${id} precedes its decision`).toBeGreaterThanOrEqual(0);
    expect(call).toBeLessThan(i);
    if (result >= 0) expect(result, `decision for ${id} precedes its result`).toBeGreaterThan(i);
  }
}

/** The shared contract suite (ADR-002). */
export function runDriverContract(name: string, makeHarness: () => Harness): void {
  describe(`${name} — AgentDriver contract`, () => {
    const h = makeHarness();
    afterAll(() => h.cleanup());

    it('streams a simple reply and ends with run.completed', async () => {
      const { driver, base } = await h.prepare('pong');
      const events = await collect(driver, base);
      expectWellFormed(events);
      const init = events.find((e) => e.type === 'session.init');
      expect(init?.type === 'session.init' && init.data.sessionId.length > 0).toBe(true);
      expect(events.some((e) => e.type === 'message.assistant' && e.data.text === 'pong')).toBe(
        true,
      );
      expect(events.some((e) => e.type === 'usage')).toBe(true);
      const last = events.at(-1)!;
      expect(last.type).toBe('run.completed');
      if (last.type === 'run.completed') expect(last.data.result).toBe('pong');
    });

    it('routes every tool call through the permission handler, in order', async () => {
      const { driver, base } = await h.prepare('read-then-write-denied');
      const events = await collect(driver, base, { permission: readOnlyPolicy });
      expectWellFormed(events);
      const decisions = events.flatMap((e) =>
        e.type === 'permission.decision' ? [[e.data.toolName, e.data.behavior]] : [],
      );
      expect(decisions).toEqual([
        ['Read', 'allow'],
        ['Write', 'deny'],
      ]);
      const writeResult = events.find(
        (e) =>
          e.type === 'tool.result' &&
          e.data.isError &&
          e.data.content.includes('writes need approval'),
      );
      expect(writeResult).toBeDefined();
      const last = events.at(-1)!;
      expect(last.type).toBe('run.completed');
      if (last.type === 'run.completed') {
        expect(last.data.permissionDenials.map((d) => d.toolName)).toEqual(['Write']);
      }
    });

    it('stops at the first denied call under a deny-all policy', async () => {
      const { driver, base } = await h.prepare('read-then-write-denied');
      const events = await collect(driver, base, { permission: denyAll });
      expectWellFormed(events);
      const decisions = events.filter((e) => e.type === 'permission.decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.type === 'permission.decision' && decisions[0].data.toolName).toBe(
        'Read',
      );
      expect(events.some((e) => e.type === 'tool.result' && e.data.isError)).toBe(true);
    });

    it('fails closed when the permission handler throws', async () => {
      const { driver, base } = await h.prepare('read-then-write-denied');
      const events = await collect(driver, base, { permission: throwing });
      expectWellFormed(events);
      const d = events.find((e) => e.type === 'permission.decision');
      expect(d?.type === 'permission.decision' && d.data.behavior).toBe('deny');
      expect(d?.type === 'permission.decision' && d.data.reason).toMatch(/Permission check failed/);
    });

    it('pauses on a usage limit instead of failing', async () => {
      const { driver, base } = await h.prepare('usage-limit');
      const events = await collect(driver, base);
      expectWellFormed(events);
      const limit = events.find((e) => e.type === 'usage_limit');
      expect(limit?.type === 'usage_limit' && limit.data.status).toBe('rejected');
      const last = events.at(-1)!;
      expect(last.type).toBe('run.rate_limited');
      if (last.type === 'run.rate_limited') {
        expect(last.data.limitType).toBe('five_hour');
        expect(last.data.resetsAt).toBe('2026-10-05T00:00:00.000Z');
      }
    });

    it('reports subagent delegation with parent links', async () => {
      const { driver, base } = await h.prepare('subagent-delegation');
      const events = await collect(driver, base);
      expectWellFormed(events);
      const started = events.filter((e) => e.type === 'subagent.started');
      expect(started).toHaveLength(1);
      expect(started[0]?.type === 'subagent.started' && started[0].data.agentType).toBe('Explore');
      expect(
        events.some((e) => e.type === 'subagent.stopped' && e.data.toolUseId === 'toolu_task_1'),
      ).toBe(true);
      expect(
        events.some(
          (e) => e.type === 'message.assistant' && e.data.parentToolUseId === 'toolu_task_1',
        ),
      ).toBe(true);
      expect(events.at(-1)!.type).toBe('run.completed');
    });

    it('maps engine errors to run.failed with a code', async () => {
      const { driver, base } = await h.prepare('max-turns');
      const events = await collect(driver, base);
      expectWellFormed(events);
      const last = events.at(-1)!;
      expect(last.type).toBe('run.failed');
      if (last.type === 'run.failed') expect(last.data.code).toBe('max_turns');
    });

    it('uses the requested session id for new sessions and resumes', async () => {
      const { driver, base } = await h.prepare('pong');
      const fresh = await collect(driver, base, {
        sessionId: '11111111-1111-4111-8111-111111111111',
      });
      const init = fresh.find((e) => e.type === 'session.init');
      expect(init?.type === 'session.init' && init.data.sessionId).toBe(
        '11111111-1111-4111-8111-111111111111',
      );
      const resumed = await collect(driver, base, {
        resumeSessionId: '22222222-2222-4222-8222-222222222222',
      });
      const last = resumed.at(-1)!;
      expect(last.type === 'run.completed' && last.data.sessionId).toBe(
        '22222222-2222-4222-8222-222222222222',
      );
    });

    it('stops promptly with run.cancelled when aborted', async () => {
      const { driver, base } = await h.prepare('hang');
      const started = Date.now();
      const events = await collect(driver, base, {}, (_e, controller) => controller.abort());
      expect(Date.now() - started).toBeLessThan(8000);
      expectWellFormed(events);
      expect(events.at(-1)!.type).toBe('run.cancelled');
    }, 15_000);
  });
}
