import {
  MEMORY_EXPORT_KIND,
  MEMORY_EXPORT_VERSION,
  MEMORY_LIMITS,
  type Memory,
  MemoryExportHeader,
  MemoryExportLine,
} from '@orbit/core';
import { stripControls } from './memory-store';

/**
 * Memory export and import as JSON Lines (ADR-012, M8): a versioned header
 * line, then one memory per line with its provenance (`source`, `taint`, the
 * Run, pinned, timestamps). Parsing is pure and all-or-nothing: the caller
 * imports only when every line is valid.
 */

/** A memory read from an export, ready for `MemoryStore.importMany`. */
export interface ImportedMemory {
  kind: Memory['kind'];
  source: Memory['source'];
  title: string;
  body: string;
  taint: string[];
  runId: string | null;
  approvalId: string | null;
  signal: Memory['signal'];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
}

export interface ParsedImport {
  header: MemoryExportHeader | null;
  memories: ImportedMemory[];
  /** 1-based line numbers (the header is line 1); at most MAX_ERRORS. */
  errors: { line: number; message: string }[];
}

const MAX_ERRORS = 20;

export function memoryExportHeader(
  bots: readonly { id: string; name: string }[],
  count: number,
  now: Date,
): string {
  const header: MemoryExportHeader = {
    kind: MEMORY_EXPORT_KIND,
    v: MEMORY_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    bots: bots.map((b) => ({ id: b.id, name: b.name })),
    count,
  };
  return JSON.stringify(header);
}

/** One memory as an export line (no newline inside). */
export function memoryExportLine(m: Memory): string {
  const line: MemoryExportLine = {
    id: m.id,
    botId: m.botId,
    kind: m.kind,
    source: m.source,
    title: m.title,
    body: m.body,
    taint: m.taint,
    runId: m.runId,
    approvalId: m.approvalId,
    signal: m.signal,
    pinned: m.pinned,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    editedAt: m.editedAt,
  };
  return JSON.stringify(line);
}

function issueText(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  const first = error.issues[0];
  if (!first) return 'invalid';
  const path = first.path.map(String).join('.');
  return path ? `${path}: ${first.message}` : first.message;
}

/** A timestamp from a file never lies in the future (retention would never reach it). */
function notAfter(iso: string, now: Date): string {
  const t = Date.parse(iso);
  return t > now.getTime() ? now.toISOString() : new Date(t).toISOString();
}

/**
 * Parse an export. Blank lines are ignored; the first line must be the
 * header (an export from a newer Orbit is refused), every other line a
 * memory. Lines longer than `MEMORY_LIMITS.exportLineChars` are refused
 * before they are parsed.
 */
export function parseMemoryImport(text: string, now: Date): ParsedImport {
  const errors: ParsedImport['errors'] = [];
  const memories: ImportedMemory[] = [];
  let header: MemoryExportHeader | null = null;
  const fail = (line: number, message: string) => {
    if (errors.length < MAX_ERRORS) errors.push({ line, message });
  };
  const lines = text.split(/\r?\n/);
  let seenHeader = false;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const n = i + 1;
    if (raw.trim() === '') continue;
    if (raw.length > MEMORY_LIMITS.exportLineChars) {
      fail(n, `line is longer than ${MEMORY_LIMITS.exportLineChars} characters`);
      seenHeader = true;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      fail(n, 'not JSON');
      seenHeader = true;
      continue;
    }
    if (!seenHeader) {
      seenHeader = true;
      const h = MemoryExportHeader.safeParse(value);
      if (!h.success) {
        fail(n, `the first line must be an Orbit memory export header (${issueText(h.error)})`);
        continue;
      }
      if (h.data.v > MEMORY_EXPORT_VERSION) {
        fail(n, `export version ${h.data.v} is newer than this Orbit understands`);
        continue;
      }
      header = h.data;
      continue;
    }
    if (++count > MEMORY_LIMITS.perBotCeiling) {
      fail(n, `an import holds at most ${MEMORY_LIMITS.perBotCeiling} memories`);
      break;
    }
    const m = MemoryExportLine.safeParse(value);
    if (!m.success) {
      fail(n, issueText(m.error));
      continue;
    }
    const d = m.data;
    const taint = [...new Set(d.taint.map((t) => stripControls(t).trim()).filter((t) => t !== ''))];
    if (taint.length < d.taint.length && taint.length === 0) {
      // Every source was blank or control characters: never let that read as trusted.
      fail(n, 'taint: sources must be names');
      continue;
    }
    const createdAt = notAfter(d.createdAt, now);
    memories.push({
      kind: d.kind,
      source: d.source,
      title: d.title,
      body: d.body,
      taint,
      runId: d.runId,
      approvalId: d.approvalId,
      signal: d.signal,
      pinned: d.pinned,
      createdAt,
      updatedAt: d.updatedAt ? notAfter(d.updatedAt, now) : createdAt,
      editedAt: d.editedAt ? notAfter(d.editedAt, now) : null,
    });
  }
  if (!seenHeader) fail(1, 'the file is empty');
  return { header, memories, errors };
}
