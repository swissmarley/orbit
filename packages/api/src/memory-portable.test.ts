import type { Memory, MemoryImportResult, MemorySweepResult } from '@orbit/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from '../test/harness';

let current: Harness | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const SECRET = 'launch-code-0123456789';

async function bot(h: Harness, name: string): Promise<string> {
  return (await h.json<{ id: string }>('POST', '/v1/bots', { name, goal: 'g' })).body.id;
}

const header = (count: number) =>
  JSON.stringify({ kind: 'orbit-memory-export', v: 1, exportedAt: 'x', bots: [], count });
const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'note',
    source: 'bot',
    title: 'Note',
    body: 'Body',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
const file = (...lines: string[]) => [header(lines.length), ...lines].join('\n');

describe('memory export and import (ADR-012, M8)', () => {
  it('exports with provenance and imports into another Bot, previewing first', async () => {
    const h = (current = harness());
    const notes = await bot(h, 'Notes');
    const other = await bot(h, 'Other');
    await h.json('POST', '/v1/bots/notes/memory', { title: 'Owner fact', body: 'Ada owns it.' });
    const web = h.service.memory.create({
      botId: notes,
      kind: 'note',
      source: 'bot',
      title: 'From the web',
      body: 'Mallory owns it.',
      taint: ['WebFetch'],
      runId: 'run_1',
      createdBy: `bot:${notes}`,
    });

    const res = await h.call('GET', '/v1/memory/export?bot=notes');
    expect(res.headers.get('content-type')).toMatch(/ndjson/);
    const text = await res.text();
    const [head, ...rows] = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(head).toMatchObject({
      kind: 'orbit-memory-export',
      v: 1,
      count: 2,
      bots: [{ id: notes, name: 'Notes' }],
    });
    expect(rows.map((r) => [r.source, r.taint, r.runId])).toEqual([
      ['owner', [], null],
      ['bot', ['WebFetch'], 'run_1'],
    ]);
    const all = (await (await h.call('GET', '/v1/memory/export')).text()).trim().split('\n');
    expect(JSON.parse(all[0]!)).toMatchObject({ count: 2 });
    expect(h.service.audit.list({ action: 'memory.exported' })).toHaveLength(2);

    const preview = await h.json<MemoryImportResult>('POST', '/v1/bots/other/memory/import', {
      jsonl: text,
      dryRun: true,
    });
    expect(preview.body).toMatchObject({
      dryRun: true,
      total: 2,
      trusted: 1,
      untrusted: 1,
      claimsOwner: 1,
      bySource: { owner: 1, bot: 1 },
      imported: [],
      errors: [],
    });
    expect(h.service.memory.count(other)).toBe(0);

    const done = await h.json<MemoryImportResult>('POST', '/v1/bots/other/memory/import', {
      jsonl: text,
    });
    expect(done.status).toBe(200);
    expect(done.body.imported).toHaveLength(2);
    const imported = done.body.imported.map((id) => h.service.memory.get(id));
    expect(imported.map((m) => [m.botId, m.source, m.taint])).toEqual([
      [other, 'owner', []],
      [other, 'bot', ['WebFetch']],
    ]);
    expect(imported.map((m) => m.id)).not.toContain(web.id);

    const [audit] = h.service.audit.list({ action: 'memory.imported' });
    expect(audit).toMatchObject({
      actor: 'owner',
      subject: other,
      data: { count: 2, trusted: 1, untrusted: 1, forcedUntrusted: false, ids: done.body.imported },
    });
    expect(JSON.stringify(audit)).not.toContain('Ada owns it');
    expect(JSON.stringify(audit)).not.toContain('Mallory');
  });

  it('--untrusted marks every imported memory untrusted', async () => {
    const h = (current = harness());
    await bot(h, 'Notes');
    const res = await h.json<MemoryImportResult>('POST', '/v1/bots/notes/memory/import', {
      jsonl: file(line({ source: 'owner', kind: 'fact', pinned: true })),
      untrusted: true,
    });
    expect(res.body).toMatchObject({ trusted: 0, untrusted: 1, claimsOwner: 0, pinned: 0 });
    expect(h.service.memory.get(res.body.imported[0]!)).toMatchObject({
      taint: ['import'],
      pinned: false,
    });
  });

  it('refuses a file with malformed lines, writing nothing; a dry run lists them', async () => {
    const h = (current = harness());
    const id = await bot(h, 'Notes');
    const jsonl = file(line(), '{oops', line({ kind: 'diary' }));
    const preview = await h.json<MemoryImportResult>('POST', '/v1/bots/notes/memory/import', {
      jsonl,
      dryRun: true,
    });
    expect(preview.body.errors.map((e) => e.line)).toEqual([3, 4]);
    const res = await h.json<{ error: { code: string; message: string } }>(
      'POST',
      '/v1/bots/notes/memory/import',
      { jsonl },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/line 3: not JSON \(and 1 more\)/);
    expect(h.service.memory.count(id)).toBe(0);
    expect(h.service.audit.list({ action: 'memory.imported' })).toEqual([]);
  });

  it('redacts secrets on import', async () => {
    const h = (current = harness());
    await bot(h, 'Notes');
    await h.json('PUT', `/v1/secrets/LAUNCH`, { value: SECRET });
    const res = await h.json<MemoryImportResult>('POST', '/v1/bots/notes/memory/import', {
      jsonl: file(line({ title: `code ${SECRET}`, body: `The code is ${SECRET}.` })),
    });
    const m = h.service.memory.get(res.body.imported[0]!);
    expect(JSON.stringify(m)).not.toContain(SECRET);
    expect(m.body).toContain('[REDACTED:secret]');
  });

  it('accepts imports above the default 1 MiB body limit, up to its own', async () => {
    const h = (current = harness());
    await bot(h, 'Notes');
    const big = file(
      ...Array.from({ length: 300 }, (_, i) => line({ title: `n${i}`, body: 'x'.repeat(7000) })),
    );
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const res = await h.json<MemoryImportResult>('POST', '/v1/bots/notes/memory/import', {
      jsonl: big,
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(300);
    const huge = await h.call('POST', '/v1/bots/notes/memory/import', {
      jsonl: 'x'.repeat(17 * 1024 * 1024),
    });
    expect(huge.status).toBe(413);
    // other routes keep the 1 MiB limit
    const other = await h.call('POST', '/v1/bots/notes/memory', {
      title: 't',
      body: 'x'.repeat(1_100_000),
    });
    expect(other.status).toBe(413);
  });

  it('enforces the per-Bot bound on import', async () => {
    const h = (current = harness({ config: { memory: { maxPerBot: 10 } } }));
    await bot(h, 'Notes');
    const facts = Array.from({ length: 11 }, () => line({ source: 'owner', kind: 'fact' }));
    const res = await h.json<{ error: { code: string } }>('POST', '/v1/bots/notes/memory/import', {
      jsonl: file(...facts),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('blocked');
  });
});

describe('memory retention (ADR-012, M8)', () => {
  async function seeded(h: Harness, name: string): Promise<{ id: string; memories: Memory[] }> {
    const id = await bot(h, name);
    const old = '2026-01-01T00:00:00.000Z';
    const res = await h.json<MemoryImportResult>(
      'POST',
      `/v1/bots/${name.toLowerCase()}/memory/import`,
      {
        jsonl: file(
          line({ title: 'old note', createdAt: old }),
          line({ title: 'old summary', kind: 'summary', source: 'summarizer', createdAt: old }),
          line({ title: 'old pinned', pinned: true, createdAt: old }),
          line({ title: 'old fact', kind: 'fact', source: 'owner', createdAt: old }),
          line({ title: 'old feedback', kind: 'feedback', source: 'feedback', createdAt: old }),
          line({ title: 'fresh note', createdAt: new Date().toISOString() }),
        ),
      },
    );
    return { id, memories: res.body.imported.map((m) => h.service.memory.get(m)) };
  }

  it('expires old unpinned Bot notes and summaries only; a Bot can opt out', async () => {
    const h = (current = harness({ config: { memory: { retentionDays: 30 } } }));
    const a = await seeded(h, 'Alpha');
    const b = await seeded(h, 'Beta');
    await h.json('PUT', '/v1/bots/beta', {
      ...h.service.bots.get('beta').spec,
      memory: { ...h.service.bots.get('beta').spec.memory, retentionDays: null },
    });
    const res = await h.json<MemorySweepResult>('POST', '/v1/memory/sweep');
    expect(res.body).toMatchObject({ expired: 2, trimmed: 0, retentionDays: 30, maxPerBot: 1000 });
    expect(res.body.bots).toEqual([{ botId: a.id, expired: 2, trimmed: 0 }]);
    const left = h.service.memory
      .list({ botId: a.id })
      .map((m) => m.title)
      .sort();
    expect(left).toEqual(['fresh note', 'old fact', 'old feedback', 'old pinned']);
    expect(h.service.memory.count(b.id)).toBe(6);
    const [audit] = h.service.audit.list({ action: 'memory.expired' });
    expect(audit).toMatchObject({ actor: 'owner', subject: a.id, data: { retentionDays: 30 } });
    expect(JSON.stringify(audit)).not.toContain('old note');
  });

  it('keeps everything by default and sweeps by itself once a day', async () => {
    const h = (current = harness());
    const a = await seeded(h, 'Alpha');
    expect((await h.json<MemorySweepResult>('POST', '/v1/memory/sweep')).body.expired).toBe(0);
    expect(h.service.memory.count(a.id)).toBe(6);

    const d = (current = harness({ config: { memory: { retentionDays: 30 } } }));
    await h.close();
    const alpha = await seeded(d, 'Alpha');
    d.service.tick();
    expect(d.service.memory.count(alpha.id)).toBe(6); // swept at start, before the import
    d.clock.advance(25 * 3_600_000);
    d.service.tick();
    expect(d.service.memory.count(alpha.id)).toBe(4);
    expect(d.service.audit.list({ action: 'memory.expired' })[0]?.actor).toBe('system');
  });
});
