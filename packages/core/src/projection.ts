import type { AuthMethod, DriverKind, RunStatus } from './enums';
import type { RunEvent, TriggerRef, UsageTotals } from './events';

/**
 * Read model of a single Run, derived purely from its events. The event
 * store persists this projection for fast queries, but it can always be
 * rebuilt by folding the log (`replayRun`) — the log is the source of truth.
 */
export interface RunState {
  runId: string;
  botId: string;
  status: RunStatus;
  trigger: TriggerRef | null;
  prompt: string;
  driver: DriverKind | null;
  authMethod: AuthMethod | null;
  model: string | null;
  cwd: string | null;
  sessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastSeq: number;
  lastEventId: number;
  resultText: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  usage: UsageTotals | null;
  usageLimit: { resetsAt: string | null; limitType: string | null; message: string } | null;
  counts: { toolCalls: number; denied: number; subagents: number; messages: number };
  needsAction: string | null;
  /** Approvals requested by this Run and not yet decided. */
  pendingApprovals: string[];
  /** Untrusted content (web, email, external tools) entered the Run. */
  taintSources: string[];
  /** Live token usage of the current segment (from usage.turn). */
  liveUsage: { inputTokens: number; outputTokens: number; turns: number } | null;
  budgetExceeded: string | null;
  killedBy: string | null;
  /** Totals across every segment of the Run (budgets are per Run, not per segment). */
  totals: { tokens: number; turns: number; costUsd: number; activeMs: number };
}

export function initialRunState(first: RunEvent): RunState {
  return {
    runId: first.runId,
    botId: first.botId,
    status: 'queued',
    trigger: null,
    prompt: '',
    driver: null,
    authMethod: null,
    model: null,
    cwd: null,
    sessionId: null,
    createdAt: first.ts,
    startedAt: null,
    endedAt: null,
    lastSeq: 0,
    lastEventId: 0,
    resultText: null,
    error: null,
    usage: null,
    usageLimit: null,
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
    case 'run.resumed':
      s.status = 'running';
      s.sessionId = e.data.sessionId ?? s.sessionId;
      s.usageLimit = null;
      s.needsAction = null;
      break;
    case 'run.completed':
      s.status = 'completed';
      s.resultText = e.data.result;
      s.sessionId = e.data.sessionId ?? s.sessionId;
      s.endedAt = e.ts;
      break;
    case 'run.failed':
      s.status = 'failed';
      s.error = { code: e.data.code, message: e.data.message, retryable: e.data.retryable };
      s.sessionId = e.data.sessionId ?? s.sessionId;
      s.endedAt = e.ts;
      break;
    case 'run.cancelled':
      s.status = 'cancelled';
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
