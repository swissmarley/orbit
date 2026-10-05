import { createHash } from 'node:crypto';
import { Redactor } from '@orbit/core';
import { type OrbitDb, openDatabase } from '@orbit/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, type AuditRecord, canonicalJson } from './audit';

const PLANTED = 'planted-secret-value';
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

let db: OrbitDb;
let log: AuditLog;
let clock: number;

const now = () => new Date(Date.UTC(2026, 9, 4, 12, 0, 0) + clock++ * 1000);

beforeEach(() => {
  clock = 0;
  db = openDatabase(':memory:');
  log = new AuditLog(db, new Redactor([PLANTED]), now);
});
afterEach(() => {
  db.close();
});

function seed(n: number): AuditRecord[] {
  const out: AuditRecord[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      log.append({
        actor: i % 2 === 0 ? 'owner' : 'bot:bot_1',
        action: i % 3 === 0 ? 'approval.decided' : 'secret.set',
        subject: `s${i % 4}`,
        data: { i, nested: { list: [i, 'x'], flag: i % 2 === 0 } },
      }),
    );
  }
  return out;
}

/** Simulate an attacker with direct DB access: remove the append-only triggers. */
function dropTriggers(): void {
  db.sqlite.exec('DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;');
}

function rawRows(): Record<string, unknown>[] {
  return db.sqlite.prepare('SELECT * FROM audit ORDER BY seq').all() as Record<string, unknown>[];
}

describe('canonicalJson', () => {
  it('is independent of key insertion order, recursively', () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: null }, c: 'z' };
    const b = { c: 'z', a: { x: null, y: [1, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":null,"y":[1,{"p":2,"q":1}]},"b":1,"c":"z"}');
  });

  it('preserves array order and follows JSON semantics for edge values', () => {
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
    expect(canonicalJson({ a: undefined, b: [undefined, NaN, Infinity], c: -0 })).toBe(
      '{"b":[null,null,null],"c":0}',
    );
    expect(canonicalJson(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(canonicalJson('é"\n')).toBe(JSON.stringify('é"\n'));
    expect(canonicalJson(true)).toBe('true');
  });

  it('rejects bigint, circular structures and non-serializable roots', () => {
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow(/circular/);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    // repeated (non-circular) references are fine
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});

describe('AuditLog chain', () => {
  it('has a 64-zero genesis hash', () => {
    expect(AuditLog.GENESIS).toBe('0'.repeat(64));
  });

  it('links every record to its predecessor with an independently recomputable hash', () => {
    const recs = seed(5);
    expect(recs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(recs[0]!.prevHash).toBe(AuditLog.GENESIS);
    for (let i = 1; i < recs.length; i++) expect(recs[i]!.prevHash).toBe(recs[i - 1]!.hash);
    for (const r of recs) {
      expect(r.id).toMatch(/^aud_/);
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
      const expected = createHash('sha256')
        .update(
          canonicalJson({
            prevHash: r.prevHash,
            id: r.id,
            ts: r.ts,
            actor: r.actor,
            action: r.action,
            subject: r.subject,
            data: r.data,
          }),
        )
        .digest('hex');
      expect(r.hash).toBe(expected);
    }
    expect(log.list({ limit: 10 })).toEqual(recs);
    expect(log.verify()).toMatchObject({ ok: true, count: 5 });
  });

  it('verifies an empty log and defaults subject/data', () => {
    expect(log.verify()).toMatchObject({ ok: true, count: 0 });
    const r = log.append({ actor: 'system', action: 'daemon.started' });
    expect(r.subject).toBeNull();
    expect(r.data).toEqual({});
    expect(log.verify()).toMatchObject({ ok: true, count: 1 });
  });

  it('stores what it hashes: JSON-normalized data round-trips identically', () => {
    const r = log.append({
      actor: 'owner',
      action: 'x',
      data: { when: new Date(0), gone: undefined, arr: [1, undefined] },
    });
    expect(r.data).toEqual({ when: '1970-01-01T00:00:00.000Z', arr: [1, null] });
    expect(log.list()[0]!.data).toEqual(r.data);
    expect(log.verify().ok).toBe(true);
  });

  it('rejects non-serializable data with invalid_input', () => {
    expect(() => log.append({ actor: 'owner', action: 'x', data: { n: 1n } })).toThrow(
      expect.objectContaining({ code: 'invalid_input' }) as Error,
    );
    expect(log.verify()).toMatchObject({ ok: true, count: 0 });
  });
});

describe('AuditLog redaction', () => {
  it('never stores a planted secret or key-shaped string, in data or subject', () => {
    const r = log.append({
      actor: 'owner',
      action: 'secret.set',
      subject: `GITHUB ${PLANTED}`,
      data: {
        note: `value is ${PLANTED}`,
        deep: { list: [`Bearer-less ${ANTHROPIC_KEY}`, { inner: PLANTED }] },
        token: 'anything-under-a-sensitive-key',
      },
    });
    const all = JSON.stringify(rawRows());
    expect(all).not.toContain(PLANTED);
    expect(all).not.toContain(ANTHROPIC_KEY);
    expect(all).not.toContain('sk-ant-api03');
    expect(all).not.toContain('anything-under-a-sensitive-key');
    expect(all).toContain('[REDACTED:secret]');
    expect(all).toContain('[REDACTED:anthropic-key]');
    expect(JSON.stringify(r)).not.toContain(PLANTED);
    // the redacted form is what was hashed, so the chain still verifies
    expect(log.verify()).toMatchObject({ ok: true, count: 1 });
  });
});

describe('AuditLog append-only triggers', () => {
  it('reject UPDATE and DELETE', () => {
    seed(2);
    expect(() => db.sqlite.prepare("UPDATE audit SET actor = 'evil' WHERE seq = 1").run()).toThrow(
      /append-only/,
    );
    expect(() => db.sqlite.prepare('DELETE FROM audit WHERE seq = 2').run()).toThrow(/append-only/);
    expect(log.verify()).toMatchObject({ ok: true, count: 2 });
  });
});

describe('AuditLog tamper detection', () => {
  const fields: [string, string][] = [
    ['data', `data = '{"i":999}'`],
    ['actor', `actor = 'owner'`],
    ['action', `action = 'nothing.happened'`],
    ['ts', `ts = '2020-01-01T00:00:00.000Z'`],
    ['subject', `subject = NULL`],
    ['id', `id = 'aud_forged'`],
  ];
  it.each(fields)('detects a modified %s', (_field, set) => {
    seed(5);
    dropTriggers();
    db.sqlite.exec(`UPDATE audit SET ${set} WHERE seq = 2`);
    expect(log.verify()).toMatchObject({
      ok: false,
      count: 1,
      firstBadSeq: 2,
      reason: expect.stringMatching(/hash mismatch/) as string,
    });
  });

  it('detects a modified record whose own hash was recomputed (next link breaks)', () => {
    const recs = seed(5);
    dropTriggers();
    const forged = { ...recs[2]!, actor: 'owner', action: 'forged' };
    const newHash = createHash('sha256')
      .update(
        canonicalJson({
          prevHash: forged.prevHash,
          id: forged.id,
          ts: forged.ts,
          actor: forged.actor,
          action: forged.action,
          subject: forged.subject,
          data: forged.data,
        }),
      )
      .digest('hex');
    db.sqlite
      .prepare("UPDATE audit SET actor = 'owner', action = 'forged', hash = ? WHERE seq = 3")
      .run(newHash);
    const res = log.verify();
    expect(res).toMatchObject({ ok: false, count: 3, firstBadSeq: 4 });
    expect(!res.ok && res.reason).toMatch(/prev_hash/);
  });

  it('detects a record deleted from the middle', () => {
    seed(5);
    dropTriggers();
    db.sqlite.exec('DELETE FROM audit WHERE seq = 3');
    expect(log.verify()).toMatchObject({ ok: false, count: 2, firstBadSeq: 4 });
  });

  it('detects the first record being deleted', () => {
    seed(3);
    dropTriggers();
    db.sqlite.exec('DELETE FROM audit WHERE seq = 1');
    expect(log.verify()).toMatchObject({ ok: false, count: 0, firstBadSeq: 2 });
  });

  it('detects a middle deletion even when the chain is re-linked (seq gap)', () => {
    const recs = seed(5);
    dropTriggers();
    db.sqlite.exec('DELETE FROM audit WHERE seq = 3');
    // attacker re-points record 4 at record 2 and recomputes every later hash
    let prev = recs[1]!.hash;
    for (const r of recs.slice(3)) {
      const h = createHash('sha256')
        .update(
          canonicalJson({
            prevHash: prev,
            id: r.id,
            ts: r.ts,
            actor: r.actor,
            action: r.action,
            subject: r.subject,
            data: r.data,
          }),
        )
        .digest('hex');
      db.sqlite
        .prepare('UPDATE audit SET prev_hash = ?, hash = ? WHERE seq = ?')
        .run(prev, h, r.seq);
      prev = h;
    }
    const res = log.verify();
    expect(res).toMatchObject({ ok: false, count: 2, firstBadSeq: 4 });
    expect(!res.ok && res.reason).toMatch(/sequence gap/);
  });

  it('cannot detect deletion of the last record from the chain alone, but count drops', () => {
    seed(5);
    const head = log.verify();
    expect(head).toMatchObject({ ok: true, count: 5 });
    dropTriggers();
    db.sqlite.exec('DELETE FROM audit WHERE seq = 5');
    // Documented limitation: tail truncation leaves a valid shorter chain.
    // Callers detect it by comparing count against an externally stored head.
    expect(log.verify()).toMatchObject({ ok: true, count: 4 });
  });

  it('detects a tail deletion once another record is appended (seq gap)', () => {
    seed(5);
    dropTriggers();
    db.sqlite.exec('DELETE FROM audit WHERE seq = 5');
    const next = log.append({ actor: 'system', action: 'after' });
    expect(next.seq).toBe(6);
    expect(log.verify()).toMatchObject({ ok: false, count: 4, firstBadSeq: 6 });
  });

  it('detects reordered records', () => {
    seed(5);
    dropTriggers();
    db.sqlite.exec(`
      UPDATE audit SET seq = -1 WHERE seq = 2;
      UPDATE audit SET seq = 2 WHERE seq = 3;
      UPDATE audit SET seq = 3 WHERE seq = -1;
    `);
    expect(log.verify()).toMatchObject({ ok: false, count: 1, firstBadSeq: 2 });
  });

  it('detects unreadable data', () => {
    seed(2);
    dropTriggers();
    db.sqlite.exec(`UPDATE audit SET data = 'not json' WHERE seq = 2`);
    expect(log.verify()).toMatchObject({ ok: false, count: 1, firstBadSeq: 2 });
  });
});

describe('AuditLog list and export', () => {
  it('filters by action and subject and pages with afterSeq/limit', () => {
    const recs = seed(12);
    expect(log.list({ action: 'approval.decided' }).map((r) => r.seq)).toEqual([1, 4, 7, 10]);
    expect(log.list({ subject: 's1' }).map((r) => r.seq)).toEqual([2, 6, 10]);
    expect(log.list({ action: 'approval.decided', subject: 's2' }).map((r) => r.seq)).toEqual([7]);
    expect(log.list({ action: 'nope' })).toEqual([]);
    expect(log.list({ action: 'secret.set', subject: 's1' }).map((r) => r.seq)).toEqual([2, 6]);

    const pages: number[][] = [];
    let after = 0;
    for (;;) {
      const page = log.list({ afterSeq: after, limit: 5 });
      if (page.length === 0) break;
      pages.push(page.map((r) => r.seq));
      after = page.at(-1)!.seq;
    }
    expect(pages).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
      [11, 12],
    ]);
    expect(log.list()).toEqual(recs);
    expect(log.list({ limit: 0 })).toHaveLength(1);
  });

  it('exports JSONL that round-trips to the stored records, across pages', () => {
    const n = 1203; // > two export pages
    for (let i = 0; i < n; i++) log.append({ actor: 'system', action: 'tick', data: { i } });
    const lines: string[] = [];
    const count = log.exportJsonl((line) => lines.push(line));
    expect(count).toBe(n);
    expect(lines).toHaveLength(n);
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
    const parsed = lines.map((l) => JSON.parse(l) as AuditRecord);
    expect(parsed.map((r) => r.seq)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(parsed.slice(0, 1000)).toEqual(log.list({ limit: 1000 }));
    for (let i = 1; i < parsed.length; i++) expect(parsed[i]!.prevHash).toBe(parsed[i - 1]!.hash);
    expect(log.verify()).toMatchObject({ ok: true, count: n });
  });

  it('exports zero lines for an empty log', () => {
    const lines: string[] = [];
    expect(log.exportJsonl((l) => lines.push(l))).toBe(0);
    expect(lines).toEqual([]);
  });
});

describe('AuditLog performance', () => {
  it('appends and verifies 1000 records in well under 2s', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      log.append({ actor: 'bot:bot_1', action: 'tool.call', subject: 'run_1', data: { i } });
    }
    expect(log.verify()).toMatchObject({ ok: true, count: 1000 });
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
