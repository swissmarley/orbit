import type { Tier } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import {
  type Classification,
  type ToolTierOverride,
  classifyTool,
  effectivePluginTier,
  globToRegExp,
  tierFloor,
} from './tiers';

const contained = { shellContained: true } as const;
const open = { shellContained: false } as const;

describe('globToRegExp', () => {
  it.each<[string, string, string, boolean]>([
    ['exact name matches itself', 'Read', 'Read', true],
    ['exact name does not match a longer name', 'Read', 'ReadMore', false],
    ['star matches any suffix', 'mcp__github__get_*', 'mcp__github__get_issue', true],
    ['star matches the empty string', 'mcp__github__get_*', 'mcp__github__get_', true],
    [
      'star does not change the fixed prefix',
      'mcp__github__get_*',
      'mcp__gitlab__get_issue',
      false,
    ],
    ['question mark matches exactly one char', 'Kill?hell', 'KillShell', true],
    ['question mark does not match zero chars', 'Kill?hell', 'Killhell', false],
    ['dot is literal, not "any char"', 'a.b', 'axb', false],
    ['dot matches a literal dot', '*@mycompany.com', 'ada@mycompany.com', true],
    [
      'anchored: no match on lookalike domain suffix',
      '*@mycompany.com',
      'ada@mycompany.com.evil',
      false,
    ],
    ['regex metachars are literal', 'a+(b)|[c]', 'a+(b)|[c]', true],
    ['regex metachars do not act as regex', 'a+', 'aaa', false],
  ])('%s', (_name, glob, value, expected) => {
    expect(globToRegExp(glob).test(value)).toBe(expected);
  });
});

describe('classifyTool: built-in tools', () => {
  it.each<[string, Tier, string | null]>([
    ['Read', 'READ', null],
    ['Glob', 'READ', null],
    ['Grep', 'READ', null],
    ['LS', 'READ', null],
    ['NotebookRead', 'READ', null],
    ['TodoWrite', 'READ', null],
    ['Task', 'READ', null],
    ['Agent', 'READ', null],
    ['WebSearch', 'READ', 'WebSearch'],
    ['WebFetch', 'READ', 'WebFetch'],
    ['Write', 'WRITE_LOCAL', null],
    ['Edit', 'WRITE_LOCAL', null],
    ['MultiEdit', 'WRITE_LOCAL', null],
    ['NotebookEdit', 'WRITE_LOCAL', null],
  ])('%s → %s (untrusted source: %s)', (name, tier, untrusted) => {
    // Built-in tiers must not depend on shell containment.
    for (const opts of [contained, open]) {
      expect(classifyTool(name, opts)).toEqual<Classification>({
        tier,
        untrustedSource: untrusted,
        basis: 'builtin',
      });
    }
  });
});

describe('classifyTool: shell tools', () => {
  it.each<[string, string, boolean, Tier]>([
    ['sandboxed Bash with no network is a local change', 'Bash', true, 'WRITE_LOCAL'],
    ['un-sandboxed Bash can reach the world', 'Bash', false, 'EXTERNAL'],
    ['sandboxed BashOutput', 'BashOutput', true, 'WRITE_LOCAL'],
    ['un-sandboxed BashOutput', 'BashOutput', false, 'EXTERNAL'],
    ['sandboxed KillShell', 'KillShell', true, 'WRITE_LOCAL'],
    ['un-sandboxed KillBash', 'KillBash', false, 'EXTERNAL'],
  ])('%s: %s (contained=%s) → %s', (_scenario, name, shellContained, tier) => {
    expect(classifyTool(name, { shellContained })).toEqual<Classification>({
      tier,
      untrustedSource: name,
      basis: 'shell',
    });
  });
});

describe('classifyTool: unknown non-MCP tools are default-deny (null)', () => {
  it.each([
    ['made-up tool', 'LaunchMissiles'],
    ['empty name', ''],
    ['wrong case of a built-in', 'read'],
    ['wrong case of the shell', 'bash'],
    ['single-underscore mcp lookalike', 'mcp_gmail_send_email'],
    ['mcp prefix without a tool part', 'mcp__gmail'],
    ['mcp prefix with an empty tool part', 'mcp__gmail__'],
  ])('%s (%j) → null', (_scenario, name) => {
    expect(classifyTool(name, contained)).toBeNull();
    expect(classifyTool(name, open)).toBeNull();
  });
});

describe('classifyTool: MCP verb heuristics', () => {
  it.each<[string, string, Tier, Classification['basis']]>([
    // READ: leading read verb
    ['reading a GitHub issue', 'mcp__github__get_issue', 'READ', 'heuristic'],
    ['listing Gmail labels', 'mcp__gmail__list_labels', 'READ', 'heuristic'],
    ['searching Slack', 'mcp__slack__search_messages', 'READ', 'heuristic'],
    ['camelCase read verb', 'mcp__github__getPullRequest', 'READ', 'heuristic'],
    ['server name with underscores', 'mcp__google_drive__list_files', 'READ', 'heuristic'],
    // WRITE_LOCAL: drafting is not sending
    ['creating a Gmail draft', 'mcp__gmail__create_draft', 'WRITE_LOCAL', 'heuristic'],
    ['drafting a reply', 'mcp__gmail__draft_reply', 'WRITE_LOCAL', 'heuristic'],
    [
      'preparing (not making) a payment',
      'mcp__stripe__prepare_payment',
      'WRITE_LOCAL',
      'heuristic',
    ],
    ['camelCase draft noun', 'mcp__gmail__createDraft', 'WRITE_LOCAL', 'heuristic'],
    ['saving a draft', 'mcp__gmail__save_draft', 'WRITE_LOCAL', 'heuristic'],
    [
      'leading draft verb beats a financial noun',
      'mcp__stripe__draft_payment',
      'WRITE_LOCAL',
      'heuristic',
    ],
    [
      'composing (not sending) a message',
      'mcp__slack__compose_message',
      'WRITE_LOCAL',
      'heuristic',
    ],
    // EXTERNAL via send-type verbs (basis 'heuristic')
    ['sending an email', 'mcp__gmail__send_email', 'EXTERNAL', 'heuristic'],
    ['camelCase send', 'mcp__gmail__sendEmail', 'EXTERNAL', 'heuristic'],
    ['posting to Slack', 'mcp__slack__post_message', 'EXTERNAL', 'heuristic'],
    ['merging a PR', 'mcp__github__merge_pull_request', 'EXTERNAL', 'heuristic'],
    ['deleting a file', 'mcp__drive__delete_file', 'EXTERNAL', 'heuristic'],
    [
      'sending an existing Gmail draft (drafts.send)',
      'mcp__gmail__send_draft',
      'EXTERNAL',
      'heuristic',
    ],
    ['publishing a draft post', 'mcp__blog__publish_draft', 'EXTERNAL', 'heuristic'],
    ['send verb beats a leading read verb', 'mcp__x__get_and_send_report', 'EXTERNAL', 'heuristic'],
    // EXTERNAL by default: anything not recognised
    ['creating an issue', 'mcp__github__create_issue', 'EXTERNAL', 'heuristic'],
    [
      'read verb not in leading position is not a read',
      'mcp__crm__update_list',
      'EXTERNAL',
      'heuristic',
    ],
    ['unrecognised verb is EXTERNAL, not READ', 'mcp__x__frobnicate', 'EXTERNAL', 'default'],
    // FINANCIAL: money moves
    ['paying an invoice', 'mcp__stripe__pay_invoice', 'FINANCIAL', 'heuristic'],
    ['transferring funds', 'mcp__bank__transfer_funds', 'FINANCIAL', 'heuristic'],
    ['purchasing an item', 'mcp__shop__purchase_item', 'FINANCIAL', 'heuristic'],
    ['sending a payment', 'mcp__paypal__send_payment', 'FINANCIAL', 'heuristic'],
    ['creating an order', 'mcp__shop__create_order', 'FINANCIAL', 'heuristic'],
    ['camelCase financial verb', 'mcp__shop__purchaseItem', 'FINANCIAL', 'heuristic'],
    [
      'financial beats a leading read verb',
      'mcp__shop__get_and_pay_invoice',
      'FINANCIAL',
      'heuristic',
    ],
  ])('%s: %s → %s', (_scenario, name, tier, basis) => {
    // Reads and drafts bring third-party content in (untrusted); action results do not.
    expect(classifyTool(name, contained)).toEqual<Classification>({
      tier,
      // Every allowed MCP call brings third-party output into the Run (ADR-009).
      untrustedSource: name,
      basis,
    });
  });

  it('MCP heuristics do not depend on shell containment', () => {
    expect(classifyTool('mcp__gmail__send_email', open)?.tier).toBe('EXTERNAL');
    expect(classifyTool('mcp__gmail__send_email', contained)?.tier).toBe('EXTERNAL');
  });

  // BUG (reported): a LEADING draft verb wins over every later verb, so a tool
  // that prepares AND sends/pays in one call is WRITE_LOCAL and auto-allowed.
  // PLAN.md §2.6: send-type tools are EXTERNAL; FINANCIAL is always handed back.
  it.each<[string, string, Tier]>([
    ['compose-and-send in one call', 'mcp__mail__compose_and_send_email', 'EXTERNAL'],
    ['draft-and-publish in one call', 'mcp__blog__draft_and_publish_post', 'EXTERNAL'],
    ['prepare-and-pay in one call', 'mcp__billing__prepare_and_pay_invoice', 'FINANCIAL'],
  ])('%s: %s → %s, not WRITE_LOCAL', (_scenario, name, tier) => {
    expect(classifyTool(name, contained)?.tier).toBe(tier);
  });

  // BUG (reported): "message"/"email"/"post" are in SEND_VERBS, but they are
  // also the nouns of plain reads, which now classify as EXTERNAL (approval
  // needed) instead of READ, e.g. every Inbox Triage read of a message.
  it.each([
    ['reading one Gmail message', 'mcp__gmail__get_message'],
    ['reading an email', 'mcp__mail__read_email'],
    ['fetching a blog post', 'mcp__blog__get_post'],
  ])('%s (%s) is READ', (_scenario, name) => {
    expect(classifyTool(name, contained)?.tier).toBe('READ');
  });
});

describe('classifyTool: overrides', () => {
  const overrides: ToolTierOverride[] = [
    { pattern: 'mcp__gmail__create_draft', tier: 'EXTERNAL' },
    { pattern: 'mcp__github__get_*', tier: 'READ', untrusted: false },
    { pattern: 'mcp__notes__*', tier: 'WRITE_LOCAL' },
    { pattern: 'mcp__ledger__*', tier: 'FINANCIAL' },
    { pattern: 'Read', tier: 'EXTERNAL' },
    { pattern: 'WebFetch', tier: 'EXTERNAL' },
    { pattern: 'Bash', tier: 'READ', untrusted: true },
    { pattern: 'MyLocalTool', tier: 'READ' },
  ];

  it.each<[string, string, Tier, string | null]>([
    [
      'override beats the draft heuristic',
      'mcp__gmail__create_draft',
      'EXTERNAL',
      'mcp__gmail__create_draft',
    ],
    [
      'glob override with untrusted: false clears the source',
      'mcp__github__get_issue',
      'READ',
      null,
    ],
    [
      'MCP override defaults to untrusted',
      'mcp__notes__send_everything',
      'WRITE_LOCAL',
      'mcp__notes__send_everything',
    ],
    [
      'plugin marks a whole server FINANCIAL (beats the read heuristic)',
      'mcp__ledger__list_entries',
      'FINANCIAL',
      'mcp__ledger__list_entries',
    ],
    ['override beats a built-in tier; non-MCP defaults to trusted', 'Read', 'EXTERNAL', null],
    ['override on WebFetch without untrusted flag is NOT untrusted', 'WebFetch', 'EXTERNAL', null],
    ['override beats shell containment and can mark untrusted', 'Bash', 'READ', 'Bash'],
    ['override can admit an otherwise-unknown local tool', 'MyLocalTool', 'READ', null],
  ])('%s: %s → %s', (_scenario, name, tier, untrusted) => {
    for (const opts of [
      { shellContained: true, overrides },
      { shellContained: false, overrides },
    ]) {
      expect(classifyTool(name, opts)).toEqual<Classification>({
        tier,
        untrustedSource: untrusted,
        basis: 'override',
      });
    }
  });

  it('first matching override wins', () => {
    const cls = classifyTool('mcp__x__send', {
      shellContained: true,
      overrides: [
        { pattern: 'mcp__x__*', tier: 'READ' },
        { pattern: 'mcp__x__send', tier: 'EXTERNAL' },
      ],
    });
    expect(cls?.tier).toBe('READ');
  });

  it('non-matching overrides fall through to the normal classifier', () => {
    expect(classifyTool('mcp__gmail__send_email', { shellContained: true, overrides })).toEqual({
      tier: 'EXTERNAL',
      untrustedSource: 'mcp__gmail__send_email',
      basis: 'heuristic',
    });
    expect(classifyTool('LaunchMissiles', { shellContained: true, overrides })).toBeNull();
  });
});

describe('classifyTool: compound and ambiguous names resolve to the riskier tier (M2 review H3)', () => {
  it.each<[string, Tier]>([
    ['mcp__gh__get_or_create_issue', 'EXTERNAL'],
    ['mcp__crm__fetch_and_update_record', 'EXTERNAL'],
    ['mcp__docs__search_and_replace', 'EXTERNAL'],
    ['mcp__mail__read_and_reply', 'EXTERNAL'],
    ['mcp__forum__list_and_post', 'EXTERNAL'],
    ['mcp__mail__compose_and_schedule_email', 'EXTERNAL'],
    ['mcp__x__prepare_and_execute', 'EXTERNAL'],
    ['mcp__x__suggest_and_apply', 'EXTERNAL'],
    ['mcp__mail__schedule_draft', 'EXTERNAL'],
    ['mcp__db__query', 'EXTERNAL'],
    ['mcp__travel__lookup_then_book_flight', 'FINANCIAL'],
    ['mcp__stripe__capture_payment_intent', 'FINANCIAL'],
    ['mcp__broker__sell_stock', 'FINANCIAL'],
    ['mcp__charity__donate', 'FINANCIAL'],
    ['mcp__social__tip_user', 'FINANCIAL'],
    ['mcp__travel__book_flight', 'FINANCIAL'],
    ['mcp__bank__approve_transaction', 'FINANCIAL'],
    ['mcp__auction__place_bid', 'FINANCIAL'],
    ['mcp__billing__finalize_invoice', 'FINANCIAL'],
    // positive controls
    ['mcp__gmail__get_message', 'READ'],
    ['mcp__blog__get_post', 'READ'],
    ['mcp__shop__list_orders', 'READ'],
    ['mcp__gmail__create_draft', 'WRITE_LOCAL'],
    ['mcp__gmail__draft_reply', 'WRITE_LOCAL'],
    ['mcp__billing__prepare_payment', 'WRITE_LOCAL'],
  ])('%s → %s', (name, tier) => {
    expect(classifyTool(name, { shellContained: false })?.tier).toBe(tier);
  });
});

describe('plugin tier floors (ADR-014)', () => {
  it.each<[string, Tier, Tier, boolean]>([
    // A manifest may remove false positives…
    ['mcp__github__git_status', 'READ', 'READ', false],
    ['mcp__github__git_commit', 'WRITE_LOCAL', 'WRITE_LOCAL', false],
    ['mcp__gmail__create_draft', 'WRITE_LOCAL', 'WRITE_LOCAL', false],
    ['mcp__filesystem__write_file', 'EXTERNAL', 'EXTERNAL', false],
    // …but never lower a sending or money-moving name.
    ['mcp__gmail__send_draft', 'WRITE_LOCAL', 'EXTERNAL', true],
    ['mcp__slack__post_message', 'READ', 'EXTERNAL', true],
    ['mcp__github__merge_pull_request', 'WRITE_LOCAL', 'EXTERNAL', true],
    ['mcp__shop__get_and_pay_invoice', 'READ', 'FINANCIAL', true],
    ['mcp__bank__create_payment', 'EXTERNAL', 'FINANCIAL', true],
    ['mcp__x__send_payment', 'EXTERNAL', 'FINANCIAL', true],
    // A plugin runs outside the sandbox: writing, creating, running or clicking
    // anything is at least EXTERNAL, whatever the manifest says (M7 review M2).
    ['mcp__github__git_push', 'READ', 'EXTERNAL', true],
    ['mcp__slack__chat_postMessage', 'READ', 'EXTERNAL', true],
    ['mcp__github__create_issue', 'READ', 'EXTERNAL', true],
    ['mcp__filesystem__write_file', 'WRITE_LOCAL', 'EXTERNAL', true],
    ['mcp__db__execute_sql', 'READ', 'EXTERNAL', true],
    ['mcp__db__run_query', 'READ', 'EXTERNAL', true],
    ['mcp__google__create_event', 'WRITE_LOCAL', 'EXTERNAL', true],
    ['mcp__browser__click', 'READ', 'EXTERNAL', true],
    ['mcp__browser__fill_form', 'READ', 'EXTERNAL', true],
    ['mcp__crm__update_contact', 'READ', 'EXTERNAL', true],
    ['mcp__gmail__create_draft', 'READ', 'WRITE_LOCAL', true],
    ['mcp__github__git_commit', 'READ', 'WRITE_LOCAL', true],
    ['mcp__gmail__compose_and_update_draft', 'READ', 'EXTERNAL', true],
    // Names that do not read like reads floor at EXTERNAL (re-review M1).
    ...[
      'rm',
      'unlink',
      'destroy',
      'purge',
      'trash_message',
      'overwrite',
      'truncate',
      'append_file',
      'shell',
      'bash',
      'eval',
      'browser_evaluate',
      'browser_type',
      'query',
      'sql',
      'http_request',
      'trigger_workflow',
      'rerun_job',
      'sendmail',
      'retweet',
      'mkdir',
      'chmod',
      'migrate',
      'spawn',
      'get_and_delete_issue',
      'commit_transaction',
    ].map((n): [string, Tier, Tier, boolean] => [`mcp__x__${n}`, 'READ', 'EXTERNAL', true]),
    ['mcp__github__git_diff', 'READ', 'READ', false],
    ['mcp__fake__echo', 'READ', 'READ', false],
    // Nouns that look like verbs stay READ-able.
    ['mcp__blog__get_post', 'READ', 'READ', false],
    ['mcp__google__list_drafts', 'READ', 'READ', false],
    ['mcp__gmail__draft_reply', 'READ', 'WRITE_LOCAL', true],
    ['mcp__ci__get_run', 'READ', 'READ', false],
    ['mcp__github__list_comments', 'READ', 'READ', false],
    ['mcp__slack__get_thread_replies', 'READ', 'READ', false],
    ['mcp__browser__open_page', 'READ', 'READ', false],
    // Raising is always allowed.
    ['mcp__github__list_issues', 'EXTERNAL', 'EXTERNAL', false],
  ])('%s declared %s → %s', (name, declared, tier, raised) => {
    expect(effectivePluginTier(name, declared)).toEqual({ tier, raised });
  });

  it('an egress override is carried into the classification', () => {
    const cls = classifyTool('mcp__browser__open_page', {
      shellContained: false,
      overrides: [{ pattern: 'mcp__browser__open_page', tier: 'READ', egress: true }],
    });
    expect(cls).toMatchObject({ tier: 'READ', egress: true, basis: 'override' });
  });
});

// M8 injection corpus (PLAN §7): a read verb followed by a destructive or
// acting word must not read as a read. One table for both the heuristic
// (`classifyTool`) and the plugin floor (`tierFloor`), so the two never drift.
describe('a read verb followed by an acting word is not a read (M8 corpus)', () => {
  it.each<[string, string, Tier]>([
    // snake_case
    ['get then remove (shell abbreviation)', 'get_rm', 'EXTERNAL'],
    ['view then evaluate code', 'view_eval', 'EXTERNAL'],
    ['list and delete in one call', 'list_and_delete', 'EXTERNAL'],
    ['read then send in one call', 'read_then_send', 'EXTERNAL'],
    ['fetch then execute', 'fetch_exec', 'EXTERNAL'],
    ['search then destroy', 'search_destroy', 'EXTERNAL'],
    ['find then purge', 'find_purge', 'EXTERNAL'],
    ['show then wipe', 'show_wipe', 'EXTERNAL'],
    ['lookup then drop a table', 'lookup_drop_table', 'EXTERNAL'],
    ['read a file then truncate it', 'read_file_truncate', 'EXTERNAL'],
    ['get then overwrite', 'get_overwrite', 'EXTERNAL'],
    ['describe then reset', 'describe_reset', 'EXTERNAL'],
    ['count then clear', 'count_clear', 'EXTERNAL'],
    ['get through a shell', 'get_shell', 'EXTERNAL'],
    ['fetch with curl', 'fetch_curl', 'EXTERNAL'],
    ['get with wget', 'get_wget', 'EXTERNAL'],
    ['read over ssh', 'read_ssh', 'EXTERNAL'],
    ['view then spawn', 'view_spawn', 'EXTERNAL'],
    ['list then trigger a workflow', 'list_trigger_workflow', 'EXTERNAL'],
    ['get then launch', 'get_launch', 'EXTERNAL'],
    ['get then dispatch', 'get_dispatch', 'EXTERNAL'],
    ['get then sudo', 'get_sudo', 'EXTERNAL'],
    ['read then chmod', 'read_chmod', 'EXTERNAL'],
    ['get then kill', 'get_kill', 'EXTERNAL'],
    ['get then unlink', 'get_unlink', 'EXTERNAL'],
    ['list then move to trash', 'list_trash', 'EXTERNAL'],
    ['get then repost', 'get_repost', 'EXTERNAL'],
    ['get then impersonate', 'get_impersonate', 'EXTERNAL'],
    ['get then bypass', 'get_bypass', 'EXTERNAL'],
    // camelCase and kebab-case spellings of the same names
    ['camelCase get-rm', 'getRm', 'EXTERNAL'],
    ['camelCase view-eval', 'viewEval', 'EXTERNAL'],
    ['camelCase list-and-delete', 'listAndDelete', 'EXTERNAL'],
    ['camelCase read-then-send', 'readThenSend', 'EXTERNAL'],
    ['camelCase fetch-exec', 'fetchExec', 'EXTERNAL'],
    ['capitalised abbreviation (getRM)', 'getRM', 'EXTERNAL'],
    ['kebab-case get-rm', 'get-rm', 'EXTERNAL'],
    ['kebab-case view-eval', 'view-eval', 'EXTERNAL'],
    ['kebab-case read-then-send', 'read-then-send', 'EXTERNAL'],
    // destroying drafts in another system is not drafting
    ['purge drafts', 'purge_drafts', 'EXTERNAL'],
    ['rm a draft', 'rm_draft', 'EXTERNAL'],
    ['wipe a draft', 'wipe_draft', 'EXTERNAL'],
    // money still wins over everything
    ['read then pay', 'read_then_pay', 'FINANCIAL'],
    ['get then transfer funds', 'get_transfer_funds', 'FINANCIAL'],
  ])('%s: %s → %s for the heuristic and the plugin floor', (_scenario, tool, tier) => {
    const name = `mcp__x__${tool}`;
    expect(classifyTool(name, open)?.tier).toBe(tier);
    expect(tierFloor(name)).toBe(tier);
    // A manifest cannot declare it READ either.
    expect(effectivePluginTier(name, 'READ')).toEqual({ tier, raised: true });
  });

  // Positive controls: genuine reads stay READ (the reference plugins' own
  // read tools among them), so the guard fires on actions, not on reads.
  it.each<[string, string]>([
    ['reading an issue', 'get_issue'],
    ['listing Slack channels', 'list_channels'],
    ['reading a file', 'read_file'],
    ['searching files', 'search_files'],
    ['listing a directory', 'list_directory'],
    ['reading a pull request', 'get_pull_request'],
    ['listing pull requests', 'list_pull_requests'],
    ['reading channel history', 'get_channel_history'],
    ['reading thread replies', 'get_thread_replies'],
    ['looking up a user', 'lookup_user'],
    ['listing calendar events', 'list_events'],
    ['listing drafts', 'list_drafts'],
    ['reading page text', 'get_text'],
    ['listing links', 'list_links'],
    ['reading a message', 'get_message'],
    ['reading a post', 'get_post'],
    ['reading system info (system is a noun)', 'get_system_info'],
    ['reading a date format (format is a noun)', 'get_date_format'],
    ['reading a clone URL', 'get_clone_url'],
    ['reading mail', 'get_mail'],
    ['listing forks', 'list_forks'],
    ['camelCase read', 'getPullRequest'],
    ['kebab-case read', 'list-channels'],
  ])('%s (%s) stays READ', (_scenario, tool) => {
    const name = `mcp__x__${tool}`;
    expect(classifyTool(name, open)?.tier).toBe('READ');
    expect(tierFloor(name)).toBe('READ');
    expect(effectivePluginTier(name, 'READ')).toEqual({ tier: 'READ', raised: false });
  });

  it("every reference plugin's declared READ tool keeps READ (no false positives)", () => {
    const declaredReads = [
      'mcp__browser__get_text',
      'mcp__browser__list_links',
      'mcp__browser__open_page',
      'mcp__filesystem__list_directory',
      'mcp__filesystem__read_file',
      'mcp__filesystem__search_files',
      'mcp__github__list_issues',
      'mcp__github__get_issue',
      'mcp__github__list_pull_requests',
      'mcp__github__get_pull_request',
      'mcp__github__git_status',
      'mcp__github__git_diff',
      'mcp__github__git_log',
      'mcp__google__list_messages',
      'mcp__google__get_message',
      'mcp__google__list_drafts',
      'mcp__google__list_events',
      'mcp__slack__list_channels',
      'mcp__slack__get_channel_history',
      'mcp__slack__get_thread_replies',
      'mcp__slack__lookup_user',
    ];
    for (const name of declaredReads) {
      expect(effectivePluginTier(name, 'READ'), name).toEqual({ tier: 'READ', raised: false });
    }
  });
});
