import { z } from 'zod';
import { AuthMethod, DriverKind, RunStatus } from './enums';
import { type RunEvent, TriggerRef, UsageTotals } from './events';

/**
 * Read model of a single Run, derived purely from its events. The event
 * store persists this projection for fast queries, but it can always be
 * rebuilt by folding the log (`replayRun`) — the log is the source of truth.
 */
export const RunState = z.object({
  runId: z.string(),
  botId: z.string(),
  status: RunStatus,
  trigger: TriggerRef.nullable(),
  prompt: z.string(),
  /** Queue priority from run.queued (higher runs first). */
  priority: z.int(),
  driver: DriverKind.nullable(),
  authMethod: AuthMethod.nullable(),
  model: z.string().nullable(),
  cwd: z.string().nullable(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  lastSeq: z.int(),
  lastEventId: z.int(),
  resultText: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  usage: UsageTotals.nullable(),
  usageLimit: z
    .object({
      resetsAt: z.string().nullable(),
      limitType: z.string().nullable(),
      message: z.string(),
    })
    .nullable(),
  /** When the Run resumes by itself (usage-limit reset); null = not scheduled. */
  resumeAt: z.string().nullable(),
  counts: z.object({
    toolCalls: z.int(),
    denied: z.int(),
    subagents: z.int(),
    messages: z.int(),
  }),
  needsAction: z.string().nullable(),
  /** Approvals requested by this Run and not yet decided. */
  pendingApprovals: z.array(z.string()),
  /** Untrusted content (web, email, external tools) entered the Run. */
  taintSources: z.array(z.string()),
  /** Live token usage of the current segment (from usage.turn). */
  liveUsage: z.object({ inputTokens: z.int(), outputTokens: z.int(), turns: z.int() }).nullable(),
  budgetExceeded: z.string().nullable(),
  killedBy: z.string().nullable(),
  /** Totals across every segment of the Run (budgets are per Run, not per segment). */
  totals: z.object({
    tokens: z.number(),
    turns: z.number(),
    costUsd: z.number(),
    activeMs: z.number(),
  }),
});
export type RunState = z.infer<typeof RunState>;

/**
 * Fill fields added after a projection was stored (older rows lack them), so
 * readers always see the current RunState shape without a rebuild.
 */
export function normalizeRunState(stored: RunState): RunState {
  const s = stored as Partial<RunState> & Pick<RunState, 'runId' | 'botId' | 'createdAt'>;
  return { ...blankState(s.runId, s.botId, s.createdAt), ...s };
}

function blankState(runId: string, botId: string, createdAt: string): RunState {
  return {
    runId,
    botId,
    status: 'queued',
    trigger: null,
    prompt: '',
    priority: 0,
    driver: null,
    authMethod: null,
    model: null,
    cwd: null,
    sessionId: null,
    createdAt,
    startedAt: null,
    endedAt: null,
    lastSeq: 0,
    lastEventId: 0,
    resultText: null,
    error: null,
    usage: null,
    usageLimit: null,
    resumeAt: null,
    counts: { toolCalls: 0, denied: 0, subagents: 0, messages: 0 },
    needsAction: null,
    pendingApprovals: [],
    taintSources: [],
    liveUsage: null,
    budgetExceeded: null,
    killedBy: null,
    totals: { tokens: 0, turns: 0, costUsd: 0, activeMs: 0 },
  };
}

export function initialRunState(first: RunEvent): RunState {
  return blankState(first.runId, first.botId, first.ts);
}

/** Pure reducer: (state, event) → next state. Never mutates its inputs. */
export function foldRun(prev: RunState | undefined, e: RunEvent): RunState {
  const s: RunState = prev
    ? {
        ...prev,
        counts: { ...prev.counts },
        pendingApprovals: [...prev.pendingApprovals],
        totals: { ...prev.totals },
        taintSources: [...prev.taintSources],
      }
    : initialRunState(e);
  s.lastSeq = e.seq;
  s.lastEventId = e.id;

  switch (e.type) {
    case 'run.queued':
      s.status = 'queued';
      s.trigger = e.data.trigger;
      s.prompt = e.data.prompt;
      // Events logged before M3 have no priority (the log is never rewritten).
      s.priority = typeof e.data.priority === 'number' ? e.data.priority : 0;
      break;
    case 'run.started':
      s.status = 'running';
      s.driver = e.data.driver;
      s.authMethod = e.data.authMethod;
      s.model = e.data.model;
      s.cwd = e.data.cwd;
      s.startedAt ??= e.ts;
      s.endedAt = null;
      s.usageLimit = null;
      s.error = null;
      s.liveUsage = null;
      break;
    case 'session.init':
      s.sessionId = e.data.sessionId;
      if (e.data.model) s.model = e.data.model;
      break;
    case 'message.assistant':
      s.counts.messages += 1;
      break;
    case 'tool.call':
      s.counts.toolCalls += 1;
      break;
    case 'permission.decision':
      if (e.data.behavior === 'deny') s.counts.denied += 1;
      break;
    case 'subagent.started':
      s.counts.subagents += 1;
      break;
    case 'status.summary':
      s.needsAction =
        e.data.needsAction && e.data.needsAction.length > 0 ? e.data.needsAction : null;
      break;
    case 'usage':
      s.usage = e.data;
      s.totals.tokens +=
        e.data.inputTokens +
        e.data.outputTokens +
        e.data.cacheReadTokens +
        e.data.cacheCreationTokens;
      s.totals.turns += e.data.numTurns;
      s.totals.costUsd += e.data.costUsd ?? 0;
      s.totals.activeMs += e.data.durationMs;
      break;
    case 'usage.turn':
      s.liveUsage = e.data;
      break;
    case 'approval.requested':
      if (!s.pendingApprovals.includes(e.data.approvalId))
        s.pendingApprovals.push(e.data.approvalId);
      break;
    case 'approval.decided':
      s.pendingApprovals = s.pendingApprovals.filter((id) => id !== e.data.approvalId);
      break;
    case 'run.tainted':
      if (!s.taintSources.includes(e.data.source)) s.taintSources.push(e.data.source);
      break;
    case 'budget.exceeded':
      s.budgetExceeded = e.data.budget;
      break;
    case 'run.killed':
      s.killedBy = e.data.scope;
      break;
    case 'run.parked':
      // Waiting on the human: not ended, not failed.
      s.status = 'waiting_approval';
      s.sessionId = e.data.sessionId ?? s.sessionId;
      break;
    case 'run.resume_scheduled':
      s.resumeAt = e.data.at;
      break;
    case 'run.resumed':
      s.status = 'running';
      s.resumeAt = null;
      s.sessionId = e.data.sessionId ?? s.sessionId;
      s.usageLimit = null;
      s.needsAction = null;
      break;
    case 'run.completed':
      s.status = 'completed';
      s.resumeAt = null;
      s.resultText = e.data.result;
      s.sessionId = e.data.sessionId ?? s.sessionId;
      s.endedAt = e.ts;
      break;
    case 'run.failed':
      s.status = 'failed';
      s.resumeAt = null;
      s.error = { code: e.data.code, message: e.data.message, retryable: e.data.retryable };
      s.sessionId = e.data.sessionId ?? s.sessionId;
      s.endedAt = e.ts;
      break;
    case 'run.cancelled':
      s.status = 'cancelled';
      s.resumeAt = null;
      s.sessionId = e.data.sessionId ?? s.sessionId;
      s.endedAt = e.ts;
      break;
    case 'run.rate_limited':
      // A usage limit is a pause, not a failure: the Run resumes after reset.
      s.status = 'rate_limited';
      s.usageLimit = {
        resetsAt: e.data.resetsAt,
        limitType: e.data.limitType,
        message: e.data.message,
      };
      s.sessionId = e.data.sessionId ?? s.sessionId;
      break;
    default:
      break;
  }
  return s;
}

export function replayRun(events: readonly RunEvent[]): RunState | undefined {
  let s: RunState | undefined;
  for (const e of events) s = foldRun(s, e);
  return s;
}
