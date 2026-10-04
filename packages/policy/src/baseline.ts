import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { PermissionHandler, ToolPermissionDecision } from '@orbit/core';

/** Built-in engine tools that only read. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'Task',
  'Agent',
]);

/** Built-in engine tools that write files (allowed only inside the workspace). */
export const LOCAL_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/** Resolve symlinks of the longest existing prefix so links cannot escape the workspace. */
function realish(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export function isInside(root: string, target: string): boolean {
  const base = realish(resolve(root));
  const abs = realish(isAbsolute(target) ? target : resolve(root, target));
  const rel = relative(base, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function filePathOf(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Baseline default-deny policy (M1): read-only tools are allowed, file
 * writes are allowed only inside the Bot's workspace, and everything else —
 * shell, network, MCP tools, unknown tools — is denied. M2's tiered policy
 * engine and approval queue build on the same PermissionHandler contract.
 */
export function baselinePolicy(workspace: string): PermissionHandler {
  return (request) => {
    const { toolName, input } = request;
    let decision: ToolPermissionDecision;
    if (READ_TOOLS.has(toolName)) {
      decision = {
        behavior: 'allow',
        reason:
          toolName === 'Task' || toolName === 'Agent'
            ? 'Delegation to a subagent (its tool calls are checked too)'
            : 'Read-only tool',
      };
    } else if (LOCAL_WRITE_TOOLS.has(toolName)) {
      const path = filePathOf(input);
      decision =
        path && isInside(workspace, path)
          ? { behavior: 'allow', reason: 'File write inside the Bot workspace' }
          : {
              behavior: 'deny',
              reason: `Writes outside the Bot workspace are not allowed (${path ?? 'no path'})`,
            };
    } else {
      decision = {
        behavior: 'deny',
        reason: `${toolName} is not permitted by the default-deny policy`,
      };
    }
    return Promise.resolve(decision);
  };
}
