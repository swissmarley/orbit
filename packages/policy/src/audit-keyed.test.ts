import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor } from '@orbit/core';
import { type OrbitDb, openDatabase } from '@orbit/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, type AuditCheckpoint, type AuditRecord, canonicalJson } from './audit';
import { type KeychainLike, loadAuditKey } from './keys';

const POSIX = process.platform !== 'win32';
const KEY = Buffer.alloc(32, 7);

let db: OrbitDb;
let clock: number;
const now = () => new Date(Date.UTC(2026, 9, 4, 12, 0, 0) + clock++ * 1000);
const keyed = (key: Buffer = KEY) => new AuditLog(db, new Redactor([]), now, key);
const unkeyed = () => new AuditLog(db, new Redactor([]), now);

beforeEach(() => {
  clock = 0;
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
});

function seed(log: AuditLog, n: number): AuditRecord[] {
  return Array.from({ length: n }, (_, i) =>
    log.append({ actor: 'owner', action: 'tick', subject: `s${i}`, data: { i } }),
  );
}

function dropTriggers(): void {
  db.sqlite.exec('DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;');
}

const sha = (r: Omit<AuditRecord, 'seq' | 'hash' | 'mac'>) =>
  createHash('sha256')
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

/**
 * An attacker with write access to the database but not the key: change
 * record `fromSeq`'s action, then recompute every hash from there on so the
 * plain chain verifies again. `mac` decides what they do with the MACs.
 */
function rewriteChain(fromSeq: number, mac: (hash: string) => string | null): void {
  dropTriggers();
  const rows = db.sqlite.prepare('SELECT * FROM audit ORDER BY seq').all() as {
    seq: number;
    id: string;
    ts: string;
    actor: string;
    action: string;
    subject: string | null;
    data: string;
    prev_hash: string;
  }[];
  let prev = AuditLog.GENESIS;
  for (const row of rows) {
    if (row.seq < fromSeq) {
      prev = (
        db.sqlite.prepare('SELECT hash FROM audit WHERE seq = ?').get(row.seq) as {
          hash: string;
        }
      ).hash;
      continue;
    }
    const action = row.seq === fromSeq ? 'nothing.happened' : row.action;
    const hash = sha({
      prevHash: prev,
      id: row.id,
      ts: row.ts,
      actor: row.actor,
      action,
      subject: row.subject,
      data: JSON.parse(row.data) as Record<string, unknown>,
    });
    db.sqlite
      .prepare('UPDATE audit SET action = ?, prev_hash = ?, hash = ?, mac = ? WHERE seq = ?')
      .run(action, prev, hash, mac(hash), row.seq);
    prev = hash;
  }
}

describe('keyed audit chain', () => {
  it('stores HMAC-SHA256(key, hash) with every record and verifies it', () => {
    const log = keyed();
    const recs = seed(log, 3);
    for (const r of recs) {
      expect(r.mac).toBe(createHmac('sha256', KEY).update(r.hash).digest('hex'));
    }
    expect(log.list().map((r) => r.mac)).toEqual(recs.map((r) => r.mac));
    expect(log.verify()).toEqual({
      ok: true,
      count: 3,
      unkeyed: 0,
      lastUnkeyedSeq: null,
      keyedSince: { seq: 1, ts: recs[0]!.ts },
    });
    expect(log.status()).toMatchObject({ keyed: true, count: 3, unkeyed: 0 });
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new AuditLog(db, new Redactor([]), now, Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it('detects an edited record', () => {
    const log = keyed();
    seed(log, 4);
    dropTriggers();
    db.sqlite.exec(`UPDATE audit SET data = '{"i":99}' WHERE seq = 2`);
    expect(log.verify()).toMatchObject({
      ok: false,
      firstBadSeq: 2,
      reason: expect.stringMatching(/hash mismatch/) as string,
    });
  });

  it('detects a deletion with the triggers dropped', () => {
    const log = keyed();
    seed(log, 4);
    dropTriggers();
    db.sqlite.exec('DELETE FROM audit WHERE seq = 2');
    expect(log.verify()).toMatchObject({ ok: false, firstBadSeq: 3 });
  });

  it('detects reordered records', () => {
    const log = keyed();
    seed(log, 4);
    dropTriggers();
    db.sqlite.exec(`
      UPDATE audit SET seq = -1 WHERE seq = 2;
      UPDATE audit SET seq = 2 WHERE seq = 3;
      UPDATE audit SET seq = 3 WHERE seq = -1;
    `);
    expect(log.verify()).toMatchObject({ ok: false, firstBadSeq: 2 });
  });

  it('detects a whole-chain rewrite with recomputed hashes but the old MACs', () => {
    const log = keyed();
    seed(log, 5);
    rewriteChain(2, () => 'ab'.repeat(32));
    expect(log.verify()).toMatchObject({
      ok: false,
      count: 1,
      firstBadSeq: 2,
      reason: expect.stringMatching(/MAC/) as string,
    });
  });

  it('detects a whole-chain rewrite signed with a different key', () => {
    const log = keyed();
    seed(log, 5);
    const other = randomBytes(32);
    rewriteChain(1, (h) => createHmac('sha256', other).update(h).digest('hex'));
    expect(log.verify()).toMatchObject({
      ok: false,
      count: 0,
      firstBadSeq: 1,
      reason: expect.stringMatching(/MAC/) as string,
    });
  });

  it('detects MACs stripped from the keyed part of the chain', () => {
    const log = keyed();
    seed(log, 5);
    rewriteChain(3, () => null);
    expect(log.verify()).toMatchObject({
      ok: false,
      count: 2,
      firstBadSeq: 3,
      reason: expect.stringMatching(/MAC missing/) as string,
    });
  });

  it('reports a wrong key as tampering at the first keyed record', () => {
    seed(keyed(), 3);
    expect(keyed(randomBytes(32)).verify()).toMatchObject({
      ok: false,
      count: 0,
      firstBadSeq: 1,
      reason: expect.stringMatching(/audit key changed/) as string,
    });
  });

  it('fails closed on a keyed record when no key is loaded', () => {
    seed(keyed(), 1);
    expect(unkeyed().verify()).toMatchObject({
      ok: false,
      firstBadSeq: 1,
      reason: expect.stringMatching(/no audit key/) as string,
    });
  });

  it('cannot see a tail truncation from the chain alone (a checkpoint can)', () => {
    const log = keyed();
    seed(log, 4);
    const cp = log.checkpoint('owner');
    dropTriggers();
    db.sqlite.exec(`DELETE FROM audit WHERE seq >= ${cp.seq - 1}`);
    expect(log.verify()).toMatchObject({ ok: true, count: 3 });
    expect(log.verifyCheckpoint(cp)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/log ends at #3, before the checkpoint's #5/) as string,
    });
  });
});

describe('upgrading an unkeyed log', () => {
  it('reports pre-upgrade records as unkeyed, never as tampering', () => {
    seed(unkeyed(), 3);
    const log = keyed();
    expect(log.verify()).toEqual({
      ok: true,
      count: 3,
      unkeyed: 3,
      lastUnkeyedSeq: 3,
      keyedSince: null,
    });
    const marker = log.ensureKeyed({ keySource: 'file' });
    expect(marker).toMatchObject({
      seq: 4,
      actor: 'system',
      action: 'audit.keyed',
      data: { keySource: 'file', unkeyedRecords: 3, lastUnkeyedSeq: 3 },
    });
    expect(marker?.mac).toMatch(/^[0-9a-f]{64}$/);
    // idempotent: the head is keyed now
    expect(log.ensureKeyed()).toBeUndefined();
    seed(log, 2);
    expect(log.verify()).toEqual({
      ok: true,
      count: 6,
      unkeyed: 3,
      lastUnkeyedSeq: 3,
      keyedSince: { seq: 4, ts: marker!.ts },
    });
    expect(log.status()).toMatchObject({
      keyed: true,
      count: 6,
      unkeyed: 3,
      lastUnkeyedSeq: 3,
      keyedSince: { seq: 4 },
    });
  });

  it('does nothing on an empty log or without a key', () => {
    expect(keyed().ensureKeyed()).toBeUndefined();
    seed(unkeyed(), 1);
    expect(unkeyed().ensureKeyed()).toBeUndefined();
    expect(unkeyed().status()).toMatchObject({ keyed: false, keyedSince: null, unkeyed: 1 });
  });

  it('refuses a keyed marker whose MAC was stripped', () => {
    seed(unkeyed(), 2);
    const log = keyed();
    log.ensureKeyed();
    dropTriggers();
    db.sqlite.exec(`UPDATE audit SET mac = NULL WHERE action = 'audit.keyed'`);
    expect(log.verify()).toMatchObject({
      ok: false,
      firstBadSeq: 3,
      reason: expect.stringMatching(/keyed marker/) as string,
    });
  });

  it('refuses an unkeyed record appended after the log became keyed', () => {
    seed(unkeyed(), 1);
    const log = keyed();
    log.ensureKeyed();
    seed(unkeyed(), 1);
    expect(log.verify()).toMatchObject({
      ok: false,
      firstBadSeq: 3,
      reason: expect.stringMatching(/MAC missing/) as string,
    });
  });
});

describe('audit checkpoints', () => {
  it('round-trips through JSON and counts the records appended since', () => {
    const log = keyed();
    seed(log, 3);
    const cp = log.checkpoint('owner');
    expect(cp).toMatchObject({ kind: 'orbit-audit-checkpoint', v: 1, seq: 4, count: 4 });
    expect(cp.mac).toMatch(/^[0-9a-f]{64}$/);
    const head = log.list().at(-1)!;
    expect(head).toMatchObject({ seq: 4, actor: 'owner', action: 'audit.checkpoint' });
    expect(cp.hash).toBe(head.hash);
    expect(cp.ts).toBe(head.ts);
    const kept = JSON.parse(JSON.stringify(cp)) as AuditCheckpoint;
    expect(log.verifyCheckpoint(kept)).toMatchObject({ ok: true, reason: null, since: 0 });
    seed(log, 2);
    expect(log.verifyCheckpoint(kept)).toMatchObject({ ok: true, since: 2 });
  });

  it('refuses an edited checkpoint', () => {
    const log = keyed();
    seed(log, 2);
    const cp = log.checkpoint('owner');
    for (const edited of [
      { ...cp, count: cp.count - 1 },
      { ...cp, seq: cp.seq - 1 },
      { ...cp, hash: '0'.repeat(64) },
      { ...cp, mac: 'not-hex' },
    ]) {
      expect(log.verifyCheckpoint(edited)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/not signed by this audit key/) as string,
      });
    }
  });

  it('refuses a checkpoint signed with a different key', () => {
    const log = keyed();
    seed(log, 2);
    const cp = keyed(randomBytes(32)).checkpoint('owner');
    expect(log.verifyCheckpoint(cp)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not signed/) as string,
    });
  });

  it('catches a rewrite that strips every MAC and recomputes every hash', () => {
    const log = keyed();
    seed(log, 3);
    const cp = log.checkpoint('owner');
    rewriteChain(1, () => null);
    // Without the checkpoint this looks like an old, never-keyed log …
    expect(log.verify()).toMatchObject({ ok: true, unkeyed: 4, keyedSince: null });
    // … the checkpoint the owner kept says otherwise.
    expect(log.verifyCheckpoint(cp)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/record #4 differs from the checkpoint/) as string,
    });
  });

  it('catches a truncation after the checkpoint followed by new records', () => {
    const log = keyed();
    seed(log, 2);
    const cp = log.checkpoint('owner');
    seed(log, 2);
    dropTriggers();
    db.sqlite.exec(`DELETE FROM audit WHERE seq >= ${cp.seq}`);
    expect(log.verifyCheckpoint(cp)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/log ends at #2/) as string,
    });
    seed(log, 1);
    expect(log.verifyCheckpoint(cp)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/record #3 is missing/) as string,
    });
  });

  it('reports a broken chain even when the checkpoint record is intact', () => {
    const log = keyed();
    seed(log, 3);
    const cp = log.checkpoint('owner');
    dropTriggers();
    db.sqlite.exec(`UPDATE audit SET data = '{"i":42}' WHERE seq = 2`);
    expect(log.verifyCheckpoint(cp)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/chain is broken at #2/) as string,
      chain: { ok: false, firstBadSeq: 2 },
    });
  });

  it('needs the key to take or verify a checkpoint', () => {
    const log = unkeyed();
    expect(() => log.checkpoint('owner')).toThrow(
      expect.objectContaining({ code: 'invalid_config' }) as Error,
    );
  });
});

describe('the audit key', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orbit-auditkey-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is created once as <home>/audit.key (0600), separate from the vault key', () => {
    const home = join(root, 'home');
    const first = loadAuditKey({ home, keySource: 'file' });
    expect(first).toMatchObject({ source: 'file', created: true });
    expect(first.key).toHaveLength(32);
    const again = loadAuditKey({ home, keySource: 'file' });
    expect(again).toMatchObject({ source: 'file', created: false });
    expect(again.key.equals(first.key)).toBe(true);
    if (POSIX) expect(statSync(join(home, 'audit.key')).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual(['audit.key']);
  });

  it('uses its own keychain entry when the keychain holds it', () => {
    const stored = randomBytes(32).toString('base64');
    const kc: KeychainLike = { getPassword: () => stored, setPassword: () => undefined };
    const k = loadAuditKey({ home: join(root, 'home'), keychain: kc });
    expect(k).toMatchObject({ source: 'keychain', created: false });
    expect(k.key.toString('base64')).toBe(stored);
  });

  it('never lands in the database file', () => {
    const home = join(root, 'home');
    const { key } = loadAuditKey({ home, keySource: 'file' });
    const fileDb = openDatabase(join(home, 'orbit.db'));
    try {
      const log = new AuditLog(fileDb, new Redactor([]), now, key);
      for (let i = 0; i < 20; i++) log.append({ actor: 'owner', action: 'tick', data: { i } });
      log.checkpoint('owner');
      log.verify();
      fileDb.sqlite.pragma('wal_checkpoint(TRUNCATE)');
      const bytes = readdirSync(home)
        .filter((f) => f.startsWith('orbit.db'))
        .map((f) => readFileSync(join(home, f)).toString('latin1'))
        .join('');
      for (const form of [key.toString('base64'), key.toString('hex'), key.toString('latin1')]) {
        expect(bytes).not.toContain(form);
      }
      expect(JSON.stringify(log.list({ limit: 1000 }))).not.toContain(key.toString('base64'));
    } finally {
      fileDb.close();
    }
  });
});
