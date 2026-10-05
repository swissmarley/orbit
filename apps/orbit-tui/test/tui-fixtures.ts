import { Bot, type RunEvent, type RunEventBody, type RunState, replayRun } from '@orbit/core';
import type { Approval } from '@orbit/sdk-client';
import { vi } from 'vitest';
import type { TuiClient } from '../src/tui/feed';
import { type Data, EMPTY_DATA } from '../src/tui/model';

/** Deterministic TUI test data (fixed ids and times, no locale-dependent output). */
const T = '2026-10-04T09:15:00.000Z';

export function bot(id: string, name: string, pausedAt: string | null = null): Bot {
  return Bot.parse({
    id,
    version: 1,
    spec: { name, goal: `${name} goal` },
    pausedAt,
    createdAt: T,
    updatedAt: T,
  });
}

let seq = 0;
export function events(runId: string, botId: string, bodies: RunEventBody[]): RunEvent[] {
  return bodies.map((b, i) => ({
    id: ++seq,
    runId,
    botId,
    seq: i + 1,
    ts: T,
    ...b,
  }));
}

export const mailerEvents = (runId: string, botId: string) =>
  events(runId, botId, [
    {
      type: 'run.queued',
      data: {
        trigger: { kind: 'manual', source: null },
        prompt: 'Reply to Ada',
        priority: 10,
        fixture: null,
      },
    },
    {
      type: 'run.started',
      data: { driver: 'mock', authMethod: 'mock', model: 'opus', cwd: '/w', resumeSessionId: null },
    },
    {
      type: 'message.assistant',
      data: { messageId: null, text: 'I drafted the reply to Ada.', parentToolUseId: null },
    },
    {
      type: 'tool.call',
      data: {
        toolUseId: 't1',
        name: 'mcp__gmail__send_email',
        input: { to: 'ada@example.com' },
        parentToolUseId: null,
      },
    },
    {
      type: 'approval.requested',
      data: {
        approvalId: 'apr_1',
        toolUseId: 't1',
        toolName: 'mcp__gmail__send_email',
        tier: 'EXTERNAL',
        summary: 'send email (gmail) → ada@example.com',
      },
    },
    { type: 'run.parked', data: { approvalIds: ['apr_1'], sessionId: 's1' } },
  ]);

export function run(runId: string, botId: string, status: RunState['status']): RunState {
  const s = replayRun(
    events(runId, botId, [
      {
        type: 'run.queued',
        data: {
          trigger: { kind: 'manual', source: null },
          prompt: 'p',
          priority: 10,
          fixture: null,
        },
      },
    ]),
  )!;
  return { ...s, status, createdAt: T };
}

export function approval(id: string, over: Partial<Approval['card']> = {}): Approval {
  return {
    id,
    runId: 'run_a2',
    botId: 'bot_a',
    toolUseId: 't1',
    toolName: 'mcp__gmail__send_email',
    input: { to: 'ada@example.com', subject: 'Tuesday' },
    inputHash: 'h',
    tier: 'EXTERNAL',
    card: {
      what: 'send email (gmail) → ada@example.com',
      why: 'I drafted the reply to Ada and will send it now.',
      toolName: 'mcp__gmail__send_email',
      tier: 'EXTERNAL',
      payload: { to: 'ada@example.com', subject: 'Tuesday' },
      diff: null,
      botId: 'bot_a',
      botName: 'Mailer',
      runId: 'run_a2',
      untrusted: [],
      risk: 'Has effects outside the sandbox.',
      ...over,
    },
    status: 'pending',
    decision: null,
    createdAt: T,
    decidedAt: null,
    expiresAt: null,
  };
}

export function data(over: Partial<Data> = {}): Data {
  return {
    ...EMPTY_DATA,
    bots: [bot('bot_a', 'Mailer'), bot('bot_b', 'Notes'), bot('bot_c', 'Digest', T)],
    runs: [
      run('run_a2', 'bot_a', 'waiting_approval'),
      run('run_b1', 'bot_b', 'completed'),
      run('run_a1', 'bot_a', 'completed'),
    ],
    approvals: [approval('apr_1')],
    kill: { engaged: false, by: null },
    connected: true,
    ...over,
  };
}

/** A fake orbitd client over `data()`; `push` feeds the live event stream. */
export function fakeClient(
  d: Data = data(),
  timeline: RunEvent[] = mailerEvents('run_a2', 'bot_a'),
) {
  const live: RunEvent[] = [];
  let wake: (() => void) | null = null;
  const client = {
    doctor: vi.fn(() =>
      Promise.resolve({ driver: 'mock', authLabel: 'Demo mode', warnings: [] } as never),
    ),
    bots: {
      list: vi.fn(() => Promise.resolve(d.bots)),
      pause: vi.fn((id: string) =>
        Promise.resolve({ ...d.bots.find((b) => b.id === id)!, pausedAt: T }),
      ),
      resume: vi.fn((id: string) =>
        Promise.resolve({ ...d.bots.find((b) => b.id === id)!, pausedAt: null }),
      ),
    },
    runs: {
      list: vi.fn(() => Promise.resolve(d.runs)),
      events: vi.fn((runId: string) => Promise.resolve(timeline.filter((e) => e.runId === runId))),
      start: vi.fn((botId: string) => Promise.resolve(run('run_new', botId, 'queued'))),
      stop: vi.fn((runId: string) => Promise.resolve(run(runId, 'bot_a', 'cancelled'))),
      resume: vi.fn((runId: string) => Promise.resolve(run(runId, 'bot_a', 'queued'))),
    },
    approvals: {
      list: vi.fn(() => Promise.resolve(d.approvals)),
      approve: vi.fn((id: string) =>
        Promise.resolve({
          approval: { ...approval(id), status: 'approved' as const },
          resumed: true,
          run: null,
        }),
      ),
      deny: vi.fn((id: string) =>
        Promise.resolve({
          approval: { ...approval(id), status: 'denied' as const },
          resumed: false,
          run: null,
        }),
      ),
    },
    kill: {
      status: vi.fn(() => Promise.resolve(d.kill ?? { engaged: false, by: null })),
      set: vi.fn((on: boolean) => Promise.resolve({ engaged: on, by: on ? 'owner' : null })),
    },
    queue: vi.fn(() => Promise.resolve({ limit: 2, pausedUntil: null, active: [], queued: [] })),
    events: vi.fn(async function* (opts: { signal?: AbortSignal }) {
      while (!opts.signal?.aborted) {
        const e = live.shift();
        if (e) {
          yield e;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          opts.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    }),
  };
  return {
    client: client as unknown as TuiClient,
    mock: client,
    push(e: RunEvent) {
      live.push(e);
      wake?.();
    },
  };
}
