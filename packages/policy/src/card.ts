import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Tier } from '@orbit/core';
import { createTwoFilesPatch } from 'diff';

/** Everything a human needs to decide, exactly as it will execute. */
export interface ApprovalCard {
  /** One-line description: "Send email to ada@example.com". */
  what: string;
  /** The Bot's own explanation (its last message before the call). */
  why: string;
  toolName: string;
  tier: Tier;
  /** Exact tool input. */
  payload: Record<string, unknown>;
  /** Unified diff for file changes; null otherwise. */
  diff: string | null;
  botId: string;
  botName: string;
  runId: string;
  /** Untrusted sources that influenced this Run before the call. */
  untrusted: string[];
  risk: string;
  /** Set when the Run was delegated by another Bot: who asked, top-level first. */
  delegatedBy: string | null;
}

const RISK: Record<Tier, string> = {
  READ: 'Reads data only.',
  WRITE_LOCAL: 'Changes files inside the Bot workspace.',
  EXTERNAL:
    'Has effects outside the sandbox (sends, posts, merges, deletes or contacts other systems).',
  FINANCIAL:
    'Moves money or is irreversible — Orbit never executes this; it can only be prepared for you.',
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function readExisting(path: string, workspace: string): string {
  const abs = isAbsolute(path) ? path : resolve(workspace, path);
  try {
    return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  } catch {
    return '';
  }
}

/** Literal replacement ($ patterns in new text are not special), like the engine's Edit. */
function applyEdit(text: string, oldS: string, newS: string, all: boolean): string {
  if (all) return text.split(oldS).join(newS);
  return text.replace(oldS, () => newS);
}

/** Unified diff for Write/Edit/MultiEdit; null for other tools. */
export function diffForTool(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
): string | null {
  const path = str(input.file_path);
  if (!path) return null;
  const before = readExisting(path, workspace);
  let after: string | null = null;
  if (toolName === 'Write') after = str(input.content);
  if (toolName === 'Edit') {
    const oldS = str(input.old_string) ?? '';
    const newS = str(input.new_string) ?? '';
    after = applyEdit(before, oldS, newS, input.replace_all === true);
  }
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    after = before;
    for (const e of input.edits as Record<string, unknown>[]) {
      after = applyEdit(
        after,
        str(e.old_string) ?? '',
        str(e.new_string) ?? '',
        e.replace_all === true,
      );
    }
  }
  if (after === null) return null;
  return createTwoFilesPatch(path, path, before, after, 'current', 'proposed', { context: 3 });
}

function describe(toolName: string, input: Record<string, unknown>): string {
  const path = str(input.file_path);
  if (path) return `${toolName} ${path}`;
  const command = str(input.command);
  if (command) return `Run \`${command.length > 120 ? `${command.slice(0, 117)}…` : command}\``;
  const to = str(input.to) ?? str(input.channel) ?? str(input.recipient);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const action = mcp ? `${mcp[2]?.replace(/_/g, ' ')} (${mcp[1]})` : toolName;
  return to ? `${action} → ${to}` : action;
}

export function buildApprovalCard(args: {
  toolName: string;
  input: Record<string, unknown>;
  tier: Tier;
  why: string | null;
  botId: string;
  botName: string;
  runId: string;
  workspace: string;
  untrusted: readonly string[];
  /** Delegation chain above this Run ("Inbox Bot › Research Bot"), if any. */
  delegatedBy?: string | null;
}): ApprovalCard {
  return {
    what: describe(args.toolName, args.input),
    why: args.why?.trim() ? args.why.trim() : 'The Bot did not explain this step.',
    toolName: args.toolName,
    tier: args.tier,
    payload: args.input,
    diff: diffForTool(args.toolName, args.input, args.workspace),
    botId: args.botId,
    botName: args.botName,
    runId: args.runId,
    untrusted: [...args.untrusted],
    risk:
      RISK[args.tier] + (args.untrusted.length ? ' Untrusted content influenced this Run.' : ''),
    delegatedBy: args.delegatedBy ?? null,
  };
}
