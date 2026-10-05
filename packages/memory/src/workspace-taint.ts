import { isAbsolute, relative, sep } from 'node:path';
import type { OrbitDb } from '@orbit/store';
import { mergeTaint } from './memory-store';

/** Marks the whole workspace: a tainted Run ran shell commands there. */
export const WHOLE_WORKSPACE = '*';

export interface TaintedPath {
  path: string;
  sources: string[];
  runId: string;
  updatedAt: string;
}

/**
 * Workspace path relative to its root ('' for the root), or null when the
 * path is outside the workspace (those reads are governed by readRoots, and
 * Bots cannot write there).
 */
export function workspaceRelative(workspace: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : `${workspace}${sep}${path}`;
  const rel = relative(workspace, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Taint carried through workspace files (M2 review M1, ADR-012). A tainted
 * Run that writes a file marks it; a later Run that reads it becomes tainted
 * with the same sources. A tainted shell marks the whole workspace, since
 * Orbit cannot know which files a command touched. An untrusted-free Run
 * that rewrites a whole file (Write) clears that file's mark.
 */
export class WorkspaceTaint {
  constructor(
    private readonly db: OrbitDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  mark(botId: string, path: string, sources: readonly string[], runId: string): void {
    const existing = this.db.sqlite
      .prepare('SELECT sources FROM workspace_taint WHERE bot_id = ? AND path = ?')
      .get(botId, path) as { sources: string } | undefined;
    const merged = mergeTaint(existing ? (JSON.parse(existing.sources) as string[]) : [], sources);
    this.db.sqlite
      .prepare(
        `INSERT INTO workspace_taint (bot_id, path, sources, run_id, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, path) DO UPDATE SET sources = excluded.sources,
           run_id = excluded.run_id, updated_at = excluded.updated_at`,
      )
      .run(botId, path, JSON.stringify(merged), runId, this.now().toISOString());
  }

  clear(botId: string, path: string): void {
    this.db.sqlite
      .prepare('DELETE FROM workspace_taint WHERE bot_id = ? AND path = ?')
      .run(botId, path);
  }

  clearAll(botId: string): number {
    return this.db.sqlite.prepare('DELETE FROM workspace_taint WHERE bot_id = ?').run(botId)
      .changes;
  }

  list(botId: string): TaintedPath[] {
    return (
      this.db.sqlite
        .prepare(
          'SELECT path, sources, run_id, updated_at FROM workspace_taint WHERE bot_id = ? ORDER BY path',
        )
        .all(botId) as { path: string; sources: string; run_id: string; updated_at: string }[]
    ).map((r) => ({
      path: r.path,
      sources: JSON.parse(r.sources) as string[],
      runId: r.run_id,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Sources that reading `rel` exposes the Run to: the file itself, the
   * whole-workspace mark, or — for a directory (Grep, Glob) — any marked
   * file beneath it. Empty when the read is clean.
   */
  exposure(botId: string, rel: string, opts: { directory?: boolean } = {}): string[] {
    const rows = this.list(botId);
    if (rows.length === 0) return [];
    const hits = rows.filter(
      (r) =>
        r.path === WHOLE_WORKSPACE ||
        r.path === rel ||
        (opts.directory === true && (rel === '' || r.path.startsWith(`${rel}/`))),
    );
    return mergeTaint(
      hits.map((h) => (h.path === WHOLE_WORKSPACE ? 'workspace' : `file:${h.path}`)),
      ...hits.map((h) => h.sources),
    );
  }
}
