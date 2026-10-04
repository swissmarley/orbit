import { createHash } from 'node:crypto';
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

export type AuditVerifyResult =
  { ok: true; count: number } | { ok: false; count: number; firstBadSeq: number; reason: string };

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
  };
}

export class AuditLog {
  /** prevHash of the first record. */
  static readonly GENESIS: string = '0'.repeat(64);

  private readonly lastHash: () => string | undefined;
  private readonly insertRow: (row: Omit<AuditRow, 'seq'>) => number;
  private readonly page: (afterSeq: number, limit: number) => AuditRow[];
  private readonly appendTx: (input: AuditInput) => AuditRecord;

  constructor(
    private readonly db: OrbitDb,
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {
    const sqlite = db.sqlite;
    const lastHashStmt = sqlite.prepare<[], { hash: string }>(
      'SELECT hash FROM audit ORDER BY seq DESC LIMIT 1',
    );
    const insertStmt = sqlite.prepare<[Omit<AuditRow, 'seq'>]>(
      `INSERT INTO audit (id, ts, actor, action, subject, data, prev_hash, hash)
       VALUES (@id, @ts, @actor, @action, @subject, @data, @prev_hash, @hash)`,
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
    const seq = this.insertRow({
      id,
      ts,
      actor: input.actor,
      action: input.action,
      subject,
      data: canonicalJson(data),
      prev_hash: prevHash,
      hash,
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
    };
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
   * seq gap) and reordered records.
   *
   * Limitation: truncating the TAIL (deleting the most recent records) leaves
   * a valid, shorter chain and cannot be detected by the chain alone. `count`
   * is returned so callers can compare it (and the last hash) against an
   * externally stored head, e.g. a periodically exported checkpoint. A later
   * append after a tail deletion IS detected, via the seq gap AUTOINCREMENT
   * leaves behind.
   *
   * On failure `count` is the number of records that verified before the
   * first bad one.
   */
  verify(): AuditVerifyResult {
    let prevHash = AuditLog.GENESIS;
    let expectedSeq = 1;
    let count = 0;
    let after = 0;
    for (;;) {
      const page = this.page(after, PAGE_SIZE);
      for (const row of page) {
        const bad = (reason: string): AuditVerifyResult => ({
          ok: false,
          count,
          firstBadSeq: row.seq,
          reason,
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
        prevHash = row.hash;
        expectedSeq = row.seq + 1;
        count++;
      }
      const last = page.at(-1);
      if (!last || page.length < PAGE_SIZE) break;
      after = last.seq;
    }
    return { ok: true, count };
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
