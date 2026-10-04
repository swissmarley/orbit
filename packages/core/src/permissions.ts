/** A tool call the engine wants to make, as seen by Orbit's permission layer. */
export interface ToolPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
  /** Non-null when a subagent (Task/Agent tool) requests the tool. */
  parentToolUseId: string | null;
}

import type { Tier } from './enums';

/** Where a decision came from; recorded on the permission.decision event. */
export interface DecisionMeta {
  tier?: Tier | null;
  ruleId?: string | null;
  approvalId?: string | null;
}

export type ToolPermissionDecision =
  | ({ behavior: 'allow'; reason: string; updatedInput?: Record<string, unknown> } & DecisionMeta)
  | ({
      behavior: 'deny';
      reason: string;
      /** Stop the engine after this denial (Run parks, or a budget/kill switch fired). */
      interrupt?: boolean;
    } & DecisionMeta);

/** A tool finished; Orbit may rewrite its output before the model sees it. */
export interface ToolResultRequest {
  toolName: string;
  toolUseId: string | null;
  input: Record<string, unknown>;
  /** Output on success; the error text when the tool failed (`isError`). */
  response: unknown;
  /** The tool failed (PostToolUseFailure): its error cannot be rewritten, only stopped. */
  isError?: boolean;
}

export interface ToolResultDecision {
  /** Replacement output (same shape as `response`), e.g. with secrets redacted. */
  updatedOutput?: unknown;
  /** Extra context for the model, e.g. "this content is untrusted". */
  additionalContext?: string;
  /** Stop the engine before the model sees this result (fail closed); the reason. */
  stop?: string;
}

export type ToolResultHandler = (request: ToolResultRequest) => Promise<ToolResultDecision>;

/**
 * Decides every tool call. Both drivers route PreToolUse through this
 * function so that one policy engine and one approval queue govern all Runs
 * (ADR-003). Must resolve (never hang forever) and must fail closed.
 */
export type PermissionHandler = (
  request: ToolPermissionRequest,
  signal: AbortSignal,
) => Promise<ToolPermissionDecision>;
