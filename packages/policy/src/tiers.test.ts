import type { Tier } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { type Classification, type ToolTierOverride, classifyTool, globToRegExp } from './tiers';

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
      untrustedSource: null,
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
    ['creating an issue', 'mcp__github__create_issue', 'EXTERNAL', 'default'],
    [
      'read verb not in leading position is not a read',
      'mcp__crm__update_list',
      'EXTERNAL',
      'default',
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
      untrustedSource: tier === 'READ' || tier === 'WRITE_LOCAL' ? name : null,
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
      untrustedSource: null,
      basis: 'heuristic',
    });
    expect(classifyTool('LaunchMissiles', { shellContained: true, overrides })).toBeNull();
  });
});
