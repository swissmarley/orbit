import { describe, expect, it } from 'vitest';
import { RunEvent, type RunEventBody } from './events';
import { RunState, foldRun, normalizeRunState, replayRun } from './projection';

let id = 0;
function envelope(seq: number, body: RunEventBody): RunEvent {
  id += 1;
  return {
    id,
    runId: 'run_1',
    botId: 'bot_1',
    seq,
    ts: new Date(Date.UTC(2026, 9, 4, 12, 0, seq)).toISOString(),
    ...body,
  };
}

const happy: RunEvent[] = [
  envelope(1, {
    type: 'run.queued',
    data: { trigger: { kind: 'manual', source: null }, prompt: 'hi', priority: 0, fixture: null },
  }),
  envelope(2, {
    type: 'run.started',
    data: { driver: 'mock', authMethod: 'mock', model: 'opus', cwd: '/w', resumeSessionId: null },
  }),
  envelope(3, {
    type: 'session.init',
    data: {
      sessionId: 's1',
      model: 'm',
      tools: ['Read'],
      engineVersion: '1',
      permissionMode: 'default',
      apiKeySource: 'none',
    },
  }),
  envelope(4, {
    type: 'tool.call',
    data: { toolUseId: 't1', name: 'Write', input: {}, parentToolUseId: null },
  }),
  envelope(5, {
    type: 'permission.decision',
    data: {
      toolUseId: 't1',
      toolName: 'Write',
      input: {},
      behavior: 'deny',
      reason: 'no',
      tier: 'WRITE_LOCAL',
      ruleId: null,
      approvalId: null,
    },
  }),
  envelope(6, {
    type: 'message.assistant',
    data: { messageId: 'm1', text: 'done', parentToolUseId: null },
  }),
  envelope(7, {
    type: 'run.completed',
    data: { result: 'done', stopReason: 'end_turn', sessionId: 's1', permissionDenials: [] },
  }),
];

describe('run projection', () => {
  it('every fixture event validates against the RunEvent schema', () => {
    for (const e of happy) expect(() => RunEvent.parse(e)).not.toThrow();
  });

  it('folds a full run', () => {
    const s = replayRun(happy)!;
    expect(s.status).toBe('completed');
    expect(s.sessionId).toBe('s1');
    expect(s.counts).toEqual({ toolCalls: 1, denied: 1, subagents: 0, messages: 1 });
    expect(s.resultText).toBe('done');
    expect(s.lastSeq).toBe(7);
    expect(s.startedAt).toBe(happy[1]!.ts);
    expect(s.endedAt).toBe(happy[6]!.ts);
  });

  it('is deterministic and does not mutate prior states', () => {
    const states = [] as ReturnType<typeof foldRun>[];
    let s: ReturnType<typeof foldRun> | undefined;
    for (const e of happy) {
      s = foldRun(s, e);
      states.push(s);
    }
    expect(states[3]!.counts.toolCalls).toBe(1);
    expect(states[2]!.counts.toolCalls).toBe(0);
    expect(replayRun(happy)).toEqual(replayRun([...happy]));
  });

  it('treats a usage limit as a pause, not a failure', () => {
    const limited = [
      ...happy.slice(0, 3),
      envelope(4, {
        type: 'run.rate_limited',
        data: {
          resetsAt: '2026-10-04T15:00:00.000Z',
          limitType: 'five_hour',
          message: 'Usage limit reached',
          sessionId: 's1',
        },
      }),
    ];
    const s = replayRun(limited)!;
    expect(s.status).toBe('rate_limited');
    expect(s.endedAt).toBeNull();
    expect(s.usageLimit?.resetsAt).toBe('2026-10-04T15:00:00.000Z');
    expect(s.error).toBeNull();
  });
});

describe('resume scheduling and older projections', () => {
  it('tracks resumeAt until the Run resumes', () => {
    const base = happy.slice(0, 3);
    const limited = replayRun([
      ...base,
      envelope(4, {
        type: 'run.rate_limited',
        data: {
          resetsAt: '2026-10-04T15:00:00.000Z',
          limitType: 'five_hour',
          message: 'limit',
          sessionId: 's1',
        },
      }),
      envelope(5, {
        type: 'run.resume_scheduled',
        data: { at: '2026-10-04T15:00:30.000Z', reason: 'usage_limit' },
      }),
    ])!;
    expect(limited.status).toBe('rate_limited');
    expect(limited.resumeAt).toBe('2026-10-04T15:00:30.000Z');
    const resumed = foldRun(
      limited,
      envelope(6, { type: 'run.resumed', data: { reason: 'usage_limit', sessionId: 's1' } }),
    );
    expect(resumed.resumeAt).toBeNull();
    expect(resumed.status).toBe('running');
  });

  it('fills fields missing from projections stored before they existed', () => {
    const stored = replayRun(happy)!;
    const { resumeAt: _r, priority: _p, ...old } = stored;
    const normalized = normalizeRunState(old as RunState);
    expect(normalized).toEqual(stored);
    expect(RunState.parse(normalized)).toEqual(stored);
  });
});
