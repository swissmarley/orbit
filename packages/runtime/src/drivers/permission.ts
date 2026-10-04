import { type RunEventBody, event } from '@orbit/core';
import type {
  PermissionHandler,
  ToolPermissionDecision,
  ToolPermissionRequest,
  ToolResultDecision,
  ToolResultHandler,
  ToolResultRequest,
} from './types';

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
      tier: decision.tier ?? null,
      ruleId: decision.ruleId ?? null,
      approvalId: decision.approvalId ?? null,
    }),
  };
}

/** Run the tool-result handler, never failing the tool: errors mean "no change". */
export async function postProcess(
  handler: ToolResultHandler | undefined,
  request: ToolResultRequest,
): Promise<ToolResultDecision> {
  if (!handler) return {};
  try {
    return await handler(request);
  } catch {
    return {};
  }
}

/** PostToolUse hook output understood by both the CLI and the SDK. */
export function postHookOutput(d: ToolResultDecision): Record<string, unknown> {
  if (d.updatedOutput === undefined && d.additionalContext === undefined) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      ...(d.updatedOutput !== undefined ? { updatedToolOutput: d.updatedOutput } : {}),
      ...(d.additionalContext !== undefined ? { additionalContext: d.additionalContext } : {}),
    },
  };
}

/** PreToolUse hook output understood by both the CLI and the SDK. */
export function hookOutput(decision: ToolPermissionDecision): Record<string, unknown> {
  const stop =
    decision.behavior === 'deny' && decision.interrupt
      ? { continue: false, stopReason: decision.reason }
      : {};
  return {
    ...stop,
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
