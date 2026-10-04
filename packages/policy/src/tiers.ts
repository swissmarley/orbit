import type { Tier } from '@orbit/core';

/** Built-in engine tools with a fixed tier. Anything not listed (and not MCP) is denied. */
const BUILTIN: Readonly<Record<string, Tier>> = {
  Read: 'READ',
  Glob: 'READ',
  Grep: 'READ',
  LS: 'READ',
  NotebookRead: 'READ',
  TodoWrite: 'READ',
  Task: 'READ',
  Agent: 'READ',
  WebSearch: 'READ',
  WebFetch: 'READ',
  Write: 'WRITE_LOCAL',
  Edit: 'WRITE_LOCAL',
  MultiEdit: 'WRITE_LOCAL',
  NotebookEdit: 'WRITE_LOCAL',
};

/** Shell tools: contained (sandboxed, no network) → WRITE_LOCAL, otherwise EXTERNAL. */
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash']);

/** Built-in tools whose output comes from outside the user's machine. */
const UNTRUSTED_BUILTINS = new Set(['WebFetch', 'WebSearch']);

const DRAFT_VERBS = ['draft', 'drafts', 'prepare', 'preview', 'compose', 'suggest'];
/** Verbs that move money, wherever they appear in the name. */
const FINANCIAL_VERBS = [
  'pay',
  'purchase',
  'buy',
  'transfer',
  'charge',
  'refund',
  'withdraw',
  'trade',
  'checkout',
  'wire',
  'payout',
  'subscribe',
];
/** Nouns that make a send/create/place action financial (send_payment, create_order). */
const FINANCIAL_NOUNS = ['payment', 'payments', 'order', 'orders', 'funds', 'money', 'remittance'];
/** Verbs whose effect leaves the sandbox, wherever they appear (compose_and_send_email). */
const SEND_VERBS = [
  'send',
  'publish',
  'submit',
  'deliver',
  'forward',
  'share',
  'tweet',
  'broadcast',
  'notify',
  'merge',
  'deploy',
  'delete',
  'remove',
  'invite',
  'upload',
];
/** Words that are verbs only when they lead the name (post_message vs get_post). */
const LEADING_SEND_VERBS = ['post', 'email', 'message', 'dm', 'reply', 'respond', 'comment'];
const COMMIT_VERBS = ['create', 'place', 'make', 'submit', 'execute'];
const READ_VERBS = [
  'get',
  'list',
  'search',
  'read',
  'fetch',
  'find',
  'query',
  'describe',
  'view',
  'lookup',
  'show',
  'count',
];

export interface ToolTierOverride {
  /** Glob over tool names, e.g. `mcp__gmail__create_draft` or `mcp__github__get_*`. */
  pattern: string;
  tier: Tier;
  /** Output of the tool is untrusted content (email bodies, web pages…). Default true for MCP. */
  untrusted?: boolean;
}

export interface Classification {
  tier: Tier;
  /** Name of the untrusted source when the tool returns third-party content. */
  untrustedSource: string | null;
  /** How the tier was determined (shown on approval cards). */
  basis: 'builtin' | 'shell' | 'override' | 'heuristic' | 'default';
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Assign a risk tier. Returns null for unknown non-MCP tools (default deny).
 * MCP tools (`mcp__<server>__<tool>`) use plugin-declared overrides first,
 * then verb heuristics on the tool name; anything ambiguous is EXTERNAL.
 */
export function classifyTool(
  name: string,
  opts: { shellContained: boolean; overrides?: readonly ToolTierOverride[] },
): Classification | null {
  for (const o of opts.overrides ?? []) {
    if (globToRegExp(o.pattern).test(name)) {
      const untrusted = o.untrusted ?? name.startsWith('mcp__');
      return { tier: o.tier, untrustedSource: untrusted ? name : null, basis: 'override' };
    }
  }
  const builtin = BUILTIN[name];
  if (builtin) {
    return {
      tier: builtin,
      untrustedSource: UNTRUSTED_BUILTINS.has(name) ? name : null,
      basis: 'builtin',
    };
  }
  if (SHELL_TOOLS.has(name)) {
    return {
      tier: opts.shellContained ? 'WRITE_LOCAL' : 'EXTERNAL',
      untrustedSource: null,
      basis: 'shell',
    };
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!mcp) return null;
  const toolWords = words(mcp[2] ?? '');
  const has = (verbs: readonly string[]) => toolWords.some((w) => verbs.includes(w));
  // Reads and drafts bring third-party content into the Run; the result of an
  // action (EXTERNAL/FINANCIAL) is just an acknowledgement and does not taint.
  const base = { untrustedSource: name };
  const ack = { untrustedSource: null };
  const first = toolWords[0] ?? '';
  const sends = has(SEND_VERBS) || LEADING_SEND_VERBS.includes(first);
  const financialNoun = has(FINANCIAL_NOUNS);
  // Order matters (any word can carry the riskiest meaning):
  //   prepare_and_pay_invoice, transfer_funds        → FINANCIAL (money-moving verb anywhere)
  //   get_order, read_email, get_post               → READ (leading read verb, nothing sent)
  //   send_payment, create_order                     → FINANCIAL (sending/creating a financial thing)
  //   send_draft, compose_and_send_email, post_message → EXTERNAL
  //   create_draft, prepare_payment, draft_reply     → WRITE_LOCAL (only prepares)
  if (has(FINANCIAL_VERBS)) return { ...ack, tier: 'FINANCIAL', basis: 'heuristic' };
  if (READ_VERBS.includes(first) && !sends) return { ...base, tier: 'READ', basis: 'heuristic' };
  if (sends) return { ...ack, tier: financialNoun ? 'FINANCIAL' : 'EXTERNAL', basis: 'heuristic' };
  if (COMMIT_VERBS.includes(first) && financialNoun)
    return { ...ack, tier: 'FINANCIAL', basis: 'heuristic' };
  if (has(DRAFT_VERBS)) return { ...base, tier: 'WRITE_LOCAL', basis: 'heuristic' };
  return { ...ack, tier: 'EXTERNAL', basis: 'default' };
}
