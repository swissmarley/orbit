import { OrbitError } from '@orbit/core';
import { type OrbitDb, openDatabase } from '@orbit/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Rule, RuleStore, isNarrowAllowPattern, ruleMatches } from './rules';

/** Mutable injected clock. */
function clock(start: string) {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set: (iso: string) => {
      t = new Date(iso).getTime();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function rule(over: Partial<Rule>): Rule {
  return {
    id: 'rul_test',
    botId: null,
    toolPattern: '*',
    inputMatch: null,
    effect: 'allow',
    reason: null,
    createdBy: 'user:owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    ...over,
  };
}

describe('ruleMatches', () => {
  it.each<[string, Partial<Rule>, string, Record<string, unknown>, boolean]>([
    [
      'exact tool name',
      { toolPattern: 'mcp__gmail__send_email' },
      'mcp__gmail__send_email',
      {},
      true,
    ],
    [
      'exact tool name, other tool',
      { toolPattern: 'mcp__gmail__send_email' },
      'mcp__gmail__send_draft',
      {},
      false,
    ],
    [
      'glob over a server',
      { toolPattern: 'mcp__github__get*' },
      'mcp__github__get_issue',
      {},
      true,
    ],
    [
      'glob over a server does not leak to another',
      { toolPattern: 'mcp__github__get*' },
      'mcp__gitlab__create_issue',
      {},
      false,
    ],
    [
      'glob does not match a prefix of the name only',
      { toolPattern: 'mcp__github' },
      'mcp__github__get_issue',
      {},
      false,
    ],
    [
      'inputMatch: recipient in company domain',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*@mycompany.com' } },
      'mcp__gmail__send_email',
      { to: 'ada@mycompany.com', body: 'hi' },
      true,
    ],
    [
      'inputMatch: recipient outside company domain',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*@mycompany.com' } },
      'mcp__gmail__send_email',
      { to: 'ada@evil.com' },
      false,
    ],
    [
      'inputMatch: lookalike domain suffix does not match (anchored)',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*@mycompany.com' } },
      'mcp__gmail__send_email',
      { to: 'ada@mycompany.com.evil.io' },
      false,
    ],
    [
      'inputMatch: missing field does not match',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*' } },
      'mcp__gmail__send_email',
      {},
      false,
    ],
    [
      'inputMatch: non-string field does not match even with "*"',
      { toolPattern: 'mcp__x__y', inputMatch: { to: '*' } },
      'mcp__x__y',
      { to: 42 },
      false,
    ],
    [
      'inputMatch (L11): a list in one string cannot hide an outside recipient',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*@mycompany.com' } },
      'mcp__gmail__send_email',
      { to: 'x@evil.com, ada@mycompany.com' },
      false,
    ],
    [
      'inputMatch (L11): semicolons, spaces and angle brackets end a value',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*@mycompany.com' } },
      'mcp__gmail__send_email',
      { to: 'Eve <x@evil.com>;ada@mycompany.com' },
      false,
    ],
    [
      'inputMatch (L11): every entry of a list must match',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*@mycompany.com' } },
      'mcp__gmail__send_email',
      { to: ['ada@mycompany.com', 'x@evil.com'] },
      false,
    ],
    [
      'inputMatch (L11): a list whose entries all match',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*@mycompany.com' } },
      'mcp__gmail__send_email',
      { to: ['ada@mycompany.com', 'bob@mycompany.com'] },
      true,
    ],
    [
      'inputMatch (L11): an empty list matches nothing',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*@mycompany.com' } },
      'mcp__gmail__send_email',
      { to: [] },
      false,
    ],
    [
      'inputMatch (L11): .. segments never match a path glob',
      { toolPattern: 'mcp__filesystem__write_file', inputMatch: { path: '/home/me/notes/*' } },
      'mcp__filesystem__write_file',
      { path: '/home/me/notes/../.ssh/authorized_keys' },
      false,
    ],
    [
      'inputMatch (L11): a path below the folder matches',
      { toolPattern: 'mcp__filesystem__write_file', inputMatch: { path: '/home/me/notes/*' } },
      'mcp__filesystem__write_file',
      { path: '/home/me/notes/2026/todo.md' },
      true,
    ],
    [
      'inputMatch (L11): a newline ends a value',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*@mycompany.com' } },
      'mcp__gmail__send_email',
      { to: 'x@evil.com\nada@mycompany.com' },
      false,
    ],
    [
      'inputMatch: every field must match',
      {
        toolPattern: 'mcp__slack__post_message',
        inputMatch: { channel: '#team-*', text: 'deploy*' },
      },
      'mcp__slack__post_message',
      { channel: '#team-eng', text: 'hello' },
      false,
    ],
    [
      'inputMatch: all fields match',
      {
        toolPattern: 'mcp__slack__post_message',
        inputMatch: { channel: '#team-*', text: 'deploy*' },
      },
      'mcp__slack__post_message',
      { channel: '#team-eng', text: 'deploy-v2' },
      true,
    ],
    [
      'inputMatch only applies once the tool pattern matched',
      { toolPattern: 'mcp__gmail__send_email', inputMatch: { to: '*' } },
      'mcp__slack__post_message',
      { to: 'x' },
      false,
    ],
  ])('%s', (_scenario, over, tool, input, expected) => {
    expect(ruleMatches(rule(over), tool, input)).toBe(expected);
  });
});

describe('RuleStore', () => {
  let db: OrbitDb;
  let c: ReturnType<typeof clock>;
  let store: RuleStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    c = clock('2026-10-04T12:00:00.000Z');
    store = new RuleStore(db, c.now);
  });
  afterEach(() => db.close());

  it('creates a rule with the injected clock and round-trips every field', () => {
    const created = store.create({
      botId: 'bot_1',
      toolPattern: 'mcp__gmail__send_email',
      inputMatch: { to: '*@mycompany.com' },
      effect: 'allow',
      reason: 'team mail is fine',
      createdBy: 'user:owner',
      expiresAt: '2026-10-05T12:00:00.000Z',
    });
    expect(created.id).toMatch(/^rul_/);
    expect(created).toMatchObject({
      botId: 'bot_1',
      toolPattern: 'mcp__gmail__send_email',
      inputMatch: { to: '*@mycompany.com' },
      effect: 'allow',
      reason: 'team mail is fine',
      createdBy: 'user:owner',
      createdAt: '2026-10-04T12:00:00.000Z',
      expiresAt: '2026-10-05T12:00:00.000Z',
      revokedAt: null,
    });
    // What was persisted reads back identically.
    expect(store.list({ includeInactive: true })).toEqual([created]);
  });

  it('validates inputMatch (review L11)', () => {
    const make = (inputMatch: Record<string, string>) =>
      store.create({
        botId: null,
        toolPattern: 'mcp__gmail__send_email',
        inputMatch,
        effect: 'allow',
        createdBy: 'u',
      });
    expect(() => make({})).toThrow(/1 to 10 fields/);
    expect(() => make({ to: '*' })).toThrow(/literal text/);
    expect(() => make({ 'to.address': '*@x.com' })).toThrow(/top-level argument/);
    expect(() => make({ to: '' })).toThrow(/1 to 500/);
    expect(make({ to: '*@x.com' }).inputMatch).toEqual({ to: '*@x.com' });
  });

  it('defaults optional fields to null', () => {
    const r = store.create({ botId: null, toolPattern: 'Bash', effect: 'deny', createdBy: 'u' });
    expect(r).toMatchObject({ inputMatch: null, reason: null, expiresAt: null, revokedAt: null });
  });

  describe('refusals', () => {
    it.each<[string, Parameters<RuleStore['create']>]>([
      [
        'allow rule for a FINANCIAL tool',
        [
          { botId: null, toolPattern: 'mcp__stripe__pay_invoice', effect: 'allow', createdBy: 'u' },
          'FINANCIAL',
        ],
      ],
      [
        'bot-scoped allow rule for a FINANCIAL tool',
        [
          { botId: 'bot_1', toolPattern: 'mcp__bank__*', effect: 'allow', createdBy: 'u' },
          'FINANCIAL',
        ],
      ],
      [
        'allow rule for bare "*"',
        [{ botId: null, toolPattern: '*', effect: 'allow', createdBy: 'u' }],
      ],
      [
        'allow rule for "**"',
        [{ botId: 'bot_1', toolPattern: '**', effect: 'allow', createdBy: 'u' }],
      ],
    ])('refuses %s and persists nothing', (_scenario, args) => {
      expect(() => store.create(...args)).toThrow(OrbitError);
      expect(() => store.create(...args)).toThrow(/never be allowed|too broad/);
      expect(store.list({ includeInactive: true })).toEqual([]);
    });

    it.each<[string, Parameters<RuleStore['create']>]>([
      [
        'deny rule for a FINANCIAL tool (positive control: deny is fine)',
        [
          { botId: null, toolPattern: 'mcp__stripe__*', effect: 'deny', createdBy: 'u' },
          'FINANCIAL',
        ],
      ],
      [
        'deny rule for bare "*"',
        [{ botId: 'bot_1', toolPattern: '*', effect: 'deny', createdBy: 'u' }],
      ],
      [
        'allow rule for a server glob (positive control: specific enough)',
        [
          { botId: null, toolPattern: 'mcp__github__get*', effect: 'allow', createdBy: 'u' },
          'EXTERNAL',
        ],
      ],
    ])('accepts %s', (_scenario, args) => {
      expect(store.create(...args).id).toMatch(/^rul_/);
    });
  });

  describe('list', () => {
    it('separates active, revoked and expired rules using the injected clock', () => {
      const active = store.create({
        botId: null,
        toolPattern: 'A',
        effect: 'allow',
        createdBy: 'u',
      });
      const revoked = store.create({
        botId: null,
        toolPattern: 'B',
        effect: 'allow',
        createdBy: 'u',
      });
      const expiring = store.create({
        botId: null,
        toolPattern: 'C',
        effect: 'allow',
        createdBy: 'u',
        expiresAt: '2026-10-04T13:00:00.000Z',
      });
      c.advance(1000);
      const revokedRow = store.revoke(revoked.id);
      expect(revokedRow.revokedAt).toBe('2026-10-04T12:00:01.000Z');

      const ids = (rules: Rule[]) => rules.map((r) => r.id).sort();
      expect(ids(store.list())).toEqual(ids([active, expiring]));
      expect(ids(store.list({ includeInactive: true }))).toEqual(ids([active, revoked, expiring]));

      // Exactly at the expiry instant the rule is no longer active.
      c.set('2026-10-04T13:00:00.000Z');
      expect(ids(store.list())).toEqual([active.id]);
      c.set('2026-10-04T12:59:59.999Z');
      expect(ids(store.list())).toEqual(ids([active, expiring]));
    });

    it('revoking twice (or an unknown id) is not_found', () => {
      const r = store.create({ botId: null, toolPattern: 'A', effect: 'deny', createdBy: 'u' });
      store.revoke(r.id);
      expect(() => store.revoke(r.id)).toThrow(/not found/);
      expect(() => store.revoke('rul_missing')).toThrow(/not found/);
    });

    it('bot scope: a bot sees its own and global rules, never another bot’s', () => {
      const global = store.create({
        botId: null,
        toolPattern: 'G',
        effect: 'allow',
        createdBy: 'u',
      });
      const mine = store.create({
        botId: 'bot_1',
        toolPattern: 'M',
        effect: 'allow',
        createdBy: 'u',
      });
      const theirs = store.create({
        botId: 'bot_2',
        toolPattern: 'T',
        effect: 'allow',
        createdBy: 'u',
      });
      const ids = (rules: Rule[]) => rules.map((r) => r.id).sort();
      expect(ids(store.list({ botId: 'bot_1' }))).toEqual(ids([global, mine]));
      expect(ids(store.list({ botId: 'bot_2' }))).toEqual(ids([global, theirs]));
      expect(ids(store.list())).toEqual(ids([global, mine, theirs]));
    });

    it('lists newest first', () => {
      const first = store.create({
        botId: null,
        toolPattern: 'A',
        effect: 'allow',
        createdBy: 'u',
      });
      c.advance(1000);
      const second = store.create({
        botId: null,
        toolPattern: 'B',
        effect: 'allow',
        createdBy: 'u',
      });
      expect(store.list().map((r) => r.id)).toEqual([second.id, first.id]);
    });
  });

  describe('matching', () => {
    it('returns only matching active rules in scope, deny rules first', () => {
      const allowNewest = store.create({
        botId: 'bot_1',
        toolPattern: 'mcp__gmail__send*',
        effect: 'allow',
        createdBy: 'u',
      });
      c.advance(1000);
      // Created later (so listed earlier by createdAt): proves ordering is by effect.
      const allowGlobal = store.create({
        botId: null,
        toolPattern: 'mcp__gmail__send_email',
        effect: 'allow',
        createdBy: 'u',
      });
      const deny = store.create({
        botId: null,
        toolPattern: 'mcp__gmail__send_email',
        inputMatch: { to: '*@evil.com' },
        effect: 'deny',
        createdBy: 'u',
      });
      c.advance(1000);
      const allowLatest = store.create({
        botId: null,
        toolPattern: 'mcp__gmail__send_*',
        effect: 'allow',
        createdBy: 'u',
      });
      // Not matching: other bot, other tool, revoked, expired.
      store.create({
        botId: 'bot_2',
        toolPattern: 'mcp__gmail__send*',
        effect: 'deny',
        createdBy: 'u',
      });
      store.create({ botId: null, toolPattern: 'mcp__slack__*', effect: 'deny', createdBy: 'u' });
      const revoked = store.create({
        botId: null,
        toolPattern: 'mcp__gmail__send*',
        effect: 'deny',
        createdBy: 'u',
      });
      store.revoke(revoked.id);
      store.create({
        botId: null,
        toolPattern: 'mcp__gmail__send*',
        effect: 'deny',
        createdBy: 'u',
        expiresAt: '2026-10-04T12:00:00.000Z',
      });

      const evil = store.matching('bot_1', 'mcp__gmail__send_email', { to: 'x@evil.com' });
      expect(evil[0]?.id).toBe(deny.id);
      expect(evil.slice(1).map((r) => r.effect)).toEqual(['allow', 'allow', 'allow']);
      expect(evil.map((r) => r.id).sort()).toEqual(
        [deny.id, allowNewest.id, allowGlobal.id, allowLatest.id].sort(),
      );

      const friendly = store.matching('bot_1', 'mcp__gmail__send_email', { to: 'x@ok.com' });
      expect(friendly.map((r) => r.effect)).toEqual(['allow', 'allow', 'allow']);

      expect(store.matching('bot_3', 'mcp__gmail__get_message', {})).toEqual([]);
    });
  });
});

describe('isNarrowAllowPattern (M2 review M7)', () => {
  it.each([
    ['mcp__gmail__send_email', true],
    ['mcp__github__get*', true],
    ['Bash', true],
    ['*', false],
    ['mcp__*', false],
    ['mcp__gmail__*', false],
    ['*_*', false],
    ['?*', false],
    ['mcp__*__send_email', false],
  ])('%s → %s', (pattern, ok) => {
    expect(isNarrowAllowPattern(pattern)).toBe(ok);
  });
});
