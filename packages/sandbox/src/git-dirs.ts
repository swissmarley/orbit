import {
  type Stats,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OrbitError } from '@orbit/core';

/**
 * Git administrative directories of a worktree Bot, found from what Orbit
 * names (the owner's repository) and never from the workspace's own `.git`,
 * which anything running in the workspace can rewrite (ADR-014, ADR-016,
 * ADR-019).
 */

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * The common git directory of a repository (its `.git` folder, or — when the
 * repository is itself a linked worktree — the common dir its `.git` file
 * leads to, with that file as `dotGit`). Null when there is none.
 */
export function gitCommonDir(repo: string): { dir: string; dotGit?: string } | null {
  const dotGit = join(repo, '.git');
  const st = lstatOrNull(dotGit);
  if (!st) return null;
  if (st.isDirectory()) {
    const dir = realOrNull(dotGit);
    return dir ? { dir } : null;
  }
  if (!st.isFile()) return null;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  const gitdir = m?.[1] ? resolve(repo, m[1].trim()) : null;
  if (!gitdir) return null;
  let common = gitdir;
  try {
    common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
  } catch {
    // Not a linked worktree: the gitdir is the common dir.
  }
  const dir = realOrNull(common);
  return dir ? { dir, dotGit } : null;
}

/**
 * The administrative directory (`<common>/worktrees/<name>`) of the linked
 * worktree checked out at `workspace`, found by its `gitdir` back-pointer.
 */
export function worktreeAdminDir(commonDir: string, workspace: string): string | null {
  const ws = realOrNull(workspace) ?? resolve(workspace);
  const worktrees = join(commonDir, 'worktrees');
  let names: string[];
  try {
    names = readdirSync(worktrees);
  } catch {
    return null;
  }
  for (const n of names) {
    const dir = join(worktrees, n);
    if (!lstatOrNull(dir)?.isDirectory()) continue;
    try {
      const target = readFileSync(join(dir, 'gitdir'), 'utf8').trim();
      if (target === '') continue;
      const tree = dirname(resolve(dir, target));
      if ((realOrNull(tree) ?? tree) === ws) return dir;
    } catch {
      // Not a worktree entry.
    }
  }
  return null;
}

/** What the workspace's `.git` was when Orbit had to put its own back. */
export type DotGitState = 'missing' | 'file' | 'directory' | 'symlink' | 'other';

export interface TakeoverGit {
  /** The worktree's administrative directory: the shell's GIT_DIR. */
  gitDir: string;
  /** The workspace: the shell's GIT_WORK_TREE. */
  workTree: string;
  /** Set when the workspace's `.git` was not Orbit's and was put back. */
  restored: { was: DotGitState; movedTo: string | null } | null;
}

/** Does the workspace's `.git` lead exactly to `adminDir`? (a regular file, not a link) */
function dotGitIsOrbits(workspace: string, adminDir: string): boolean {
  const dotGit = join(workspace, '.git');
  if (!lstatOrNull(dotGit)?.isFile()) return false;
  let text: string;
  try {
    text = readFileSync(dotGit, 'utf8');
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const m = lines.length === 1 ? /^gitdir:\s*(.+)$/.exec(lines[0] ?? '') : null;
  if (!m?.[1]) return false;
  const target = resolve(workspace, m[1].trim());
  return (realOrNull(target) ?? target) === (realOrNull(adminDir) ?? adminDir);
}

function stateOf(st: Stats | null): DotGitState {
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'directory';
  return 'other';
}

/**
 * Before the owner's shell opens in a Bot's workspace (`orbit shell`,
 * ADR-016): anything the Bot ran could have rewritten the workspace's `.git`
 * to lead to a repository and configuration of its own (`core.fsmonitor`,
 * `core.hooksPath`, …), which a git-aware prompt would run as the owner.
 *
 * - worktree Bot: the `.git` must be the file leading to the worktree entry
 *   Orbit created (found by its `gitdir` back-pointer in the owner's
 *   repository). Anything else is moved aside (`.git.orbit-replaced-<n>`,
 *   never deleted) and Orbit's file is written back; the shell then gets
 *   GIT_DIR and GIT_WORK_TREE, so git never consults the workspace's `.git`
 *   (or a repository nested in it) at all.
 * - directory Bot: Orbit made no repository there, so a `.git` is the Bot's;
 *   the take-over is refused with a hint (commands to run from outside the
 *   workspace) rather than changing the Bot's files behind its back.
 */
export function prepareTakeoverGit(input: {
  kind: 'directory' | 'worktree';
  workspace: string;
  repo?: string | undefined;
  now?: () => number;
}): TakeoverGit | null {
  const ws = realOrNull(input.workspace) ?? resolve(input.workspace);
  const dotGit = join(ws, '.git');
  if (input.kind === 'directory') {
    const st = lstatOrNull(dotGit);
    if (st) {
      throw new OrbitError(
        'conflict',
        `The workspace holds a git repository (${dotGit}) that a Bot wrote; its configuration can run programs when git, or a shell prompt that shows git status, reads it`,
        {
          hint: `From outside the workspace, look at it without git (cat ${join(dotGit, 'config')}) and move it away (mv ${dotGit} ${ws}.git-from-bot), then run orbit shell again.`,
        },
      );
    }
    return null;
  }
  const repo = input.repo;
  const common = repo ? gitCommonDir(repo) : null;
  const admin = common ? worktreeAdminDir(common.dir, ws) : null;
  if (!admin) {
    throw new OrbitError(
      'invalid_config',
      `The workspace ${ws} is not a registered worktree of ${repo ?? 'its repository'}`,
      {
        hint: 'Start a Run of the Bot (Orbit prepares its worktree again), or check `git worktree list` in the repository.',
      },
    );
  }
  let restored: TakeoverGit['restored'] = null;
  if (!dotGitIsOrbits(ws, admin)) {
    const st = lstatOrNull(dotGit);
    let movedTo: string | null = null;
    if (st) {
      const stamp = (input.now ?? Date.now)();
      for (let i = 0; movedTo === null; i++) {
        const candidate = join(ws, `.git.orbit-replaced-${stamp}${i === 0 ? '' : `-${i}`}`);
        if (!lstatOrNull(candidate)) movedTo = candidate;
      }
      renameSync(dotGit, movedTo);
    }
    writeFileSync(dotGit, `gitdir: ${admin}\n`, { flag: 'wx', mode: 0o644 });
    restored = { was: stateOf(st), movedTo };
  }
  return { gitDir: admin, workTree: ws, restored };
}
