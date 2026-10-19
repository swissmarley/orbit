import {
  type Dirent,
  type Stats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { OrbitError } from '@orbit/core';

/**
 * Read-only access to a Bot's workspace for the App's computer panel
 * (ADR-020). The Bot writes these files and may plant links among them, so
 * nothing here follows one: every name on the way is `lstat`ed, a symbolic
 * link is listed but never opened, a file is opened with O_NOFOLLOW and must
 * be the inode that was checked, and a file with other hard links is not
 * shown (it could be `$ORBIT_HOME/daemon.token` under a second name).
 */

/** Bytes of a file shown at most. */
export const WORKSPACE_PREVIEW_BYTES = 256 * 1024;
/** Entries one listing returns at most (directories first, then by name). */
export const WORKSPACE_LIST_LIMIT = 500;
/** Entries read from one directory before sorting: bounds the work for huge ones. */
const SCAN_LIMIT = 5000;
const MAX_PATH = 1024;
const MAX_DEPTH = 64;

/** Never listed or opened: the worktree's pointer and repository internals. */
export const HIDDEN_WORKSPACE_NAMES: ReadonlySet<string> = new Set(['.git']);

export interface WorkspaceEntry {
  name: string;
  /** Relative to the workspace, `/`-separated. */
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number | null;
  modifiedAt: string | null;
}

export interface WorkspaceListing {
  /** The directory listed, relative to the workspace ('' = its root). */
  path: string;
  /** False when the Bot has no workspace yet (it never ran). */
  exists: boolean;
  entries: WorkspaceEntry[];
  /** The directory holds more than the listing shows. */
  truncated: boolean;
}

export interface WorkspacePreview {
  path: string;
  size: number;
  modifiedAt: string;
  /** binary: not shown (NUL bytes or not UTF-8). */
  kind: 'text' | 'binary';
  text: string | null;
  /** Only the first WORKSPACE_PREVIEW_BYTES are shown. */
  truncated: boolean;
}

const refuse = (message: string) => new OrbitError('invalid_input', message);

/**
 * Split a client's workspace-relative path ('' = the root) into checked
 * names: no absolute paths, `..`, backslashes, NUL or hidden names.
 */
export function workspacePathSegments(input: string): string[] {
  if (input.length > MAX_PATH) throw refuse('The path is too long');
  if (input.includes('\0') || input.includes('\\')) {
    throw refuse('Use a relative path with forward slashes');
  }
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
    throw refuse('Use a path relative to the workspace');
  }
  const segments = input.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) throw refuse('The path may not leave the workspace (..)');
  if (segments.length > MAX_DEPTH) throw refuse('The path is too deep');
  const hidden = segments.find((s) => HIDDEN_WORKSPACE_NAMES.has(s.toLowerCase()));
  if (hidden !== undefined) throw refuse(`${hidden} is not shown`);
  return segments;
}

const code = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;

/**
 * The workspace root, checked: a real directory whose parent is one too
 * (not a link to somewhere else), or null when it does not exist yet.
 */
function checkedRoot(root: string): string | null {
  for (const p of [dirname(root), root]) {
    let st: Stats;
    try {
      st = lstatSync(p);
    } catch (err) {
      if (code(err) === 'ENOENT') return null;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new OrbitError(
        'internal',
        'The workspace is not a plain directory; Orbit does not open it',
      );
    }
  }
  return root;
}

/** Walk the names without following any link; the last one's lstat. */
function walk(root: string, segments: readonly string[]): { full: string; stat: Stats } {
  let full = root;
  let stat = lstatSync(root);
  for (const [i, name] of segments.entries()) {
    full = join(full, name);
    try {
      stat = lstatSync(full);
    } catch (err) {
      if (code(err) === 'ENOENT' || code(err) === 'ENOTDIR') {
        throw new OrbitError('not_found', `${segments.slice(0, i + 1).join('/')} does not exist`);
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw refuse(
        `${segments.slice(0, i + 1).join('/')} is a symbolic link; Orbit does not follow links in a workspace`,
      );
    }
    if (i < segments.length - 1 && !stat.isDirectory()) {
      throw new OrbitError('not_found', `${segments.slice(0, i + 1).join('/')} is not a directory`);
    }
  }
  return { full, stat };
}

function kindOf(st: Stats | null): WorkspaceEntry['kind'] {
  if (!st) return 'other';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'other';
}

/** List one directory of a Bot's workspace. */
export function listWorkspace(root: string, input: string): WorkspaceListing {
  const segments = workspacePathSegments(input);
  const path = segments.join('/');
  const base = checkedRoot(root);
  if (base === null) {
    if (segments.length === 0) return { path, exists: false, entries: [], truncated: false };
    throw new OrbitError('not_found', `${path} does not exist`);
  }
  const { full, stat } = walk(base, segments);
  if (!stat.isDirectory()) throw refuse(`${path} is not a directory`);
  const found: Dirent[] = [];
  let more = false;
  const dir = opendirSync(full);
  try {
    for (let d = dir.readSync(); d !== null; d = dir.readSync()) {
      if (HIDDEN_WORKSPACE_NAMES.has(d.name.toLowerCase())) continue;
      if (found.length >= SCAN_LIMIT) {
        more = true;
        break;
      }
      found.push(d);
    }
  } finally {
    dir.closeSync();
  }
  const entries = found.map((d): WorkspaceEntry => {
    let st: Stats | null = null;
    try {
      st = lstatSync(join(full, d.name));
    } catch {
      // Gone since it was listed.
    }
    const kind = kindOf(st);
    return {
      name: d.name,
      path: path ? `${path}/${d.name}` : d.name,
      kind,
      size: kind === 'file' && st ? st.size : null,
      modifiedAt: st ? st.mtime.toISOString() : null,
    };
  });
  entries.sort(
    (a, b) =>
      Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
      a.name.localeCompare(b.name),
  );
  return {
    path,
    exists: true,
    entries: entries.slice(0, WORKSPACE_LIST_LIMIT),
    truncated: more || entries.length > WORKSPACE_LIST_LIMIT,
  };
}

/** Strict UTF-8, allowing a character cut off by the preview limit. */
function decodeText(bytes: Uint8Array, truncated: boolean): string | null {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let cut = 0; cut <= (truncated ? 3 : 0) && cut <= bytes.length; cut++) {
    try {
      return decoder.decode(bytes.subarray(0, bytes.length - cut));
    } catch {
      // Try without the last bytes of a split character.
    }
  }
  return null;
}

/** Preview one file of a Bot's workspace: text up to WORKSPACE_PREVIEW_BYTES, never binary. */
export function readWorkspaceFile(
  root: string,
  input: string,
  maxBytes = WORKSPACE_PREVIEW_BYTES,
): WorkspacePreview {
  const segments = workspacePathSegments(input);
  if (segments.length === 0) throw refuse('Name a file in the workspace');
  const path = segments.join('/');
  const base = checkedRoot(root);
  if (base === null) throw new OrbitError('not_found', `${path} does not exist`);
  const { full, stat } = walk(base, segments);
  if (!stat.isFile()) throw refuse(`${path} is not a file`);
  if (stat.nlink > 1) {
    throw refuse(`${path} has other hard links; Orbit shows only files that exist once`);
  }
  // O_NONBLOCK: a FIFO swapped in after the check cannot hang the request.
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== stat.ino || st.dev !== stat.dev || st.nlink > 1) {
      throw refuse(`${path} changed while Orbit was reading it; try again`);
    }
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    const data = buf.subarray(0, n);
    const truncated = st.size > n;
    const text = data.includes(0) ? null : decodeText(data, truncated);
    const shown = { path, size: st.size, modifiedAt: st.mtime.toISOString() };
    return text === null
      ? { ...shown, kind: 'binary', text: null, truncated: false }
      : { ...shown, kind: 'text', text, truncated };
  } finally {
    closeSync(fd);
  }
}
