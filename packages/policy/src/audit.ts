import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { OrbitError, type Redactor, newId } from '@orbit/core';
import type { OrbitDb } from '@orbit/store';

/**
 * Tamper-evident, append-only audit log (PLAN.md §2.6, ADR-007).
 *
 * Every record carries the hash of its predecessor (`prevHash`) and its own
 * `hash = sha256(canonicalJson({prevHash, id, ts, actor, action, subject, data}))`,
 * so editing, deleting or reordering any record breaks the chain from that point
 * on. The table additionally has `BEFORE UPDATE/DELETE` triggers that reject
 * modification through SQL; the chain is what catches tampering that bypasses
 * them (e.g. dropping the triggers or editing the file directly).
 *
 * `data` (and `subject`) are deep-redacted before hashing and storing, so
 * secrets never enter the audit log.
 *
 * Keyed chain (M8): with the audit key loaded (32 random bytes in the OS
 * keychain or `<ORBIT_HOME>/audit.key`, never in the database) every record
 * also carries `mac = HMAC-SHA256(key, hash)`. Someone who can write the
 * database but does not hold the key can recompute every hash, but not the
 * MACs, so a whole-chain rewrite is detected too. Records written before the
 * key existed have no MAC and are reported as unkeyed, never as tampering;
 * after the first keyed record every record must be keyed. Signed
 * checkpoints (`checkpoint()`), kept elsewhere by the owner, additionally
 * catch a truncated tail and a rewrite that strips every MAC.
 */

export interface AuditRecord {
  seq: number;
  id: string;
  ts: string;
  /** 'owner', 'bot:<id>', 'system', … */
  actor: string;
  action: string;
  subject: string | null;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
  /** HMAC-SHA256(audit key, hash); null for records written before the key existed. */
  mac: string | null;
}

export interface AuditInput {
  actor: string;
  action: string;
  subject?: string | null;
  data?: Record<string, unknown>;
}

export interface AuditListOptions {
  /** Only records with `seq > afterSeq` (keyset paging). */
  afterSeq?: number;
  /** Maximum number of records (default 100, capped at 1000). */
  limit?: number;
  action?: string;
  subject?: string;
}

/** Which part of the chain is keyed (MACs), as verify() saw it. */
export interface AuditKeying {
  /** Records without a MAC: written before the audit key existed. */
  unkeyed: number;
  lastUnkeyedSeq: number | null;
  /** The first keyed record. */
  keyedSince: { seq: number; ts: string } | null;
}

export type AuditVerifyResult = (
  { ok: true; count: number } | { ok: false; count: number; firstBadSeq: number; reason: string }
) &
  AuditKeying;

/** The cheap view of the chain (no hashing): what Settings → Audit shows. */
export interface AuditStatus extends AuditKeying {
  /** An audit key is loaded, so new records are keyed. */
  keyed: boolean;
  count: number;
  head: { seq: number; hash: string; ts: string } | null;
}

/**
 * A signed head of the chain for the owner to keep outside ORBIT_HOME. The
 * MAC covers every other field, so it cannot be edited or forged without the
 * audit key.
 */
export interface AuditCheckpoint {
  kind: 'orbit-audit-checkpoint';
  v: 1;
  seq: number;
  hash: string;
  ts: string;
  /** Records in the log when the checkpoint was taken. */
  count: number;
  mac: string;
}

export interface AuditCheckpointResult {
  /** The chain verifies and still contains the checkpoint, signed by this key. */
  ok: boolean;
  /** Why not; null when ok. */
  reason: string | null;
  chain: AuditVerifyResult;
  /** Records appended after the checkpoint. */
  since: number;
}

interface AuditRow {
  seq: number;
  id: string;
  ts: string;
  actor: string;
  action: string;
  subject: string | null;
  data: string;
  prev_hash: string;
  hash: string;
  mac: string | null;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
/** Page size used by verify() and exportJsonl() so the log is never loaded at once. */
const PAGE_SIZE = 500;

/**
 * Deterministic JSON: object keys sorted (recursively, by UTF-16 code unit),
 * no whitespace. Follows JSON.stringify semantics otherwise: `toJSON()` is
 * honoured, `undefined`/functions/symbols are dropped from objects and become
 * `null` in arrays, non-finite numbers become `null`. Throws on bigint and
 * circular structures.
 */
export function canonicalJson(value: unknown): string {
  const out = serialize(value, []);
  if (out === undefined) throw new TypeError('canonicalJson: value is not JSON-serializable');
  return out;
}

function serialize(input: unknown, ancestors: object[]): string | undefined {
  let value = input;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not JSON-serializable');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'object':
      break;
  }
  const obj = value;
  if (ancestors.includes(obj)) throw new TypeError('canonicalJson: circular structure');
  ancestors.push(obj);
  let out: string;
  if (Array.isArray(obj)) {
    out = `[${obj.map((v) => serialize(v, ancestors) ?? 'null').join(',')}]`;
  } else {
    const rec = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(rec).sort()) {
      const v = serialize(rec[key], ancestors);
      if (v !== undefined) parts.push(`${JSON.stringify(key)}:${v}`);
    }
    out = `{${parts.join(',')}}`;
  }
  ancestors.pop();
  return out;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The hash of one record, given its predecessor's hash. */
function recordHash(r: {
  prevHash: string;
  id: string;
  ts: string;
  actor: string;
  action: string;
  subject: string | null;
  data: Record<string, unknown>;
}): string {
  return sha256Hex(
    canonicalJson({
      prevHash: r.prevHash,
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      subject: r.subject,
      data: r.data,
    }),
  );
}

function hmacHex(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex MACs (false for malformed input). */
function macEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  return a.length === 32 && b.length === a.length && timingSafeEqual(a, b);
}

/** What a checkpoint's MAC covers: every field but the MAC, canonically. */
function checkpointPayload(c: Omit<AuditCheckpoint, 'mac'>): string {
  return canonicalJson({
    kind: c.kind,
    v: c.v,
    seq: c.seq,
    hash: c.hash,
    ts: c.ts,
    count: c.count,
  });
}

function parseData(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function toRecord(row: AuditRow): AuditRecord {
  const data = parseData(row.data);
  if (!data) {
    throw new OrbitError('internal', `Audit record ${row.seq} has unreadable data`, {
      hint: 'Run `orbit audit verify` — the audit log may have been tampered with.',
    });
  }
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    action: row.action,
    subject: row.subject,
    data,
    prevHash: row.prev_hash,
    hash: row.hash,
    mac: row.mac,
  };
}

export class AuditLog {
  /** prevHash of the first record. */
  static readonly GENESIS: string = '0'.repeat(64);

  /** The first action of the keyed part of an upgraded log (see ensureKeyed()). */
  static readonly KEYED_ACTION: string = 'audit.keyed';

  private readonly lastHash: () => string | undefined;
  private readonly insertRow: (row: Omit<AuditRow, 'seq'>) => number;
  private readonly page: (afterSeq: number, limit: number) => AuditRow[];
  private readonly appendTx: (input: AuditInput) => AuditRecord;

  constructor(
    private readonly db: OrbitDb,
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
    /** The audit key; without it records are written unkeyed (tests). */
    private readonly key?: Buffer,
  ) {
    if (key !== undefined && key.length !== 32) {
      throw new OrbitError('invalid_config', 'The audit key must be 32 bytes');
    }
    const sqlite = db.sqlite;
    const lastHashStmt = sqlite.prepare<[], { hash: string }>(
      'SELECT hash FROM audit ORDER BY seq DESC LIMIT 1',
    );
    const insertStmt = sqlite.prepare<[Omit<AuditRow, 'seq'>]>(
      `INSERT INTO audit (id, ts, actor, action, subject, data, prev_hash, hash, mac)
       VALUES (@id, @ts, @actor, @action, @subject, @data, @prev_hash, @hash, @mac)`,
    );
    const pageStmt = sqlite.prepare<[number, number], AuditRow>(
      'SELECT * FROM audit WHERE seq > ? ORDER BY seq ASC LIMIT ?',
    );
    this.lastHash = () => lastHashStmt.get()?.hash;
    this.insertRow = (row) => Number(insertStmt.run(row).lastInsertRowid);
    this.page = (afterSeq, limit) => pageStmt.all(afterSeq, limit);
    // Read-last-hash + insert must be atomic, or two writers could fork the chain.
    const tx = sqlite.transaction((input: AuditInput) => this.appendUnsafe(input));
    // IMMEDIATE: take the write lock before reading the last hash.
    this.appendTx = (input) => tx.immediate(input);
  }

  /** Append one record (synchronous, in a transaction). Returns the stored record. */
  append(input: AuditInput): AuditRecord {
    return this.appendTx(input);
  }

  private appendUnsafe(input: AuditInput): AuditRecord {
    const date = this.now();
    const ts = date.toISOString();
    const id = newId('aud', date.getTime());
    const subject =
      input.subject === undefined || input.subject === null
        ? null
        : this.redactor.redactString(input.subject);
    const data = this.normalizeData(input.data ?? {});
    const prevHash = this.lastHash() ?? AuditLog.GENESIS;
    const hash = recordHash({
      prevHash,
      id,
      ts,
      actor: input.actor,
      action: input.action,
      subject,
      data,
    });
    const mac = this.key ? hmacHex(this.key, hash) : null;
    const seq = this.insertRow({
      id,
      ts,
      actor: input.actor,
      action: input.action,
      subject,
      data: canonicalJson(data),
      prev_hash: prevHash,
      hash,
      mac,
    });
    return {
      seq,
      id,
      ts,
      actor: input.actor,
      action: input.action,
      subject,
      data,
      prevHash,
      hash,
      mac,
    };
  }

  /** True when an audit key is loaded (new records are keyed). */
  get keyed(): boolean {
    return this.key !== undefined;
  }

  /**
   * Mark where an upgraded log becomes keyed: when a key is loaded and the
   * newest record has no MAC, append an `audit.keyed` record (itself keyed).
   * verify() refuses an `audit.keyed` record without a MAC and any unkeyed
   * record after a keyed one, so stripping MACs later is tampering. A no-op on
   * an empty or already keyed log. Returns the marker when one was written.
   */
  ensureKeyed(data: Record<string, unknown> = {}): AuditRecord | undefined {
    if (!this.key) return undefined;
    const tx = this.db.sqlite.transaction(() => {
      const last = this.db.sqlite
        .prepare<[], { mac: string | null }>('SELECT mac FROM audit ORDER BY seq DESC LIMIT 1')
        .get();
      // Empty, or the head is keyed already.
      if (last?.mac !== null) return undefined;
      const unkeyed = this.unkeyedStats();
      return this.appendUnsafe({
        actor: 'system',
        action: AuditLog.KEYED_ACTION,
        data: { ...data, unkeyedRecords: unkeyed.unkeyed, lastUnkeyedSeq: unkeyed.lastUnkeyedSeq },
      });
    });
    return tx.immediate();
  }

  private unkeyedStats(): { unkeyed: number; lastUnkeyedSeq: number | null } {
    const row = this.db.sqlite
      .prepare<[], { n: number; last: number | null }>(
        'SELECT count(*) AS n, max(seq) AS last FROM audit WHERE mac IS NULL',
      )
      .get();
    return { unkeyed: row?.n ?? 0, lastUnkeyedSeq: row?.last ?? null };
  }

  private recordCount(): number {
    return (
      this.db.sqlite.prepare<[], { n: number }>('SELECT count(*) AS n FROM audit').get()?.n ?? 0
    );
  }

  /** Counts and the head, without hashing anything (verify() is the check). */
  status(): AuditStatus {
    const sqlite = this.db.sqlite;
    const head = sqlite
      .prepare<[], { seq: number; hash: string; ts: string }>(
        'SELECT seq, hash, ts FROM audit ORDER BY seq DESC LIMIT 1',
      )
      .get();
    const first = sqlite
      .prepare<[], { seq: number; ts: string }>(
        'SELECT seq, ts FROM audit WHERE mac IS NOT NULL ORDER BY seq ASC LIMIT 1',
      )
      .get();
    return {
      keyed: this.keyed,
      count: this.recordCount(),
      head: head ?? null,
      keyedSince: first ?? null,
      ...this.unkeyedStats(),
    };
  }

  /**
   * Append an `audit.checkpoint` record for `actor` and return a checkpoint
   * of it, signed with the audit key. The owner keeps the JSON elsewhere;
   * verifyCheckpoint() later proves the log still contains it.
   */
  checkpoint(actor: string): AuditCheckpoint {
    const key = this.requireKey('take a checkpoint');
    const tx = this.db.sqlite.transaction(() => {
      const count = this.recordCount() + 1;
      const rec = this.appendUnsafe({ actor, action: 'audit.checkpoint', data: { count } });
      const body: Omit<AuditCheckpoint, 'mac'> = {
        kind: 'orbit-audit-checkpoint',
        v: 1,
        seq: rec.seq,
        hash: rec.hash,
        ts: rec.ts,
        count,
      };
      return { ...body, mac: hmacHex(key, checkpointPayload(body)) };
    });
    return tx.immediate();
  }

  /**
   * Check a checkpoint against the log: its MAC must match this key (so it
   * was not edited or forged; the MAC covers `kind` and `v` too), the record at its seq must still exist with
   * the same hash and a valid MAC (catching a truncated tail and a rewritten
   * chain), and the whole chain must verify.
   */
  verifyCheckpoint(cp: AuditCheckpoint): AuditCheckpointResult {
    const key = this.requireKey('verify a checkpoint');
    const chain = this.verify();
    const count = this.recordCount();
    const fail = (reason: string): AuditCheckpointResult => ({
      ok: false,
      reason,
      chain,
      since: Math.max(0, count - cp.count),
    });
    if (!macEqual(hmacHex(key, checkpointPayload(cp)), cp.mac)) {
      return fail(
        'the checkpoint is not signed by this audit key (it was edited, or the key changed)',
      );
    }
    const row = this.db.sqlite
      .prepare<[number], AuditRow>('SELECT * FROM audit WHERE seq = ?')
      .get(cp.seq);
    if (!row) {
      const headSeq = this.status().head?.seq ?? 0;
      return fail(
        headSeq < cp.seq
          ? `the log ends at #${headSeq}, before the checkpoint's #${cp.seq} (records were removed)`
          : `record #${cp.seq} is missing (records were removed)`,
      );
    }
    if (row.hash !== cp.hash || row.ts !== cp.ts) {
      return fail(`record #${cp.seq} differs from the checkpoint (the log was rewritten)`);
    }
    if (row.mac === null || !macEqual(hmacHex(key, row.hash), row.mac)) {
      return fail(`record #${cp.seq} no longer carries a valid MAC (the log was rewritten)`);
    }
    if (count < cp.count) {
      return fail(`the log holds ${count} records, fewer than the checkpoint's ${cp.count}`);
    }
    if (!chain.ok) {
      return fail(`the chain is broken at #${chain.firstBadSeq}: ${chain.reason}`);
    }
    return { ok: true, reason: null, chain, since: count - cp.count };
  }

  private requireKey(what: string): Buffer {
    if (!this.key) {
      throw new OrbitError('invalid_config', `No audit key is loaded, so Orbit cannot ${what}`, {
        hint: 'orbitd loads the key from the OS keychain or <ORBIT_HOME>/audit.key.',
      });
    }
    return this.key;
  }

  /**
   * Round-trip through JSON (so Dates become strings and undefined is dropped
   * before the redactor walks the value), then deep-redact. The result is
   * plain JSON, i.e. exactly what verify() will read back and re-hash.
   */
  private normalizeData(raw: Record<string, unknown>): Record<string, unknown> {
    let plain: Record<string, unknown> | undefined;
    try {
      plain = parseData(canonicalJson(raw));
    } catch (err) {
      throw new OrbitError('invalid_input', 'Audit data must be JSON-serializable', {
        cause: err,
      });
    }
    if (!plain) throw new OrbitError('invalid_input', 'Audit data must be a JSON object');
    return this.redactor.redact(plain);
  }

  /** Records in ascending `seq` order, optionally filtered; page with `afterSeq`. */
  list(opts: AuditListOptions = {}): AuditRecord[] {
    const where: string[] = ['seq > ?'];
    const params: (string | number)[] = [opts.afterSeq ?? 0];
    if (opts.action !== undefined) {
      where.push('action = ?');
      params.push(opts.action);
    }
    if (opts.subject !== undefined) {
      where.push('subject = ?');
      params.push(opts.subject);
    }
    const limit = Math.max(
      1,
      Math.min(MAX_LIST_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIST_LIMIT)),
    );
    params.push(limit);
    const rows = this.db.sqlite
      .prepare<(string | number)[], AuditRow>(
        `SELECT * FROM audit WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
      )
      .all(...params);
    return rows.map(toRecord);
  }

  /**
   * Recompute the chain from GENESIS. Detects modified records (any hashed
   * field), records deleted from the start or middle (prev_hash mismatch and
   * seq gap) and reordered records. With the audit key it also checks every
   * MAC, which catches a whole-chain rewrite with recomputed hashes, and
   * refuses an unkeyed record after the first keyed one (a stripped MAC).
   * Unkeyed records before that point were written before the upgrade and
   * are counted, not reported as tampering.
   *
   * Limitation: truncating the TAIL (deleting the most recent records) leaves
   * a valid, shorter chain and cannot be detected by the chain alone; a
   * checkpoint the owner kept (verifyCheckpoint()) catches it. A later append
   * after a tail deletion IS detected, via the seq gap AUTOINCREMENT leaves
   * behind.
   *
   * On failure `count` is the number of records that verified before the
   * first bad one.
   */
  verify(): AuditVerifyResult {
    let prevHash = AuditLog.GENESIS;
    let expectedSeq = 1;
    let count = 0;
    let after = 0;
    const keying: AuditKeying = { unkeyed: 0, lastUnkeyedSeq: null, keyedSince: null };
    for (;;) {
      const page = this.page(after, PAGE_SIZE);
      for (const row of page) {
        const bad = (reason: string): AuditVerifyResult => ({
          ok: false,
          count,
          firstBadSeq: row.seq,
          reason,
          ...keying,
        });
        if (row.seq !== expectedSeq) {
          return bad(`sequence gap: expected seq ${expectedSeq}, found ${row.seq}`);
        }
        if (row.prev_hash !== prevHash) {
          return bad('prev_hash does not match the previous record (deleted or reordered)');
        }
        const data = parseData(row.data);
        if (!data) return bad('data is not a JSON object');
        const expected = recordHash({
          prevHash: row.prev_hash,
          id: row.id,
          ts: row.ts,
          actor: row.actor,
          action: row.action,
          subject: row.subject,
          data,
        });
        if (expected !== row.hash) return bad('hash mismatch (record modified)');
        if (row.mac === null) {
          if (keying.keyedSince) {
            return bad('MAC missing after the log became keyed (record rewritten without the key)');
          }
          if (row.action === AuditLog.KEYED_ACTION) {
            return bad('the keyed marker has no MAC (record rewritten without the key)');
          }
          keying.unkeyed++;
          keying.lastUnkeyedSeq = row.seq;
        } else {
          if (!this.key) return bad('record carries a MAC but no audit key is loaded');
          if (!macEqual(hmacHex(this.key, row.hash), row.mac)) {
            return bad(
              'MAC mismatch (record rewritten without the audit key, or the audit key changed)',
            );
          }
          keying.keyedSince ??= { seq: row.seq, ts: row.ts };
        }
        prevHash = row.hash;
        expectedSeq = row.seq + 1;
        count++;
      }
      const last = page.at(-1);
      if (!last || page.length < PAGE_SIZE) break;
      after = last.seq;
    }
    return { ok: true, count, ...keying };
  }

  /**
   * Write every record as one JSON line (no newline inside `line`), in seq
   * order, paging through the table. Returns the number of records written.
   */
  exportJsonl(write: (line: string) => void): number {
    let count = 0;
    let after = 0;
    for (;;) {
      const page = this.page(after, PAGE_SIZE);
      for (const row of page) {
        write(JSON.stringify(toRecord(row)));
        count++;
      }
      const last = page.at(-1);
      if (!last || page.length < PAGE_SIZE) break;
      after = last.seq;
    }
    return count;
  }
}
