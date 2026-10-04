import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitError } from '@orbit/core';
import { afterAll, describe, expect, it } from 'vitest';
import { FULL_SUPPORT, makeBot } from '../test/helpers';
import { SandboxManager } from './manager';
import { defaultRunner } from './runner';

// Real git, isolated from the user's git configuration.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-sandbox-git-')));
const gitEnv: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: root,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  GIT_AUTHOR_NAME: 'Orbit Test',
  GIT_AUTHOR_EMAIL: 'test@orbit.invalid',
  GIT_COMMITTER_NAME: 'Orbit Test',
  GIT_COMMITTER_EMAIL: 'test@orbit.invalid',
};
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL!, '');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });

const repo = join(root, 'repo');
git(root, 'init', '-q', '-b', 'main', repo);
writeFileSync(join(repo, 'README.md'), 'hello\n');
git(repo, 'add', '.');
git(repo, 'commit', '-q', '-m', 'init');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const worktrees = () =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));

describe('SandboxManager — worktree (real git)', () => {
  const m = new SandboxManager({
    orbitHome: join(root, 'orbit'),
    home: join(root, 'home'),
    run: defaultRunner(gitEnv),
    support: FULL_SUPPORT,
  });
  const bot = makeBot({ name: 'Git Bot', sandbox: { kind: 'worktree', repo } });

  it('creates a worktree on orbit/<slug> and is idempotent', async () => {
    const ws = await m.prepare(bot, 'cli');
    expect(ws.path).toBe(join(root, 'orbit', 'workspaces', 'bot_test1'));
    expect(readFileSync(join(ws.path, 'README.md'), 'utf8')).toBe('hello\n');
    expect(git(ws.path, 'branch', '--show-current').trim()).toBe('orbit/bot_test1');
    expect(worktrees()).toContain(ws.path);

    const again = await m.prepare(bot, 'cli');
    expect(again).toEqual(ws);
    expect(worktrees().filter((p) => p === ws.path)).toHaveLength(1);
  });

  it('destroy unregisters the worktree but keeps the files; prepare then refuses to clobber them', async () => {
    const path = m.workspacePath(bot);
    writeFileSync(join(path, 'notes.txt'), 'uncommitted work\n');
    await m.destroy(bot);
    expect(worktrees()).not.toContain(path);
    expect(readFileSync(join(path, 'notes.txt'), 'utf8')).toBe('uncommitted work\n');
    expect(existsSync(join(path, '.git'))).toBe(false);

    const err = await m.prepare(bot, 'cli').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrbitError);
    expect((err as OrbitError).code).toBe('invalid_config');
  });

  it('purge removes the directory; prepare reattaches the Bot branch with its commits', async () => {
    const ws = await (async () => {
      await m.destroy(bot, { purge: true });
      expect(existsSync(m.workspacePath(bot))).toBe(false);
      return m.prepare(bot, 'cli');
    })();
    writeFileSync(join(ws.path, 'work.txt'), 'bot output\n');
    git(ws.path, 'add', 'work.txt');
    git(ws.path, 'commit', '-q', '-m', 'bot work');

    await m.destroy(bot, { purge: true });
    expect(existsSync(ws.path)).toBe(false);
    expect(worktrees()).not.toContain(ws.path);

    await m.prepare(bot, 'cli');
    expect(readFileSync(join(ws.path, 'work.txt'), 'utf8')).toBe('bot output\n');
    await m.destroy(bot, { purge: true });
  });
});
