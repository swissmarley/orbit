import { canonicalJson, scrubControls } from '@orbit/core/browser';
import { diffLines } from 'diff';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  /** Line numbers (old/new); null for the side the line is not on. */
  a: number | null;
  b: number | null;
}

/** Line diff of two texts (control characters neutralised). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = [];
  let a = 1;
  let b = 1;
  for (const part of diffLines(scrubControls(before), scrubControls(after))) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      if (part.added) out.push({ kind: 'add', text, a: null, b: b++ });
      else if (part.removed) out.push({ kind: 'del', text, a: a++, b: null });
      else out.push({ kind: 'ctx', text, a: a++, b: b++ });
    }
  }
  return out;
}

/** Keep changed lines with `context` lines around them; gaps become hunk markers. */
export function collapse(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.kind === 'add' || l.kind === 'del') {
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++)
        keep.add(j);
    }
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep.has(i)) {
      if (skipped > 0)
        out.push({
          kind: 'hunk',
          text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'}`,
          a: null,
          b: null,
        });
      skipped = 0;
      out.push(l);
    } else skipped += 1;
  });
  if (skipped > 0 && out.length > 0)
    out.push({
      kind: 'hunk',
      text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'}`,
      a: null,
      b: null,
    });
  return out;
}

/** A unified diff (as approval cards carry it) as lines; file headers dropped. */
export function parseUnified(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let a = 0;
  let b = 0;
  for (const raw of scrubControls(diff).split('\n')) {
    if (
      raw.startsWith('===') ||
      raw.startsWith('Index:') ||
      raw.startsWith('+++') ||
      raw.startsWith('---') ||
      raw === '\\ No newline at end of file'
    )
      continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      a = Number(hunk[1]);
      b = Number(hunk[2]);
      out.push({ kind: 'hunk', text: raw, a: null, b: null });
    } else if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), a: null, b: b++ });
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), a: a++, b: null });
    else if (raw !== '' || out.length > 0)
      out.push({ kind: 'ctx', text: raw.replace(/^ /, ''), a: a++, b: b++ });
  }
  while (out.length > 0 && out[out.length - 1]?.kind === 'ctx' && out[out.length - 1]?.text === '')
    out.pop();
  return out;
}

/** Stable, readable text of a JSON value (sorted keys), for config diffs. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(JSON.parse(canonicalJson(value)), null, 2);
}

/** What changed between two Bot spec versions. */
export function specDiff(before: unknown, after: unknown): DiffLine[] {
  return lineDiff(prettyJson(before), prettyJson(after));
}

/** Diff of what a file-writing tool call would change, when it is one. */
export function toolDiff(name: string, input: unknown): DiffLine[] | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  if (name === 'Edit' && str(o.old_string) !== null && str(o.new_string) !== null) {
    return lineDiff(str(o.old_string) ?? '', str(o.new_string) ?? '');
  }
  if (name === 'MultiEdit' && Array.isArray(o.edits)) {
    return (o.edits as Record<string, unknown>[]).flatMap((e, i) => [
      ...(i > 0 ? [{ kind: 'hunk' as const, text: `edit ${i + 1}`, a: null, b: null }] : []),
      ...lineDiff(str(e.old_string) ?? '', str(e.new_string) ?? ''),
    ]);
  }
  if (name === 'Write' && str(o.content) !== null) return lineDiff('', str(o.content) ?? '');
  return null;
}
