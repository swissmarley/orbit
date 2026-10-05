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
    data: {
      trigger: { kind: 'manual', source: null },
      prompt: 'hi',
      priority: 0,
      fixture: null,
      parentRunId: null,
      depth: 0,
      inheritedTaint: [],
      budgetCap: null,
    },
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

  describe('delegation (M6)', () => {
    const queued = (data: Record<string, unknown>) =>
      envelope(1, {
        type: 'run.queued',
        data: {
          trigger: { kind: 'delegation', source: 'run_0' },
          prompt: 'task',
          priority: 0,
          fixture: null,
          parentRunId: 'run_0',
          depth: 1,
          inheritedTaint: ['WebFetch'],
          budgetCap: { toolCalls: 5, tokens: null, costUsd: null, wallClockMinutes: 10 },
          ...data,
        },
      });

    it('a child Run starts with its parent, depth, ceiling and inherited taint', () => {
      const s = replayRun([queued({})])!;
      expect(s).toMatchObject({ parentRunId: 'run_0', depth: 1, taintSources: ['WebFetch'] });
      expect(s.budgetCap?.toolCalls).toBe(5);
    });

    it('a parent parks as delegating, counts child spend, and stays parked until children answer', () => {
      const started = (seq: number, id: string) =>
        envelope(seq, {
          type: 'delegation.started',
          data: { childRunId: id, childBotId: 'bot_c', childBotName: 'C', task: 't' },
        });
      const finished = (seq: number, id: string) =>
        envelope(seq, {
          type: 'delegation.finished',
          data: {
            childRunId: id,
            childBotId: 'bot_c',
            status: 'completed',
            result: 'ok',
            totals: { tokens: 100, costUsd: 0.5, toolCalls: 3 },
          },
        });
      const base = replayRun(happy.slice(0, 4))!;
      let s = foldRun(base, started(5, 'run_a'));
      s = foldRun(s, started(6, 'run_b'));
      // run_b answers before the parent has even parked.
      s = foldRun(s, finished(7, 'run_b'));
      s = foldRun(
        s,
        envelope(8, {
          type: 'run.parked',
          data: { approvalIds: [], sessionId: 's1', delegations: ['run_a', 'run_b'] },
        }),
      );
      expect(s.status).toBe('delegating');
      expect(s.pendingDelegations).toEqual(['run_a']);
      s = foldRun(s, finished(9, 'run_a'));
      expect(s.pendingDelegations).toEqual([]);
      expect(s.children.map((c) => c.status)).toEqual(['completed', 'completed']);
      expect(s.delegated).toEqual({ tokens: 200, costUsd: 1, toolCalls: 6 });
      s = foldRun(
        s,
        envelope(10, { type: 'run.resumed', data: { reason: 'delegation', sessionId: 's1' } }),
      );
      expect(s.status).toBe('running');
    });

    it('approvals pending at park win over delegations (the Run needs you first)', () => {
      const base = replayRun(happy.slice(0, 4))!;
      let s = foldRun(
        base,
        envelope(5, {
          type: 'delegation.started',
          data: { childRunId: 'run_a', childBotId: 'b', childBotName: 'B', task: 't' },
        }),
      );
      s = foldRun(
        s,
        envelope(6, {
          type: 'approval.requested',
          data: {
            approvalId: 'apr_1',
            toolUseId: null,
            toolName: 'x',
            tier: 'EXTERNAL',
            summary: 'x',
          },
        }),
      );
      s = foldRun(
        s,
        envelope(7, {
          type: 'run.parked',
          data: { approvalIds: ['apr_1'], sessionId: null, delegations: ['run_a'] },
        }),
      );
      expect(s.status).toBe('waiting_approval');
      s = foldRun(
        s,
        envelope(8, {
          type: 'approval.decided',
          data: {
            approvalId: 'apr_1',
            decision: 'approved',
            by: 'owner',
            edited: false,
            reason: null,
            ruleId: null,
          },
        }),
      );
      expect(s.status).toBe('delegating');
    });

    it('older run.queued and run.parked events without delegation fields still fold', () => {
      const old = envelope(1, {
        type: 'run.queued',
        data: {
          trigger: { kind: 'manual', source: null },
          prompt: 'p',
          priority: 0,
          fixture: null,
        },
      } as unknown as RunEventBody);
      const s = replayRun([old])!;
      expect(s).toMatchObject({ parentRunId: null, depth: 0, budgetCap: null, taintSources: [] });
    });

    it('records thumbs ratings and memory writes', () => {
      let s = replayRun(happy)!;
      s = foldRun(
        s,
        envelope(50, {
          type: 'feedback.recorded',
          data: { signal: 'thumbs_down', memoryId: 'mem_1', approvalId: null, by: 'owner' },
        }),
      );
      s = foldRun(
        s,
        envelope(51, {
          type: 'memory.written',
          data: {
            memoryId: 'mem_2',
            kind: 'summary',
            source: 'summarizer',
            tainted: false,
          },
        }),
      );
      expect(s.rating).toBe('down');
      expect(s.memoryWrites).toBe(1);
      expect(s.status).toBe('completed');
    });
  });
});

describe('pause and interruption (ADR-016)', () => {
  const running = () => replayRun(happy.slice(0, 4))!;
  const paused = (
    seq: number,
    data: Partial<Extract<RunEventBody, { type: 'run.paused' }>['data']>,
  ) =>
    envelope(seq, {
      type: 'run.paused',
      data: {
        reason: 'owner',
        by: 'owner',
        sessionId: 's1',
        interruptedTurn: false,
        toolUseId: null,
        toolName: null,
        autoResume: false,
        detail: null,
        activeMs: 0,
        ...data,
      },
    });

  it('a pause request is open until the segment ends; a paused Run is not ended', () => {
    let s = foldRun(
      running(),
      envelope(5, { type: 'run.pause_requested', data: { by: 'owner', now: false } }),
    );
    expect(s.pauseRequested).toMatchObject({ by: 'owner', now: false });
    s = foldRun(s, paused(6, { toolUseId: 't2', toolName: 'Bash' }));
    expect(s.status).toBe('paused');
    expect(s.endedAt).toBeNull();
    expect(s.pauseRequested).toBeNull();
    expect(s.pause).toMatchObject({ reason: 'owner', toolName: 'Bash', autoResume: false });
    s = foldRun(
      s,
      envelope(7, { type: 'run.resumed', data: { reason: 'pause', sessionId: 's1' } }),
    );
    expect(s.status).toBe('running');
    expect(s.pause).toBeNull();
  });

  it('a lapsed request closes; a request on a Run that is not running is ignored', () => {
    let s = foldRun(
      running(),
      envelope(5, { type: 'run.pause_requested', data: { by: 'owner', now: false } }),
    );
    s = foldRun(s, envelope(6, { type: 'run.pause_lapsed', data: { by: 'owner' } }));
    expect(s.pauseRequested).toBeNull();
    const done = replayRun(happy)!;
    expect(
      foldRun(done, envelope(8, { type: 'run.pause_requested', data: { by: 'owner', now: true } }))
        .pauseRequested,
    ).toBeNull();
  });

  it('interruptions are counted and unreported active time is added to the wall clock', () => {
    let s = foldRun(running(), paused(5, { reason: 'interrupted', by: 'system', activeMs: 1500 }));
    expect(s.interruptions).toBe(1);
    expect(s.totals.activeMs).toBe(1500);
    s = foldRun(
      s,
      envelope(6, { type: 'run.resumed', data: { reason: 'interrupted', sessionId: 's1' } }),
    );
    s = foldRun(s, paused(7, { reason: 'interrupted', by: 'system', autoResume: true }));
    expect(s.interruptions).toBe(2);
    expect(s.pause?.autoResume).toBe(true);
    s = foldRun(s, envelope(8, { type: 'run.cancelled', data: { reason: 'x', sessionId: 's1' } }));
    expect(s.pause).toBeNull();
  });
});
