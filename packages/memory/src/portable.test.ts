import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_LIMITS, Redactor } from '@orbit/core';
import { openDatabase } from '@orbit/store';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store';
import { memoryExportHeader, memoryExportLine, parseMemoryImport } from './portable';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const SECRET = 'sk-secret-value-123';

function setup(opts: { maxPerBot?: number; dir?: string | null } = {}) {
  const db = openDatabase(':memory:');
  let t = NOW.getTime();
  const store = new MemoryStore(db, {
    redactor: new Redactor([SECRET]),
    dir: opts.dir ?? null,
    now: () => new Date(t++),
    ...(opts.maxPerBot ? { maxPerBot: opts.maxPerBot } : {}),
  });
  return { db, store };
}

const header = (count = 0) => memoryExportHeader([{ id: 'bot_1', name: 'Notes' }], count, NOW);

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'note',
    source: 'bot',
    title: 'Launch',
    body: 'Ada owns the launch.',
    taint: [],
    pinned: false,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...over,
  });

const file = (...lines: string[]) => [header(lines.length), ...lines].join('\n');

describe('memory export', () => {
  it('round-trips every provenance field through export and import', () => {
    const { store } = setup();
    const owner = store.create({
      botId: 'bot_1',
      kind: 'fact',
      source: 'owner',
      title: 'Owner fact',
      body: 'Grace signs off.',
      pinned: true,
      createdBy: 'owner',
    });
    const web = store.create({
      botId: 'bot_1',
      kind: 'note',
      source: 'bot',
      title: 'From the web',
      body: 'Mallory says hi.',
      taint: ['WebFetch'],
      runId: 'run_abc',
      createdBy: 'bot:bot_1',
    });
    const text = [
      memoryExportHeader([{ id: 'bot_1', name: 'Notes' }], 2, NOW),
      ...[...store.each('bot_1')].map(memoryExportLine),
    ].join('\n');
    expect(JSON.parse(text.split('\n')[0]!)).toMatchObject({
      kind: 'orbit-memory-export',
      v: 1,
      count: 2,
      bots: [{ id: 'bot_1', name: 'Notes' }],
    });

    const parsed = parseMemoryImport(text, new Date(NOW.getTime() + 60_000));
    expect(parsed.errors).toEqual([]);
    const target = setup().store;
    const { imported } = target.importMany('bot_2', parsed.memories, { createdBy: 'owner' });
    expect(imported).toHaveLength(2);
    const [a, b] = imported;
    expect(a!.id).not.toBe(owner.id);
    expect(a).toMatchObject({
      botId: 'bot_2',
      kind: 'fact',
      source: 'owner',
      title: 'Owner fact',
      taint: [],
      pinned: true,
      createdAt: owner.createdAt,
    });
    expect(b).toMatchObject({
      botId: 'bot_2',
      source: 'bot',
      taint: ['WebFetch'],
      runId: 'run_abc',
      pinned: false,
      createdAt: web.createdAt,
    });
    expect(target.get(b!.id).taint).toEqual(['WebFetch']);
  });

  it('pages through more memories than one page', () => {
    const { store } = setup();
    for (let i = 0; i < 1203; i++) {
      store.create({
        botId: 'bot_1',
        kind: 'note',
        source: 'bot',
        title: `n${i}`,
        body: '',
        createdBy: 'x',
      });
    }
    expect([...store.each()].length).toBe(1000);
    expect([...store.each('bot_1')].map((m) => m.title).at(-1)).toBe('n1202');
  });
});

describe('parseMemoryImport', () => {
  it('needs a header first and refuses a newer export version', () => {
    expect(parseMemoryImport(line(), NOW).errors[0]).toMatchObject({
      line: 1,
      message: expect.stringMatching(/header/) as string,
    });
    const newer = JSON.stringify({ ...JSON.parse(header()), v: 2 });
    expect(parseMemoryImport(newer, NOW).errors[0]?.message).toMatch(/newer/);
    expect(parseMemoryImport('\n\n', NOW).errors[0]?.message).toMatch(/empty/);
  });

  it('reports malformed lines with their line numbers', () => {
    const parsed = parseMemoryImport(
      file(
        line(),
        'not json',
        line({ kind: 'diary' }),
        line({ source: 'root' }),
        line({ createdAt: 'yesterday' }),
        line({ taint: 'WebFetch' }),
        line({ taint: ['  \u0000 '] }),
        '',
        line({ title: 'ok' }),
      ),
      NOW,
    );
    expect(parsed.memories).toHaveLength(2);
    expect(parsed.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(parsed.errors[0]!.message).toBe('not JSON');
    expect(parsed.errors[1]!.message).toMatch(/^kind:/);
  });

  it('refuses oversize lines before parsing them, and oversize fields', () => {
    const huge = line({ body: 'x'.repeat(MEMORY_LIMITS.exportLineChars) });
    const parsed = parseMemoryImport(
      file(
        huge,
        line({ body: 'x'.repeat(MEMORY_LIMITS.bodyChars + 1) }),
        line({ title: 't'.repeat(MEMORY_LIMITS.titleChars + 1) }),
        line({ taint: Array.from({ length: MEMORY_LIMITS.taintSources + 1 }, (_, i) => `s${i}`) }),
      ),
      NOW,
    );
    expect(parsed.memories).toEqual([]);
    expect(parsed.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(parsed.errors[0]!.message).toMatch(/longer than/);
  });

  it('caps the number of memories in one import', () => {
    const many = Array.from({ length: MEMORY_LIMITS.perBotCeiling + 1 }, () => line());
    const parsed = parseMemoryImport(file(...many), NOW);
    expect(parsed.memories).toHaveLength(MEMORY_LIMITS.perBotCeiling);
    expect(parsed.errors.at(-1)?.message).toMatch(/at most/);
  });

  it('never keeps a timestamp from the future', () => {
    const parsed = parseMemoryImport(file(line({ createdAt: '2099-01-01T00:00:00Z' })), NOW);
    expect(parsed.memories[0]!.createdAt).toBe(NOW.toISOString());
  });
});

describe('MemoryStore.importMany', () => {
  it('redacts secrets and strips control characters like any write', () => {
    const { store } = setup();
    const parsed = parseMemoryImport(
      file(line({ title: `key ${SECRET}`, body: `the key is ${SECRET}\u0000\u001b[31m` })),
      NOW,
    );
    const [m] = store.importMany('bot_1', parsed.memories, { createdBy: 'owner' }).imported;
    expect(m!.title).not.toContain(SECRET);
    expect(m!.body).not.toContain(SECRET);
    expect(m!.body).toContain('[REDACTED:secret]');
    expect(m!.body).not.toContain('\u0000');
    expect(m!.body).not.toContain('\u001b');
  });

  it('keeps untrusted memories untrusted, forces taint on request, never pins untrusted', () => {
    const { store } = setup();
    const parsed = parseMemoryImport(
      file(
        line({ taint: ['WebFetch'], pinned: true }),
        line({ source: 'owner', kind: 'fact', pinned: true }),
      ),
      NOW,
    );
    const kept = store.importMany('bot_1', parsed.memories, { createdBy: 'owner' }).imported;
    expect(kept.map((m) => [m.taint, m.pinned])).toEqual([
      [['WebFetch'], false],
      [[], true],
    ]);
    const forced = store.importMany('bot_2', parsed.memories, {
      createdBy: 'owner',
      forceTaint: 'import',
    }).imported;
    expect(forced.map((m) => [m.taint, m.pinned])).toEqual([
      [['WebFetch', 'import'], false],
      [['import'], false],
    ]);
  });

  it('enforces the per-Bot bound: drops existing Bot notes, never the imported ones', () => {
    const { store } = setup({ maxPerBot: 10 });
    const old = Array.from({ length: 8 }, (_, i) =>
      store.create({
        botId: 'bot_1',
        kind: 'note',
        source: 'bot',
        title: `old${i}`,
        body: '',
        createdBy: 'x',
      }),
    );
    store.create({
      botId: 'bot_1',
      kind: 'fact',
      source: 'owner',
      title: 'mine',
      body: '',
      createdBy: 'owner',
    });
    const items = parseMemoryImport(
      file(...Array.from({ length: 5 }, () => line({ taint: ['x'] }))),
      NOW,
    ).memories;
    expect(store.importPlan('bot_1', 5)).toEqual({ evicts: 4, fits: true });
    const { imported, evicted } = store.importMany('bot_1', items, { createdBy: 'owner' });
    expect(evicted.map((m) => m.id)).toEqual(old.slice(0, 4).map((m) => m.id));
    expect(store.count('bot_1')).toBe(10);
    for (const m of imported) expect(store.find(m.id)).toBeDefined();
  });

  it('refuses, writing nothing, when the import cannot fit next to undroppable memories', () => {
    const { store } = setup({ maxPerBot: 10 });
    for (let i = 0; i < 6; i++) {
      store.create({
        botId: 'bot_1',
        kind: 'fact',
        source: 'owner',
        title: `f${i}`,
        body: '',
        createdBy: 'owner',
      });
    }
    const items = parseMemoryImport(file(...Array.from({ length: 5 }, () => line())), NOW).memories;
    expect(store.importPlan('bot_1', 5).fits).toBe(false);
    expect(() => store.importMany('bot_1', items, { createdBy: 'owner' })).toThrow(
      expect.objectContaining({ code: 'blocked' }) as Error,
    );
    expect(store.count('bot_1')).toBe(6);
  });

  it('mirrors imported memories as markdown files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-mem-import-'));
    const { store } = setup({ dir });
    const [m] = store.importMany('bot_1', parseMemoryImport(file(line()), NOW).memories, {
      createdBy: 'owner',
    }).imported;
    expect(readdirSync(join(dir, 'bot_1'))).toEqual([`${m!.id}.md`]);
  });
});

describe('retention and the configurable bound', () => {
  it('expires only unpinned Bot notes and summaries older than the cutoff', () => {
    const { store } = setup();
    const items = parseMemoryImport(
      file(
        line({ title: 'old note' }),
        line({ title: 'old summary', kind: 'summary', source: 'summarizer' }),
        line({ title: 'old pinned note', pinned: true }),
        line({ title: 'old fact', kind: 'fact', source: 'owner' }),
        line({ title: 'old feedback', kind: 'feedback', source: 'feedback', signal: 'thumbs_up' }),
        line({ title: 'new note', createdAt: '2026-10-01T00:00:00.000Z' }),
      ),
      NOW,
    ).memories;
    store.importMany('bot_1', items, { createdBy: 'owner' });
    store.importMany('bot_2', items, { createdBy: 'owner' });
    const expired = store.expire('bot_1', '2026-09-15T00:00:00.000Z');
    expect(expired.map((m) => m.title).sort()).toEqual(['old note', 'old summary']);
    expect([...store.each('bot_1')].map((m) => m.title)).toEqual([
      'old pinned note',
      'old fact',
      'old feedback',
      'new note',
    ]);
    expect(store.count('bot_2')).toBe(6);
  });

  it('honours memory.maxPerBot on writes and trims after it was lowered', () => {
    const big = setup({ maxPerBot: 20 });
    for (let i = 0; i < 15; i++) {
      big.store.create({
        botId: 'bot_1',
        kind: 'note',
        source: 'bot',
        title: `n${i}`,
        body: '',
        createdBy: 'x',
      });
    }
    expect(big.store.count('bot_1')).toBe(15);
    const small = new MemoryStore(big.db, { maxPerBot: 10 });
    expect(small.trim('bot_1').map((m) => m.title)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect(small.trim('bot_1')).toEqual([]);
    small.create({
      botId: 'bot_1',
      kind: 'note',
      source: 'bot',
      title: 'next',
      body: '',
      createdBy: 'x',
    });
    expect(small.count('bot_1')).toBe(10);
    expect(new MemoryStore(big.db, { maxPerBot: 1_000_000 }).maxPerBot).toBe(
      MEMORY_LIMITS.perBotCeiling,
    );
  });
});
