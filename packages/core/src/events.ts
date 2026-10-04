import { z } from 'zod';
import { AuthMethod, DriverKind } from './enums';

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
  kind: z.enum(['manual', 'cron', 'webhook', 'slack', 'file', 'git', 'delegation', 'resume']),
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

export const RunEventBody = z.discriminatedUnion('type', [
  // ── lifecycle (orchestrator) ────────────────────────────────────────────
  ev('run.queued', { trigger: TriggerRef, prompt: z.string() }),
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
  }),
  ev('subagent.started', {
    toolUseId: z.string(),
    agentType: nullableString,
    description: nullableString,
    parentToolUseId,
  }),
  ev('subagent.stopped', { toolUseId: z.string(), isError: z.boolean() }),
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

export const TERMINAL_EVENT_TYPES = [
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.rate_limited',
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

/** Helper for building event bodies with full type inference. */
export function event<T extends RunEventType>(type: T, data: RunEventOf<T>['data']): RunEventOf<T> {
  return { type, data } as RunEventOf<T>;
}
