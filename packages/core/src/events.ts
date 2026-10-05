import { z } from 'zod';
import { AuthMethod, DriverKind, Tier } from './enums';
import { FeedbackSignal, MemoryKind, MemorySource } from './memory';

/**
 * The RunEvent model. Every driver message, policy decision and lifecycle
 * transition becomes exactly one of these, appended to the immutable event
 * log. All UI state is a projection of this log (see projection.ts).
 *
 * Shape: `{ type, data }` bodies produced by drivers/orchestrator, wrapped in
 * an envelope `{ id, runId, botId, seq, ts }` by the event store.
 */

const nullableString = z.string().nullable();
const parentToolUseId = nullableString.describe(
  'Tool use id of the Task/Agent call that spawned this subagent message; null for the main agent',
);

function ev<T extends string, S extends z.ZodRawShape>(type: T, data: S) {
  return z.object({ type: z.literal(type), data: z.object(data) });
}

export const TriggerRef = z.object({
  kind: z.enum([
    'manual',
    'cron',
    'interval',
    'webhook',
    'slack',
    'file',
    'git',
    'delegation',
    'resume',
  ]),
  source: nullableString,
});
export type TriggerRef = z.infer<typeof TriggerRef>;

export const PermissionDenial = z.object({ toolName: z.string(), toolUseId: nullableString });

export const UsageTotals = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheCreationTokens: z.int().nonnegative(),
  /** Engine-estimated USD. Informational in subscription mode. */
  costUsd: z.number().nonnegative().nullable(),
  numTurns: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
  models: z.array(z.string()),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const UsageLimitStatus = z.enum(['allowed', 'allowed_warning', 'rejected']);

/**
 * Limits a delegated (child) Run inherits from its parent: whatever the
 * parent has left, so a delegation can never spend more than its parent may.
 */
export const BudgetCap = z.object({
  toolCalls: z.int().nonnegative(),
  tokens: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  wallClockMinutes: z.number().nonnegative(),
});
export type BudgetCap = z.infer<typeof BudgetCap>;

export const DelegationTotals = z.object({
  tokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  toolCalls: z.int().nonnegative(),
});

export const RunEventBody = z.discriminatedUnion('type', [
  // ── lifecycle (orchestrator) ────────────────────────────────────────────
  ev('run.queued', {
    trigger: TriggerRef,
    prompt: z.string(),
    /** Higher runs first; FIFO within a priority (RunQueue). */
    priority: z.int().min(-100).max(100).default(0),
    /** MockDriver scenario chosen for this Run (demo mode and tests). */
    fixture: nullableString.default(null),
    /** The Run that delegated this one (delegate_to_bot); null for top-level Runs. */
    parentRunId: nullableString.default(null),
    /** Delegation depth: 0 for top-level Runs. */
    depth: z.int().min(0).max(10).default(0),
    /** Untrusted sources the Run starts with (a delegating parent's taint). */
    inheritedTaint: z.array(z.string()).default([]),
    /** Budget ceiling inherited from a delegating parent. */
    budgetCap: BudgetCap.nullable().default(null),
  }),
  ev('run.started', {
    driver: DriverKind,
    authMethod: AuthMethod,
    model: nullableString,
    cwd: z.string(),
    resumeSessionId: nullableString,
  }),
  // ── engine session ──────────────────────────────────────────────────────
  ev('session.init', {
    sessionId: z.string(),
    model: nullableString,
    tools: z.array(z.string()),
    engineVersion: nullableString,
    permissionMode: nullableString,
    /** Credential source the engine reports (e.g. ANTHROPIC_API_KEY, none, oauth). */
    apiKeySource: nullableString,
  }),
  ev('message.assistant', { messageId: nullableString, text: z.string(), parentToolUseId }),
  ev('message.thinking', { messageId: nullableString, text: z.string(), parentToolUseId }),
  ev('message.user', { text: z.string(), parentToolUseId }),
  ev('tool.call', {
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
    parentToolUseId,
  }),
  ev('tool.result', {
    toolUseId: z.string(),
    isError: z.boolean(),
    content: z.string(),
    truncated: z.boolean(),
    parentToolUseId,
  }),
  ev('permission.decision', {
    toolUseId: nullableString,
    toolName: z.string(),
    input: z.unknown(),
    behavior: z.enum(['allow', 'deny']),
    reason: z.string(),
    /** Risk tier the policy assigned; null when decided outside the policy engine. */
    tier: Tier.nullable().default(null),
    /** Standing rule or one-shot grant that produced the decision. */
    ruleId: nullableString.default(null),
    approvalId: nullableString.default(null),
  }),
  ev('approval.requested', {
    approvalId: z.string(),
    toolUseId: nullableString,
    toolName: z.string(),
    tier: Tier,
    summary: z.string(),
  }),
  ev('approval.decided', {
    approvalId: z.string(),
    decision: z.enum(['approved', 'denied', 'expired', 'cancelled']),
    by: z.string(),
    edited: z.boolean(),
    reason: nullableString,
    ruleId: nullableString,
  }),
  ev('run.tainted', { source: z.string(), toolUseId: nullableString }),
  ev('budget.exceeded', {
    budget: z.enum([
      'toolCalls',
      'wallClock',
      'tokens',
      'turns',
      'costPerRun',
      'costPerDay',
      'runsPerDay',
    ]),
    limit: z.number(),
    actual: z.number(),
  }),
  ev('usage.turn', {
    /** Cumulative for the current driver segment (subagents' tokens included). */
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    /** The main agent's turns so far (subagents have their own limits); Orbit enforces `maxTurns` on it. */
    turns: z.int().nonnegative(),
  }),
  /** Run stopped by a kill switch or budget before/while running (precedes run.cancelled/failed). */
  ev('run.killed', { scope: z.enum(['run', 'bot', 'global']), by: z.string() }),
  /** Driver segment ended while approvals are pending; the Run resumes after decisions. */
  ev('run.parked', {
    approvalIds: z.array(z.string()),
    sessionId: nullableString,
    /** Child Runs this Run waits for (delegate_to_bot). */
    delegations: z.array(z.string()).default([]),
  }),
  ev('run.resumed', {
    reason: z.enum(['approval', 'usage_limit', 'manual', 'delegation', 'pause', 'interrupted']),
    sessionId: nullableString,
  }),
  /**
   * The owner asked to pause a running Run (ADR-016): at its next tool-call
   * decision, or `now` (the engine is stopped mid-turn).
   */
  ev('run.pause_requested', { by: z.string(), now: z.boolean() }),
  /** The segment ended without another tool call: the pause request did not apply. */
  ev('run.pause_lapsed', { by: z.string() }),
  /**
   * The segment ended paused (ADR-016): not ended, not failed, and nothing
   * resumes it by itself, except an interrupted Run Orbit judged safe to
   * retry (`autoResume`). Like run.parked, it releases the concurrency slot.
   */
  ev('run.paused', {
    /** owner: `orbit pause`; interrupted: orbitd stopped while the Run executed. */
    reason: z.enum(['owner', 'interrupted']),
    by: z.string(),
    sessionId: nullableString,
    /** The engine was stopped mid-turn: a tool call without a result may or may not have happened. */
    interruptedTurn: z.boolean(),
    /** owner: the call denied to pause the Run; interrupted: the EXTERNAL call whose outcome is unknown. */
    toolUseId: nullableString.default(null),
    toolName: nullableString.default(null),
    /** Interrupted Runs only: Orbit resumes it through the queue (it was safe to). */
    autoResume: z.boolean().default(false),
    /** Orbit's own words on why an interrupted Run waits for the owner; null otherwise. */
    detail: nullableString.default(null),
    /** Active time of a segment the engine could not report (stopped mid-turn). */
    activeMs: z.int().nonnegative().default(0),
  }),
  /** The Run will resume by itself at `at` (e.g. when a usage limit resets). */
  ev('run.resume_scheduled', {
    at: z.iso.datetime(),
    reason: z.enum(['usage_limit']),
  }),
  ev('subagent.started', {
    toolUseId: z.string(),
    agentType: nullableString,
    description: nullableString,
    parentToolUseId,
  }),
  /**
   * The subagent keeps working in the background: its tool call returned at
   * launch, and `subagent.stopped` follows when its task-notification arrives.
   */
  ev('subagent.backgrounded', { toolUseId: z.string() }),
  ev('subagent.stopped', {
    toolUseId: z.string(),
    isError: z.boolean(),
    /** How a background subagent ended (from its task-notification); null for foreground ones. */
    outcome: z.enum(['completed', 'failed', 'stopped']).nullable().default(null),
  }),
  ev('hook', { hookEvent: z.string(), hookName: z.string(), outcome: nullableString }),
  ev('status.summary', {
    category: z.string(),
    detail: nullableString,
    needsAction: nullableString,
  }),
  ev('usage_limit', {
    status: UsageLimitStatus,
    limitType: nullableString,
    resetsAt: z.iso.datetime().nullable(),
    utilization: z.number().nullable(),
  }),
  ev('api.retry', {
    attempt: z.int().nullable(),
    delayMs: z.int().nullable(),
    error: nullableString,
  }),
  ev('usage', UsageTotals.shape),
  // ── memory, feedback, delegation (M6) ──────────────────────────────────
  /** No text: the event log is append-only, and a deleted memory must leave nothing behind. */
  ev('memory.written', {
    memoryId: z.string(),
    kind: MemoryKind,
    source: MemorySource,
    tainted: z.boolean(),
  }),
  /** Memories that entered the Run's context (offered at start, or found/read by a tool). */
  ev('memory.recalled', {
    memoryIds: z.array(z.string()),
    via: z.enum(['context', 'search', 'read']),
    tainted: z.boolean(),
  }),
  /** The post-run summary (after the Run ended; never changes its outcome). */
  ev('memory.summarized', {
    memoryId: nullableString,
    mode: z.enum(['result', 'triage']),
    model: nullableString,
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    costUsd: z.number().nonnegative().nullable(),
    error: nullableString,
  }),
  ev('feedback.recorded', {
    signal: FeedbackSignal,
    memoryId: nullableString,
    approvalId: nullableString,
    by: z.string(),
  }),
  /** This Run handed a task to a peer Bot; the child Run is `childRunId`. */
  ev('delegation.started', {
    childRunId: z.string(),
    childBotId: z.string(),
    childBotName: z.string(),
    task: z.string(),
  }),
  /** A child Run ended; its spend counts against this Run's budgets. */
  ev('delegation.finished', {
    childRunId: z.string(),
    childBotId: z.string(),
    status: z.enum(['completed', 'failed', 'cancelled']),
    result: z.string(),
    totals: DelegationTotals,
  }),
  ev('diagnostic', { level: z.enum(['info', 'warn', 'error']), message: z.string() }),
  /** Engine message Orbit does not model yet; kept so nothing is silently dropped. */
  ev('raw', { messageType: z.string(), subtype: nullableString }),
  // ── terminal (exactly one per driver run) ──────────────────────────────
  ev('run.completed', {
    result: z.string(),
    stopReason: nullableString,
    sessionId: nullableString,
    permissionDenials: z.array(PermissionDenial),
  }),
  ev('run.failed', {
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    sessionId: nullableString,
  }),
  ev('run.cancelled', { reason: z.string(), sessionId: nullableString }),
  ev('run.rate_limited', {
    resetsAt: z.iso.datetime().nullable(),
    limitType: nullableString,
    message: z.string(),
    sessionId: nullableString,
  }),
]);
export type RunEventBody = z.infer<typeof RunEventBody>;
export type RunEventType = RunEventBody['type'];
export type RunEventOf<T extends RunEventType> = Extract<RunEventBody, { type: T }>;

/** Events that end a driver segment (the orchestrator may turn one into run.parked or run.paused). */
export const TERMINAL_EVENT_TYPES = [
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.rate_limited',
  'run.parked',
  'run.paused',
] as const satisfies readonly RunEventType[];
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

export function isTerminalEvent(
  e: RunEventBody,
): e is Extract<RunEventBody, { type: TerminalEventType }> {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(e.type);
}

export const RunEventEnvelope = z.object({
  /** Global, monotonically increasing; used as the SSE Last-Event-ID. */
  id: z.int().positive(),
  runId: z.string(),
  botId: z.string(),
  /** Per-run sequence number starting at 1. */
  seq: z.int().positive(),
  ts: z.iso.datetime(),
});
export type RunEventEnvelope = z.infer<typeof RunEventEnvelope>;

export const RunEvent = z.intersection(RunEventEnvelope, RunEventBody);
export type RunEvent = RunEventEnvelope & RunEventBody;

export type RunEventBodyInput = z.input<typeof RunEventBody>;
export type RunEventInputOf<T extends RunEventType> = Extract<RunEventBodyInput, { type: T }>;

/**
 * Build a validated event body (defaults applied). Throws on invalid data, so
 * malformed events fail where they are created rather than at persistence.
 */
export function event<T extends RunEventType>(
  type: T,
  data: RunEventInputOf<T>['data'],
): RunEventOf<T> {
  return RunEventBody.parse({ type, data }) as RunEventOf<T>;
}
