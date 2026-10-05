import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_LIMITS, Redactor } from '@orbit/core';
import { openDatabase } from '@orbit/store';
import { describe, expect, it } from 'vitest';
import { MemoryStore, ftsQuery, memoryMarkdown, mergeTaint } from './memory-store';

function setup(dir: string | null = null) {
  const db = openDatabase(':memory:');
  const redactor = new Redactor(['sk-secret-value-123']);
  const store = new MemoryStore(db, { redactor, dir });
  return { db, store };
}

const base = {
  botId: 'bot_1',
  kind: 'note' as const,
  source: 'bot' as const,
  createdBy: 'bot:bot_1',
};

describe('MemoryStore', () => {
  it('creates, finds, lists newest first and deletes', () => {
    const { store } = setup();
    const a = store.create({ ...base, title: 'Launch', body: 'Ada owns the launch.' });
    const b = store.create({ ...base, title: 'Budget', body: 'Q3 budget is 10k.' });
    expect(store.get(a.id).title).toBe('Launch');
    expect(store.list({ botId: 'bot_1' }).map((m) => m.id)).toEqual([b.id, a.id]);
    store.delete(a.id);
    expect(store.find(a.id)).toBeUndefined();
    expect(() => store.get(a.id)).toThrow(/not found/);
  });

  it('full-text search ranks matches and keeps the index in sync on edits and deletes', () => {
    const { store } = setup();
    const a = store.create({ ...base, title: 'Launch owner', body: 'Ada owns the launch window.' });
    store.create({ ...base, title: 'Lunch', body: 'Pizza on Fridays.' });
    expect(store.list({ query: 'launch' }).map((m) => m.id)).toEqual([a.id]);
    expect(store.list({ query: 'laun' })[0]?.snippet).toContain('[');
    store.update(a.id, { body: 'Grace owns it now.' });
    expect(store.list({ query: 'grace' }).map((m) => m.id)).toEqual([a.id]);
    expect(store.list({ query: 'ada' })).toEqual([]);
    store.delete(a.id);
    expect(store.list({ query: 'grace' })).toEqual([]);
  });

  it('never lets search text inject FTS syntax', () => {
    expect(ftsQuery('title:secret OR body:* NEAR("a" "b")')).toBe(
      '"title"* AND "secret"* AND "or"* AND "body"* AND "near"*',
    );
    expect(ftsQuery('"); DROP TABLE memories; --', 'any')).toBe(
      '"drop"* OR "table"* OR "memories"*',
    );
    expect(ftsQuery('!!')).toBeNull();
    const { store } = setup();
    store.create({ ...base, title: 'x', body: 'y' });
    expect(() => store.list({ query: 'memories_fts MATCH "*"' })).not.toThrow();
  });

  it('redacts secrets before anything is stored or mirrored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-mem-'));
    const { db, store } = setup(dir);
    const m = store.create({
      ...base,
      title: 'Key sk-secret-value-123',
      body: 'use sk-secret-value-123 and ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    expect(m.body).not.toContain('sk-secret-value-123');
    expect(m.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    const raw = JSON.stringify(db.sqlite.prepare('SELECT * FROM memories').all());
    expect(raw).not.toContain('sk-secret-value-123');
    const file = join(dir, 'bot_1', `${m.id}.md`);
    expect(readFileSync(file, 'utf8')).not.toContain('sk-secret-value-123');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'bot_1')).mode & 0o777).toBe(0o700);
  });

  it('mirrors memories as markdown with provenance front matter and removes the file on delete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-mem-'));
    const { store } = setup(dir);
    const m = store.create({
      ...base,
      title: 'From the web',
      body: 'Body',
      taint: ['WebFetch'],
      runId: 'run_1',
    });
    const file = join(dir, 'bot_1', `${m.id}.md`);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('trust: untrusted');
    expect(text).toContain('taint: ["WebFetch"]');
    expect(text).toContain('run: run_1');
    expect(text).toContain('# From the web');
    expect(memoryMarkdown(m)).toBe(text);
    store.delete(m.id);
    expect(existsSync(file)).toBe(false);
  });

  it('keeps taint on edits; only an explicit trusted review clears it', () => {
    const { store } = setup();
    const m = store.create({ ...base, title: 't', body: 'b', taint: ['WebFetch'] });
    expect(store.update(m.id, { body: 'fixed typo' }).taint).toEqual(['WebFetch']);
    expect(store.get(m.id).editedAt).not.toBeNull();
    expect(store.update(m.id, { trusted: true }).taint).toEqual([]);
  });

  it('refuses to pin an untrusted memory', () => {
    const { store } = setup();
    expect(() =>
      store.create({ ...base, title: 't', body: 'b', taint: ['WebFetch'], pinned: true }),
    ).toThrow(/pinned/);
    const m = store.create({ ...base, title: 't', body: 'b', taint: ['WebFetch'] });
    expect(() => store.update(m.id, { pinned: true })).toThrow(/pinned/);
    expect(store.update(m.id, { pinned: true, trusted: true }).pinned).toBe(true);
  });

  it('filters trusted-only and by kind', () => {
    const { store } = setup();
    store.create({ ...base, title: 'a', body: 'x', taint: ['mcp__mail__read'] });
    const t = store.create({
      ...base,
      kind: 'summary',
      source: 'summarizer',
      title: 'b',
      body: 'x',
    });
    expect(store.list({ trustedOnly: true }).map((m) => m.id)).toEqual([t.id]);
    expect(store.list({ kind: 'summary' }).map((m) => m.id)).toEqual([t.id]);
  });

  it('stays bounded: evicts the oldest memory nobody chose to keep', () => {
    const { store } = setup();
    const owner = store.create({ ...base, source: 'owner', kind: 'fact', title: 'mine', body: '' });
    const first = store.create({ ...base, title: 'first', body: '' });
    for (let i = 0; i < MEMORY_LIMITS.perBot - 2; i++) {
      store.create({ ...base, title: `n${i}`, body: '' });
    }
    expect(store.count('bot_1')).toBe(MEMORY_LIMITS.perBot);
    store.create({ ...base, title: 'one more', body: '' });
    expect(store.count('bot_1')).toBe(MEMORY_LIMITS.perBot);
    expect(store.find(first.id)).toBeUndefined();
    expect(store.find(owner.id)).toBeDefined();
  });

  it('merges taint sources without duplicates and with a bound', () => {
    expect(mergeTaint(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    const many = Array.from({ length: 50 }, (_, i) => `s${i}`);
    expect(mergeTaint(many)).toHaveLength(MEMORY_LIMITS.taintSources);
  });

  it('lists the memories a Run wrote', () => {
    const { store } = setup();
    const m = store.create({ ...base, title: 'a', body: '', runId: 'run_9' });
    store.create({ ...base, title: 'b', body: '', runId: 'run_8' });
    expect(store.forRun('run_9').map((x) => x.id)).toEqual([m.id]);
  });
});
