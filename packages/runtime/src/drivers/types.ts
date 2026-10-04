import type { AuthMethod, DriverKind, PermissionHandler, RunEventBody } from '@orbit/core';

export type { PermissionHandler, ToolPermissionDecision, ToolPermissionRequest } from '@orbit/core';

export interface DriverRunRequest {
  runId: string;
  prompt: string;
  /** Working directory = the Bot's workspace. */
  cwd: string;
  /** Model alias or ID (already resolved from bot → config defaults). */
  model: string | null;
  /** Bot goal + standing instructions appended to the engine's system prompt. */
  appendSystemPrompt: string | null;
  /** Built-in tools to expose; null = engine default. */
  tools: string[] | null;
  maxTurns: number | null;
  /** Engine session to resume (`--resume`). */
  resumeSessionId: string | null;
  /** Session id to assign to a new session (`--session-id`); ignored on resume. */
  sessionId: string | null;
  permission: PermissionHandler;
  signal: AbortSignal;
  /** MockDriver scenario. */
  mockFixture?: string | undefined;
}

/**
 * An AgentDriver executes one Run and streams normalized RunEvent bodies.
 * Contract (enforced by test/driver-contract.ts):
 *  - the stream ends with exactly one terminal event
 *    (run.completed | run.failed | run.cancelled | run.rate_limited)
 *  - a permission.decision follows its tool.call and precedes its tool.result
 *  - aborting `signal` yields run.cancelled promptly
 *  - the driver never throws from the iterator; failures become run.failed
 */
export interface AgentDriver {
  readonly kind: DriverKind;
  readonly authMethod: AuthMethod;
  run(request: DriverRunRequest): AsyncIterable<RunEventBody>;
}
