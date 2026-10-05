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
/** Verbs that move money or commit to spending it, wherever they appear in the name. */
const FINANCIAL_VERBS = [
  'pay',
  'purchase',
  'buy',
  'sell',
  'transfer',
  'charge',
  'capture',
  'refund',
  'withdraw',
  'trade',
  'checkout',
  'wire',
  'payout',
  'subscribe',
  'donate',
  'tip',
  'bid',
  'book',
];
/** Nouns that make a send/create/approve action financial (send_payment, approve_transaction). */
const FINANCIAL_NOUNS = [
  'payment',
  'payments',
  'order',
  'orders',
  'funds',
  'money',
  'remittance',
  'transaction',
  'transactions',
  'invoice',
  'invoices',
  'stock',
  'stocks',
  'shares',
  'crypto',
];
/** Verbs that commit a financial noun (approve_transaction, finalize_invoice, create_order). */
const COMMIT_VERBS = [
  'create',
  'place',
  'make',
  'submit',
  'execute',
  'approve',
  'finalize',
  'confirm',
  'issue',
];
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
/** Unambiguous mutating verbs: any of them disqualifies READ (and drafting, except create/save/update/edit). */
const MUTATING_VERBS = [
  ...SEND_VERBS,
  'update',
  'create',
  'set',
  'add',
  'insert',
  'modify',
  'edit',
  'upsert',
  'write',
  'replace',
  'apply',
  'execute',
  'exec',
  'run',
  'call',
  'invoke',
  'schedule',
  'approve',
  'reject',
  'cancel',
  'close',
  'archive',
  'move',
  'rename',
  'assign',
  'enable',
  'disable',
  'start',
  'stop',
  'kill',
  'restart',
  'install',
  'grant',
  'revoke',
  'save',
  'put',
  'patch',
  'sync',
  'import',
  'commit',
  'push',
  'accept',
  'decline',
  'sign',
  'place',
  'make',
  'unsubscribe',
  'mute',
  'block',
  'ban',
];
const DRAFT_HELPER_VERBS = ['create', 'save', 'update', 'edit'];
/** Joining words mean a compound action; compound names are never READ or WRITE_LOCAL. */
const CONJUNCTIONS = ['and', 'or', 'then', 'plus', 'also'];
/** Leading verbs that only read ("query" is not one: it often runs arbitrary statements). */
const READ_VERBS = [
  'get',
  'list',
  'search',
  'read',
  'fetch',
  'find',
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
  /** Sends Bot-chosen data to arbitrary hosts (like WebFetch): asks in a tainted Run. */
  egress?: boolean;
}

export interface Classification {
  tier: Tier;
  /** Name of the untrusted source when the tool returns third-party content. */
  untrustedSource: string | null;
  /** How the tier was determined (shown on approval cards). */
  basis: 'builtin' | 'shell' | 'override' | 'heuristic' | 'default';
  /** Bot-chosen arguments can reach arbitrary hosts (WebFetch, plugin egress tools). */
  egress?: boolean;
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
      return {
        tier: o.tier,
        untrustedSource: untrusted ? name : null,
        basis: 'override',
        ...(o.egress ? { egress: true } : {}),
      };
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
    // Shell output can contain anything fetched from anywhere: allowed calls taint.
    return {
      tier: opts.shellContained ? 'WRITE_LOCAL' : 'EXTERNAL',
      untrustedSource: name,
      basis: 'shell',
    };
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!mcp) return null;
  const toolWords = words(mcp[2] ?? '');
  const has = (verbs: readonly string[]) => toolWords.some((w) => verbs.includes(w));
  // Every MCP tool's output comes from a third-party system: allowed calls taint the Run.
  const base = { untrustedSource: name };
  const first = toolWords[0] ?? '';
  const compound = has(CONJUNCTIONS);
  const sends = has(SEND_VERBS) || LEADING_SEND_VERBS.includes(first);
  const financialNoun = has(FINANCIAL_NOUNS);
  const mutatingWords = toolWords.filter((w) => MUTATING_VERBS.includes(w));
  // Ambiguity always resolves to the riskier tier (ADR-009):
  //   prepare_and_pay_invoice, lookup_then_book_flight  → FINANCIAL (money verb anywhere)
  //   approve_transaction, create_order, send_payment   → FINANCIAL (commit/send + financial noun)
  //   get_post, read_email, list_orders                 → READ (leading read verb, nothing else)
  //   get_or_create_issue, search_and_replace           → EXTERNAL (compound / mutating)
  //   create_draft, prepare_payment, draft_reply        → WRITE_LOCAL (only prepares)
  //   schedule_draft, compose_and_send_email, query     → EXTERNAL
  if (has(FINANCIAL_VERBS)) return { ...base, tier: 'FINANCIAL', basis: 'heuristic' };
  if (financialNoun && (sends || COMMIT_VERBS.includes(first) || has(COMMIT_VERBS))) {
    return { ...base, tier: 'FINANCIAL', basis: 'heuristic' };
  }
  if (READ_VERBS.includes(first) && !compound && !sends && mutatingWords.length === 0) {
    return { ...base, tier: 'READ', basis: 'heuristic' };
  }
  if (sends) return { ...base, tier: 'EXTERNAL', basis: 'heuristic' };
  const drafts = has(DRAFT_VERBS);
  if (drafts && !compound && mutatingWords.every((w) => DRAFT_HELPER_VERBS.includes(w))) {
    return { ...base, tier: 'WRITE_LOCAL', basis: 'heuristic' };
  }
  return {
    ...base,
    tier: 'EXTERNAL',
    basis: mutatingWords.length || compound ? 'heuristic' : 'default',
  };
}

const TIER_RANK: Readonly<Record<Tier, number>> = {
  READ: 0,
  WRITE_LOCAL: 1,
  EXTERNAL: 2,
  FINANCIAL: 3,
};

/** The riskier of two tiers. */
export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * Words that make a plugin tool at least EXTERNAL wherever they appear: a
 * plugin runs outside the Bot's sandbox, so writing, creating, changing,
 * running or clicking anything there leaves it (M7 safety review M2).
 */
const PLUGIN_EXTERNAL_VERBS = [
  ...MUTATING_VERBS.filter(
    (v) =>
      ![
        'commit',
        'run',
        'call',
        'move',
        'close',
        'start',
        'stop',
        'sync',
        'import',
        'make',
        'place',
      ].includes(v),
  ),
  'push',
  'click',
  'fill',
  'press',
  'submit',
  'upload',
  'drop',
  'kick',
  'pin',
  'react',
  'transfer',
];
/**
 * Words that are verbs when they lead the name or another word follows them
 * (`post_message`, `chat_postMessage`, `run_query`) and nouns when they end
 * it (`get_post`, `list_comment`, `get_run`).
 */
const PLUGIN_EXTERNAL_UNLESS_LAST = [
  'post',
  'reply',
  'respond',
  'comment',
  'message',
  'email',
  'dm',
  'run',
  'call',
  'move',
  'close',
  'start',
  'stop',
  'sync',
  'import',
  'type',
  'select',
  'navigate',
  'make',
  'place',
];
/** Names made only of these words are reads (`git_status`, `git_log`, `ping`, `echo`). */
const PLUGIN_READ_WORDS = [
  'git',
  'status',
  'diff',
  'log',
  'logs',
  'history',
  'info',
  'version',
  'health',
  'ping',
  'echo',
  'whoami',
];
/** Whole names that read (a browser opening a page; its egress flag still applies). */
const PLUGIN_READ_PHRASES = ['open page', 'open url'];
/** Local-only effects a plugin may declare as WRITE_LOCAL (a git commit in the Bot's worktree). */
const PLUGIN_LOCAL_VERBS = ['commit'];

/**
 * The lowest tier a declared (plugin) tier may give a tool, from its name
 * alone (ADR-014): a money-moving name stays FINANCIAL; a name that sends,
 * writes, creates, changes, runs or clicks anything stays at least EXTERNAL
 * (plugins run outside the Bot's sandbox); drafting stays at least
 * WRITE_LOCAL, and so does a git commit. Only names that read like reads (a
 * leading read verb, or read-only words such as `git_status`) may be declared
 * READ; every other name floors at EXTERNAL. Manifests remove the heuristics'
 * false positives (ADR-009), never lower an action.
 */
export function tierFloor(toolName: string): Tier {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(toolName);
  const toolWords = words(m?.[1] ?? toolName);
  const has = (verbs: readonly string[]) => toolWords.some((w) => verbs.includes(w));
  if (has(FINANCIAL_VERBS)) return 'FINANCIAL';
  const sends = has(SEND_VERBS) || LEADING_SEND_VERBS.includes(toolWords[0] ?? '');
  if (has(FINANCIAL_NOUNS) && (sends || has(COMMIT_VERBS))) return 'FINANCIAL';
  if (sends) return 'EXTERNAL';
  const actions = toolWords.filter(
    (w, i) =>
      PLUGIN_EXTERNAL_VERBS.includes(w) ||
      (PLUGIN_EXTERNAL_UNLESS_LAST.includes(w) && (i === 0 || i < toolWords.length - 1)),
  );
  if (actions.length > 0) {
    const draftsOnly =
      has(DRAFT_VERBS) &&
      !has(CONJUNCTIONS) &&
      actions.every((w) => [...DRAFT_HELPER_VERBS, 'write'].includes(w));
    return draftsOnly ? 'WRITE_LOCAL' : 'EXTERNAL';
  }
  // `list_drafts`, `get_preview`: a leading read verb makes the draft word a noun.
  const drafting = has(DRAFT_VERBS) && !READ_VERBS.includes(toolWords[0] ?? '');
  if (drafting || (has(['git']) && has(PLUGIN_LOCAL_VERBS))) return 'WRITE_LOCAL';
  // READ only for names that read like reads; no list of bad words can be
  // complete (`rm`, `eval`, `sql`, `trigger_workflow`…), so anything else is
  // EXTERNAL (M7 safety re-review M1).
  const phrase = toolWords.join(' ');
  const readLike =
    !has(CONJUNCTIONS) &&
    (READ_VERBS.includes(toolWords[0] ?? '') ||
      (toolWords.length > 0 && toolWords.every((w) => PLUGIN_READ_WORDS.includes(w))) ||
      PLUGIN_READ_PHRASES.includes(phrase));
  return readLike ? 'READ' : 'EXTERNAL';
}

/** A plugin's declared tier, raised to the floor its name sets. */
export function effectivePluginTier(
  toolName: string,
  declared: Tier,
): { tier: Tier; raised: boolean } {
  const tier = maxTier(declared, tierFloor(toolName));
  return { tier, raised: tier !== declared };
}
