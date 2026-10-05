import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FeedbackSignal,
  MEMORY_LIMITS,
  type Memory,
  type MemoryHit,
  type MemoryKind,
  type MemorySource,
  OrbitError,
  type Redactor,
  defaultRedactor,
  newId,
} from '@orbit/core';
import type { OrbitDb } from '@orbit/store';
import type { ImportedMemory } from './portable';

interface Row {
  seq: number;
  id: string;
  bot_id: string;
  kind: string;
  source: string;
  title: string;
  body: string;
  taint: string;
  run_id: string | null;
  approval_id: string | null;
  signal: string | null;
  pinned: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
}

function toMemory(r: Row): Memory {
  return {
    id: r.id,
    botId: r.bot_id,
    kind: r.kind as MemoryKind,
    source: r.source as MemorySource,
    title: r.title,
    body: r.body,
    taint: JSON.parse(r.taint) as string[],
    runId: r.run_id,
    approvalId: r.approval_id,
    signal: r.signal as FeedbackSignal | null,
    pinned: r.pinned === 1,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    editedAt: r.edited_at,
  };
}

export interface NewMemory {
  botId: string;
  kind: MemoryKind;
  source: MemorySource;
  title: string;
  body: string;
  /** Untrusted sources that influenced the text; empty = trusted. */
  taint?: readonly string[];
  runId?: string | null;
  approvalId?: string | null;
  signal?: FeedbackSignal | null;
  pinned?: boolean;
  createdBy: string;
}

export interface MemoryPatch {
  title?: string | undefined;
  body?: string | undefined;
  pinned?: boolean | undefined;
  /** The owner vouches for an untrusted memory: clears its taint. */
  trusted?: boolean | undefined;
}

export interface MemoryQuery {
  botId?: string | undefined;
  kind?: MemoryKind | undefined;
  /** Full-text search (FTS5). Words are matched as prefixes. */
  query?: string | undefined;
  /** 'all' words (browsing, default) or 'any' word (relevance for a Run's context). */
  match?: 'all' | 'any';
  /** Only memories without taint. */
  trustedOnly?: boolean;
  limit?: number;
}

/** Bounded, de-duplicated list of untrusted sources. */
export function mergeTaint(...lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const s of list) {
      if (!out.includes(s)) out.push(s);
    }
  }
  return out.slice(0, MEMORY_LIMITS.taintSources);
}

/**
 * A safe FTS5 query from free text: only word tokens, each quoted (so no
 * FTS operator or column filter can be injected), matched as prefixes.
 */
export function ftsQuery(text: string, match: 'all' | 'any' = 'all'): string | null {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((w) => w.length >= 2)
    .slice(0, 24);
  if (words.length === 0) return null;
  return [...new Set(words)].map((w) => `"${w}"*`).join(match === 'all' ? ' AND ' : ' OR ');
}

/**
 * C0 controls but tab and newline, and DEL: memory text reaches prompts and
 * terminals, and a NUL would make every later spawn of the engine fail
 * (review M6 M3).
 */
export function stripControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** Memories the per-Bot bound and retention may drop: unpinned Bot notes and run summaries. */
const DROPPABLE = "source IN ('bot', 'summarizer') AND pinned = 0";

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Front matter values are single-line and quoted. */
const yaml = (v: string) => JSON.stringify(v.replace(/[\r\n]+/g, ' '));

/** The human-readable mirror of a memory (`$ORBIT_HOME/memory/<bot>/<id>.md`). */
export function memoryMarkdown(m: Memory): string {
  const lines = [
    '---',
    `id: ${m.id}`,
    `bot: ${m.botId}`,
    `kind: ${m.kind}`,
    `source: ${m.source}`,
    `trust: ${m.taint.length > 0 ? 'untrusted' : 'trusted'}`,
    `taint: [${m.taint.map(yaml).join(', ')}]`,
    ...(m.runId ? [`run: ${m.runId}`] : []),
    ...(m.approvalId ? [`approval: ${m.approvalId}`] : []),
    ...(m.signal ? [`signal: ${m.signal}`] : []),
    `pinned: ${m.pinned}`,
    `created: ${m.createdAt}`,
    `updated: ${m.updatedAt}`,
    '---',
    '',
    `# ${m.title.replace(/[\r\n]+/g, ' ')}`,
    '',
    m.body,
    '',
  ];
  return lines.join('\n');
}

/**
 * Durable Bot memory: rows in SQLite with an FTS5 index, mirrored as
 * markdown files for people (orbitd is the only writer; the files are never
 * read back). Every title and body is redacted before it is stored, so no
 * registered secret or recognised credential can end up in memory.
 */
export class MemoryStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: OrbitDb,
    private readonly opts: {
      redactor?: Redactor;
      /** Directory of the markdown mirror; omitted = no mirror (tests). */
      dir?: string | null;
      now?: () => Date;
      /** Memories kept per Bot (config `memory.maxPerBot`); default MEMORY_LIMITS.perBot. */
      maxPerBot?: number;
    } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Memories kept per Bot. */
  get maxPerBot(): number {
    return Math.max(
      1,
      Math.min(this.opts.maxPerBot ?? MEMORY_LIMITS.perBot, MEMORY_LIMITS.perBotCeiling),
    );
  }

  private get redactor(): Redactor {
    return this.opts.redactor ?? defaultRedactor;
  }

  private mirror(m: Memory): void {
    if (!this.opts.dir) return;
    const dir = join(this.opts.dir, m.botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${m.id}.md`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, memoryMarkdown(m), { mode: 0o600 });
    renameSync(tmp, file);
  }

  private unmirror(m: Memory): void {
    if (!this.opts.dir) return;
    rmSync(join(this.opts.dir, m.botId, `${m.id}.md`), { force: true });
  }

  private clean(title: string, body: string): { title: string; body: string } {
    const t = this.redactor.redactString(
      stripControls(title)
        .replace(/[\r\n]+/g, ' ')
        .trim(),
    );
    return {
      title: clip(t || 'Untitled', MEMORY_LIMITS.titleChars),
      body: clip(this.redactor.redactString(stripControls(body)), MEMORY_LIMITS.bodyChars),
    };
  }

  count(botId: string): number {
    const row = this.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE bot_id = ?')
      .get(botId) as { n: number };
    return row.n;
  }

  /** Memories with taint (never offered automatically). */
  countUntrusted(botId: string): number {
    const row = this.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE bot_id = ? AND taint != '[]'")
      .get(botId) as { n: number };
    return row.n;
  }

  create(input: NewMemory): Memory {
    const taint = mergeTaint(input.taint ?? []);
    if (input.pinned && taint.length > 0) {
      throw new OrbitError('invalid_input', 'An untrusted memory cannot be pinned');
    }
    const { title, body } = this.clean(input.title, input.body);
    const ts = this.now().toISOString();
    const m: Memory = {
      id: newId('mem', this.now().getTime()),
      botId: input.botId,
      kind: input.kind,
      source: input.source,
      title,
      body,
      taint,
      runId: input.runId ?? null,
      approvalId: input.approvalId ?? null,
      signal: input.signal ?? null,
      pinned: input.pinned ?? false,
      createdBy: input.createdBy,
      createdAt: ts,
      updatedAt: ts,
      editedAt: null,
    };
    const evicted = this.db.sqlite.transaction(() => {
      const dropped = this.makeRoom(m.botId, 1);
      this.insert(m);
      return dropped;
    })();
    for (const e of evicted) this.unmirror(e);
    this.mirror(m);
    return m;
  }

  /**
   * Keep the store bounded: drop the oldest Bot notes or summaries, untrusted
   * ones first, until `incoming` more fit. Never the owner's facts or
   * feedback, never a pinned memory (review M6 M4). Call inside a transaction.
   */
  private makeRoom(botId: string, incoming: number): Memory[] {
    const evicted: Memory[] = [];
    let over = this.count(botId) - this.maxPerBot + incoming;
    while (over > 0) {
      const old = this.db.sqlite
        .prepare(
          `SELECT * FROM memories WHERE bot_id = ? AND ${DROPPABLE}
           ORDER BY (taint = '[]') ASC, seq ASC LIMIT 1`,
        )
        .get(botId) as Row | undefined;
      if (!old) {
        throw new OrbitError(
          'blocked',
          `This Bot keeps ${this.maxPerBot} memories and none of them can be dropped automatically (yours, your feedback, pinned)`,
          { hint: 'Delete some in the memory browser, or raise memory.maxPerBot.' },
        );
      }
      this.db.sqlite.prepare('DELETE FROM memories WHERE seq = ?').run(old.seq);
      evicted.push(toMemory(old));
      over -= 1;
    }
    return evicted;
  }

  private insert(m: Memory): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO memories (id, bot_id, kind, source, title, body, taint, run_id, approval_id,
           signal, pinned, created_by, created_at, updated_at, edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.botId,
        m.kind,
        m.source,
        m.title,
        m.body,
        JSON.stringify(m.taint),
        m.runId,
        m.approvalId,
        m.signal,
        m.pinned ? 1 : 0,
        m.createdBy,
        m.createdAt,
        m.updatedAt,
        m.editedAt,
      );
  }

  /** Memories the bound may never drop: the owner's, feedback, pinned. */
  private countKept(botId: string): number {
    const row = this.db.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM memories WHERE bot_id = ? AND NOT (${DROPPABLE})`)
      .get(botId) as { n: number };
    return row.n;
  }

  /**
   * What importing `n` memories into a Bot would do to the bound: how many
   * existing Bot notes and summaries go, or why it cannot fit.
   */
  importPlan(botId: string, n: number): { evicts: number; fits: boolean } {
    return {
      evicts: Math.max(0, this.count(botId) + n - this.maxPerBot),
      fits: n + this.countKept(botId) <= this.maxPerBot,
    };
  }

  /**
   * Import memories into a Bot (owner only, ADR-012 M8): ids are new, the
   * provenance (source, taint, Run, pinned, timestamps) is kept, the text
   * goes through the same redaction and control stripping as any write.
   * `forceTaint` marks every memory untrusted with that source. An
   * untrusted memory is never pinned. All or nothing: room is made by
   * dropping existing Bot notes and summaries only, never other imports.
   */
  importMany(
    botId: string,
    items: readonly ImportedMemory[],
    opts: { createdBy: string; forceTaint?: string },
  ): { imported: Memory[]; evicted: Memory[] } {
    const plan = this.importPlan(botId, items.length);
    if (!plan.fits) {
      throw new OrbitError(
        'blocked',
        `This Bot keeps ${this.maxPerBot} memories; ${items.length} more do not fit next to the ones that cannot be dropped automatically (yours, your feedback, pinned)`,
        { hint: 'Delete some in the memory browser, import fewer, or raise memory.maxPerBot.' },
      );
    }
    const base = this.now().getTime();
    const imported = items.map((item, i): Memory => {
      const taint = mergeTaint(item.taint, opts.forceTaint ? [opts.forceTaint] : []);
      const { title, body } = this.clean(item.title, item.body);
      return {
        id: newId('mem', base + i),
        botId,
        kind: item.kind,
        source: item.source,
        title,
        body,
        taint,
        runId: item.runId,
        approvalId: item.approvalId,
        signal: item.signal,
        pinned: item.pinned && taint.length === 0,
        createdBy: opts.createdBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        editedAt: item.editedAt,
      };
    });
    const evicted = this.db.sqlite.transaction(() => {
      const dropped = this.makeRoom(botId, imported.length);
      for (const m of imported) this.insert(m);
      return dropped;
    })();
    for (const e of evicted) this.unmirror(e);
    for (const m of imported) this.mirror(m);
    return { imported, evicted };
  }

  /**
   * Retention: delete a Bot's unpinned notes and run summaries written
   * before `beforeIso`. Owner facts, feedback and pinned memories never expire.
   */
  expire(botId: string, beforeIso: string): Memory[] {
    const rows = this.db.sqlite.transaction(() => {
      const old = this.db.sqlite
        .prepare(`SELECT * FROM memories WHERE bot_id = ? AND ${DROPPABLE} AND created_at < ?`)
        .all(botId, beforeIso) as Row[];
      const del = this.db.sqlite.prepare('DELETE FROM memories WHERE seq = ?');
      for (const r of old) del.run(r.seq);
      return old;
    })();
    const out = rows.map(toMemory);
    for (const m of out) this.unmirror(m);
    return out;
  }

  /** Drop memories over the bound (after the owner lowered `memory.maxPerBot`). */
  trim(botId: string): Memory[] {
    const rows = this.db.sqlite.transaction(() => {
      const over = this.count(botId) - this.maxPerBot;
      if (over <= 0) return [];
      // Best effort: what cannot be dropped stays (the next write is refused).
      const old = this.db.sqlite
        .prepare(
          `SELECT * FROM memories WHERE bot_id = ? AND ${DROPPABLE}
           ORDER BY (taint = '[]') ASC, seq ASC LIMIT ?`,
        )
        .all(botId, over) as Row[];
      const del = this.db.sqlite.prepare('DELETE FROM memories WHERE seq = ?');
      for (const r of old) del.run(r.seq);
      return old;
    })();
    const out = rows.map(toMemory);
    for (const m of out) this.unmirror(m);
    return out;
  }

  /** Bots that have memories. */
  botIds(): string[] {
    return (
      this.db.sqlite.prepare('SELECT DISTINCT bot_id FROM memories ORDER BY bot_id').all() as {
        bot_id: string;
      }[]
    ).map((r) => r.bot_id);
  }

  /** Every memory of one Bot (or all Bots), oldest first, read a page at a time. */
  *each(botId?: string): Generator<Memory> {
    let after = 0;
    for (;;) {
      const rows = (
        botId
          ? this.db.sqlite
              .prepare('SELECT * FROM memories WHERE bot_id = ? AND seq > ? ORDER BY seq LIMIT 500')
              .all(botId, after)
          : this.db.sqlite
              .prepare('SELECT * FROM memories WHERE seq > ? ORDER BY seq LIMIT 500')
              .all(after)
      ) as Row[];
      for (const r of rows) yield toMemory(r);
      const last = rows.at(-1);
      if (!last || rows.length < 500) return;
      after = last.seq;
    }
  }

  find(id: string): Memory | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      Row | undefined;
    return row ? toMemory(row) : undefined;
  }

  get(id: string): Memory {
    const m = this.find(id);
    if (!m) throw new OrbitError('not_found', `Memory ${id} not found`);
    return m;
  }

  /** Newest first; with `query`, best match first (bm25 over title and body). */
  list(q: MemoryQuery = {}): MemoryHit[] {
    const limit = Math.max(1, Math.min(q.limit ?? 100, 500));
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.botId) {
      where.push('m.bot_id = ?');
      args.push(q.botId);
    }
    if (q.kind) {
      where.push('m.kind = ?');
      args.push(q.kind);
    }
    if (q.trustedOnly) where.push("m.taint = '[]'");
    const fts = q.query ? ftsQuery(q.query, q.match ?? 'all') : null;
    if (q.query && !fts) return [];
    if (fts) {
      const rows = this.db.sqlite
        .prepare(
          `SELECT m.*, snippet(memories_fts, 1, '[', ']', '…', 16) AS snip,
                  bm25(memories_fts, 4.0, 1.0) AS rank
           FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
           WHERE memories_fts MATCH ? ${where.length ? `AND ${where.join(' AND ')}` : ''}
           ORDER BY rank LIMIT ?`,
        )
        .all(fts, ...args, limit) as (Row & { snip: string; rank: number })[];
      return rows.map((r) => ({ ...toMemory(r), snippet: r.snip, rank: r.rank }));
    }
    const rows = this.db.sqlite
      .prepare(
        `SELECT m.* FROM memories m ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(...args, limit) as Row[];
    return rows.map((r) => ({ ...toMemory(r), snippet: clip(r.body, 160), rank: 0 }));
  }

  /** Owner edits. Editing never clears taint; `trusted` does, explicitly. */
  update(id: string, patch: MemoryPatch): Memory {
    const current = this.get(id);
    const taint = patch.trusted ? [] : current.taint;
    const pinned = patch.pinned ?? current.pinned;
    if (pinned && taint.length > 0) {
      throw new OrbitError('invalid_input', 'An untrusted memory cannot be pinned', {
        hint: 'Review it first and mark it trusted.',
      });
    }
    const textChanged = patch.title !== undefined || patch.body !== undefined;
    const { title, body } = this.clean(patch.title ?? current.title, patch.body ?? current.body);
    const ts = this.now().toISOString();
    const next: Memory = {
      ...current,
      title,
      body,
      taint,
      pinned,
      updatedAt: ts,
      editedAt: textChanged ? ts : current.editedAt,
    };
    this.db.sqlite
      .prepare(
        `UPDATE memories SET title = ?, body = ?, taint = ?, pinned = ?, updated_at = ?, edited_at = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        next.body,
        JSON.stringify(next.taint),
        next.pinned ? 1 : 0,
        ts,
        next.editedAt,
        id,
      );
    this.mirror(next);
    return next;
  }

  delete(id: string): Memory {
    const m = this.get(id);
    this.db.sqlite.prepare('DELETE FROM memories WHERE id = ?').run(id);
    this.unmirror(m);
    return m;
  }

  /** Memories a Run wrote (notes, its summary, feedback about it). */
  forRun(runId: string): Memory[] {
    return (
      this.db.sqlite
        .prepare('SELECT * FROM memories WHERE run_id = ? ORDER BY seq ASC')
        .all(runId) as Row[]
    ).map(toMemory);
  }
}
