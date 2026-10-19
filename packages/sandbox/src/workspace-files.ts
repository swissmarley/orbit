import {
  type Stats,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { OrbitError } from '@orbit/core';

/**
 * Read-only access to a Bot's workspace for the App's computer panel
 * (ADR-020). The Bot writes these files, may plant links among them and may
 * swap a folder for a link while Orbit reads, so a path is never resolved
 * through a link, nor by name again once a folder on it is open:
 *
 * - Linux: the walk opens one name at a time inside the folder already open
 *   (`/proc/self/fd/<folder>/<name>`, O_NOFOLLOW), and a listing reads the
 *   open folder, so a name swapped for a link behind the walk changes nothing;
 * - macOS: O_NOFOLLOW_ANY refuses a link anywhere on the path, and a listing
 *   shows only the names it can open that way (links are left out);
 * - other systems: the workspace is not shown.
 *
 * A symbolic link is never opened, and a file with other hard links is not
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

export interface WorkspaceReadOptions {
  /** Defaults to this host's (tests pass another). */
  platform?: NodeJS.Platform;
  /** Test seam: runs after each name of the path is opened (Linux). */
  onStep?: (depth: number) => void;
}

const refuse = (message: string) => new OrbitError('invalid_input', message);

/** macOS (11+): the open fails if any name on the path is a symbolic link. */
const O_NOFOLLOW_ANY = 0x20000000;
const OPEN_DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// O_NONBLOCK: a FIFO in the workspace cannot hang the request.
const OPEN_FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** How this host walks a workspace path without following links. */
type Walk = 'proc' | 'nofollow-any';

function walkFor(platform: NodeJS.Platform): Walk {
  if (platform === 'darwin') return 'nofollow-any';
  if (platform === 'linux' && existsSync('/proc/self/fd')) return 'proc';
  throw refuse(
    platform === 'linux'
      ? 'Orbit needs /proc to show a workspace safely'
      : `Orbit shows a workspace on Linux and macOS only, not on ${platform}`,
  );
}

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
 * (not a link to somewhere else), or null when it does not exist yet. On
 * macOS its real path, so that O_NOFOLLOW_ANY sees no link above it
 * (`/var` is `/private/var` there).
 */
function checkedRoot(root: string, walk: Walk): string | null {
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
  return walk === 'nofollow-any' ? realpathSync.native(root) : root;
}

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Why opening the `depth`-th name failed, as Orbit says it. `at` is the name
 * inside its open folder (Linux), to tell a link from a file when
 * O_DIRECTORY refused it.
 */
function failure(
  err: unknown,
  segments: readonly string[],
  depth: number,
  want: 'file' | 'directory',
  at: string | null,
): Error {
  const shown = segments.slice(0, depth + 1).join('/');
  const link = `${shown} is a symbolic link; Orbit does not follow links in a workspace`;
  switch (code(err)) {
    case 'ENOENT':
      return new OrbitError('not_found', `${shown} does not exist`);
    case 'ELOOP':
      return refuse(
        at === null
          ? `${shown} or a folder on its way is a symbolic link; Orbit does not follow links in a workspace`
          : link,
      );
    case 'ENOTDIR':
      if (at !== null && isLink(at)) return refuse(link);
      // Opening a file never asks for a directory: a folder on the way is a file.
      return want === 'file' || (at !== null && depth < segments.length - 1)
        ? new OrbitError('not_found', `${shown} does not exist`)
        : refuse(`${shown} is not a directory`);
    case 'EACCES':
    case 'EPERM':
      return refuse(`Orbit may not open ${shown}`);
    case 'ENXIO':
    case 'EOPNOTSUPP':
      return refuse(`${shown} is not a file`);
    default:
      return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Open `segments` under the checked root without following a link anywhere
 * on the way; the caller closes the descriptor.
 */
function openBeneath(
  root: string,
  segments: readonly string[],
  want: 'file' | 'directory',
  walk: Walk,
  onStep?: (depth: number) => void,
): number {
  if (walk === 'nofollow-any') {
    try {
      return openSync(
        join(root, ...segments),
        (want === 'file' ? OPEN_FILE : OPEN_DIR) | O_NOFOLLOW_ANY,
      );
    } catch (err) {
      throw failure(err, segments, segments.length - 1, want, null);
    }
  }
  let fd = openSync(root, OPEN_DIR);
  for (const [i, name] of segments.entries()) {
    const at = `/proc/self/fd/${fd}/${name}`;
    let next: number;
    try {
      next = openSync(at, i === segments.length - 1 && want === 'file' ? OPEN_FILE : OPEN_DIR);
    } catch (err) {
      const e = failure(err, segments, i, want, at);
      closeSync(fd);
      throw e;
    }
    closeSync(fd);
    fd = next;
    try {
      onStep?.(i);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }
  return fd;
}

function kindOf(st: Stats | null): WorkspaceEntry['kind'] {
  if (!st) return 'other';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'other';
}

/** The names in a directory, without hidden ones, at most SCAN_LIMIT. */
function readNames(dirPath: string): { names: string[]; more: boolean } {
  const names: string[] = [];
  const dir = opendirSync(dirPath);
  try {
    for (let d = dir.readSync(); d !== null; d = dir.readSync()) {
      if (HIDDEN_WORKSPACE_NAMES.has(d.name.toLowerCase())) continue;
      if (names.length >= SCAN_LIMIT) return { names, more: true };
      names.push(d.name);
    }
  } finally {
    dir.closeSync();
  }
  return { names, more: false };
}

/**
 * What a name in an open directory is. Linux: its lstat inside the open
 * folder. macOS: the names were read by path, so each is shown only if it
 * opens without a link on the way (links and anything unopenable are left
 * out).
 */
function entryStat(walk: Walk, dirFd: number, dirPath: string, name: string): Stats | null {
  try {
    if (walk === 'proc') return lstatSync(`/proc/self/fd/${dirFd}/${name}`);
    const fd = openSync(join(dirPath, name), OPEN_FILE | O_NOFOLLOW_ANY);
    try {
      return fstatSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** List one directory of a Bot's workspace. */
export function listWorkspace(
  root: string,
  input: string,
  opts: WorkspaceReadOptions = {},
): WorkspaceListing {
  const segments = workspacePathSegments(input);
  const path = segments.join('/');
  const walk = walkFor(opts.platform ?? process.platform);
  const base = checkedRoot(root, walk);
  if (base === null) {
    if (segments.length === 0) return { path, exists: false, entries: [], truncated: false };
    throw new OrbitError('not_found', `${path} does not exist`);
  }
  const fd = openBeneath(base, segments, 'directory', walk, opts.onStep);
  let entries: WorkspaceEntry[];
  let more: boolean;
  try {
    const dirPath = walk === 'proc' ? `/proc/self/fd/${fd}` : join(base, ...segments);
    const read = readNames(dirPath);
    more = read.more;
    entries = read.names.flatMap((name): WorkspaceEntry[] => {
      const st = entryStat(walk, fd, dirPath, name);
      // Linux: gone since it was listed; macOS: not shown.
      if (st === null && walk === 'nofollow-any') return [];
      const kind = kindOf(st);
      return [
        {
          name,
          path: path ? `${path}/${name}` : name,
          kind,
          size: kind === 'file' && st ? st.size : null,
          modifiedAt: st ? st.mtime.toISOString() : null,
        },
      ];
    });
  } finally {
    closeSync(fd);
  }
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
  opts: WorkspaceReadOptions & { maxBytes?: number } = {},
): WorkspacePreview {
  const segments = workspacePathSegments(input);
  if (segments.length === 0) throw refuse('Name a file in the workspace');
  const path = segments.join('/');
  const maxBytes = opts.maxBytes ?? WORKSPACE_PREVIEW_BYTES;
  const walk = walkFor(opts.platform ?? process.platform);
  const base = checkedRoot(root, walk);
  if (base === null) throw new OrbitError('not_found', `${path} does not exist`);
  const fd = openBeneath(base, segments, 'file', walk, opts.onStep);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw refuse(`${path} is not a file`);
    if (st.nlink > 1) {
      throw refuse(`${path} has other hard links; Orbit shows only files that exist once`);
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
