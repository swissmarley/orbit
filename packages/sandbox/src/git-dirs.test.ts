import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitError } from '@orbit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitCommonDir, prepareTakeoverGit, worktreeAdminDir } from './git-dirs';

const env = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Owner',
  GIT_AUTHOR_EMAIL: 'owner@example.test',
  GIT_COMMITTER_NAME: 'Owner',
  GIT_COMMITTER_EMAIL: 'owner@example.test',
};

describe('git directories of a worktree Bot (orbit shell, ADR-016)', () => {
  let root: string;
  let repo: string;
  let ws: string;
  let admin: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: { ...env, HOME: root }, encoding: 'utf8' }).trim();

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-gitdirs-')));
    repo = join(root, 'repo');
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    ws = join(root, 'workspaces', 'bot_1');
    mkdirSync(join(root, 'workspaces'));
    git(repo, 'worktree', 'add', '-q', '-b', 'orbit/bot_1', ws);
    admin = join(repo, '.git', 'worktrees', 'bot_1');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds the common dir and the worktree entry by its back-pointer', () => {
    expect(gitCommonDir(repo)).toEqual({ dir: join(repo, '.git') });
    expect(gitCommonDir(ws)).toEqual({ dir: join(repo, '.git'), dotGit: join(ws, '.git') });
    expect(worktreeAdminDir(join(repo, '.git'), ws)).toBe(admin);
    expect(worktreeAdminDir(join(repo, '.git'), join(root, 'elsewhere'))).toBeNull();
    expect(gitCommonDir(join(root, 'nothing'))).toBeNull();
  });

  it("keeps Orbit's own .git file, and names GIT_DIR and GIT_WORK_TREE", () => {
    const before = readFileSync(join(ws, '.git'), 'utf8');
    expect(prepareTakeoverGit({ kind: 'worktree', workspace: ws, repo })).toEqual({
      gitDir: admin,
      workTree: ws,
      restored: null,
    });
    expect(readFileSync(join(ws, '.git'), 'utf8')).toBe(before);
  });

  it('puts back a .git a Bot rewrote, moving its version aside (never deleting it)', () => {
    // A Bot's repository with a config that would run a program for the owner.
    const evil = join(ws, '.evil');
    git(root, 'init', '-q', evil);
    writeFileSync(join(evil, '.git', 'config'), '[core]\n\tfsmonitor = touch /tmp/pwned\n');
    for (const plant of [
      () => writeFileSync(join(ws, '.git'), `gitdir: ${join(evil, '.git')}\n`),
      () => symlinkSync(join(evil, '.git'), join(ws, '.git')),
      () => mkdirSync(join(ws, '.git')),
      () => undefined,
    ]) {
      rmSync(join(ws, '.git'), { recursive: true, force: true });
      plant();
      const kind = (() => {
        try {
          const st = lstatSync(join(ws, '.git'));
          return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file';
        } catch {
          return 'missing';
        }
      })();
      let n = 0;
      const t = prepareTakeoverGit({ kind: 'worktree', workspace: ws, repo, now: () => ++n });
      expect(t?.restored?.was).toBe(kind);
      if (kind === 'missing') expect(t?.restored?.movedTo).toBeNull();
      else {
        expect(t?.restored?.movedTo).toMatch(/\.git\.orbit-replaced-1$/);
        rmSync(t?.restored?.movedTo ?? '', { recursive: true, force: true });
      }
      expect(lstatSync(join(ws, '.git')).isFile()).toBe(true);
      expect(readFileSync(join(ws, '.git'), 'utf8')).toBe(`gitdir: ${admin}\n`);
      expect(git(ws, 'rev-parse', '--git-dir')).toBe(admin);
    }
    // A .git file naming the right entry plus something else is not Orbit's either.
    writeFileSync(join(ws, '.git'), `gitdir: ${admin}\nworktree: /tmp\n`);
    expect(prepareTakeoverGit({ kind: 'worktree', workspace: ws, repo })?.restored?.was).toBe(
      'file',
    );
  });

  it('refuses when the workspace is not a registered worktree', () => {
    const other = join(root, 'workspaces', 'bot_2');
    mkdirSync(other);
    expect(() => prepareTakeoverGit({ kind: 'worktree', workspace: other, repo })).toThrow(
      /not a registered worktree/,
    );
  });

  it("refuses a directory Bot's workspace with any .git, with a hint to run from outside", () => {
    const dir = join(root, 'workspaces', 'bot_3');
    mkdirSync(dir);
    expect(prepareTakeoverGit({ kind: 'directory', workspace: dir })).toBeNull();
    git(dir, 'init', '-q');
    let err: unknown;
    try {
      prepareTakeoverGit({ kind: 'directory', workspace: dir });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OrbitError);
    const e = err as OrbitError;
    expect(e.code).toBe('conflict');
    expect(e.message).toMatch(/holds a git repository .* a Bot wrote/);
    expect(e.hint).toContain(`mv ${join(dir, '.git')} ${dir}.git-from-bot`);
    rmSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere\n');
    expect(() => prepareTakeoverGit({ kind: 'directory', workspace: dir })).toThrow(/holds a git/);
  });
});
