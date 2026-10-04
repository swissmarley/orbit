/** A tool call the engine wants to make, as seen by Orbit's permission layer. */
export interface ToolPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
  /** Non-null when a subagent (Task/Agent tool) requests the tool. */
  parentToolUseId: string | null;
}

export type ToolPermissionDecision =
  | { behavior: 'allow'; reason: string; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; reason: string; interrupt?: boolean };

/**
 * Decides every tool call. Both drivers route PreToolUse through this
 * function so that one policy engine and one approval queue govern all Runs
 * (ADR-003). Must resolve (never hang forever) and must fail closed.
 */
export type PermissionHandler = (
  request: ToolPermissionRequest,
  signal: AbortSignal,
) => Promise<ToolPermissionDecision>;
