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

/**
 * Run the tool-result handler. Fails closed: if Orbit cannot post-process a
 * result (redaction may not have happened), the engine is stopped before the
 * model sees it.
 */
export async function postProcess(
  handler: ToolResultHandler | undefined,
  request: ToolResultRequest,
): Promise<ToolResultDecision> {
  if (!handler) return {};
  try {
    return await handler(request);
  } catch {
    return { stop: 'Orbit could not post-process a tool result; the run was stopped' };
  }
}

export type PostHookEvent = 'PostToolUse' | 'PostToolUseFailure';

/**
 * PostToolUse / PostToolUseFailure hook output understood by both the CLI and
 * the SDK. A failed tool's error cannot be rewritten (the engine has no
 * `updatedToolOutput` for failures), so `stop` is the only way to keep it from
 * the model: `continue: false` ends the engine before its next turn.
 */
export function postHookOutput(
  d: ToolResultDecision,
  hookEventName: PostHookEvent = 'PostToolUse',
): Record<string, unknown> {
  const stop = d.stop !== undefined ? { continue: false, stopReason: d.stop } : {};
  const updated = hookEventName === 'PostToolUse' ? d.updatedOutput : undefined;
  if (updated === undefined && d.additionalContext === undefined) return stop;
  return {
    ...stop,
    hookSpecificOutput: {
      hookEventName,
      ...(updated !== undefined ? { updatedToolOutput: updated } : {}),
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
