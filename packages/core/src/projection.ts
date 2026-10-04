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
  };
}

/** Pure reducer: (state, event) → next state. Never mutates its inputs. */
export function foldRun(prev: RunState | undefined, e: RunEvent): RunState {
  const s: RunState = prev ? { ...prev, counts: { ...prev.counts } } : initialRunState(e);
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
