import { type RunEventBody, event } from '@orbit/core';
import type { PermissionHandler, ToolPermissionDecision, ToolPermissionRequest } from './types';

/**
 * Call the permission handler, failing closed: any exception or invalid
 * answer becomes a deny. Returns the decision and its audit event.
 */
function isDecision(d: unknown): d is ToolPermissionDecision {
  if (typeof d !== 'object' || d === null) return false;
  const { behavior, reason } = d as Record<string, unknown>;
  return (behavior === 'allow' || behavior === 'deny') && typeof reason === 'string';
}

export async function decide(
  handler: PermissionHandler,
  request: ToolPermissionRequest,
  signal: AbortSignal,
): Promise<{ decision: ToolPermissionDecision; event: RunEventBody }> {
  let decision: ToolPermissionDecision;
  try {
    // Validate at runtime: handlers are pluggable and must fail closed.
    const d: unknown = await handler(request, signal);
    decision = isDecision(d)
      ? d
      : { behavior: 'deny', reason: 'Permission handler returned an invalid decision' };
  } catch (err) {
    decision = {
      behavior: 'deny',
      reason: `Permission check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    decision,
    event: event('permission.decision', {
      toolUseId: request.toolUseId,
      toolName: request.toolName,
      input:
        decision.behavior === 'allow' && decision.updatedInput
          ? decision.updatedInput
          : request.input,
      behavior: decision.behavior,
      reason: decision.reason,
    }),
  };
}

/** PreToolUse hook output understood by both the CLI and the SDK. */
export function hookOutput(decision: ToolPermissionDecision): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.behavior,
      permissionDecisionReason: decision.reason,
      ...(decision.behavior === 'allow' && decision.updatedInput
        ? { updatedInput: decision.updatedInput }
        : {}),
    },
  };
}

export const denyAll: PermissionHandler = () =>
  Promise.resolve({ behavior: 'deny', reason: 'No permission policy configured (default deny)' });
