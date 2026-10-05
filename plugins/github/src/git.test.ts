import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type ToolContext, handle } from '@orbit/plugin-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv, pathProblem, pushAuthConfig, tools } from './tools';

const TOKEN = 'ghp_FAKEtoken0123456789abcdef';
/** A string matcher typed as a string (expect's asymmetric matchers are `any`). */
const matching = (re: RegExp) => expect.stringMatching(re) as unknown as string;
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const PATH = process.env.PATH ?? '';
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

let base: string;
let home: string;
let repo: string;
let bare: string;
let wt: string;
let argvLog: string;
let envLog: string;
let ctx: ToolContext;
let setupEnv: Record<string, string>;

/** git as the test (a person) runs it: hooks active, no plugin configuration. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync(REAL_GIT, args, { cwd, env: setupEnv, encoding: 'utf8', stdio: 'pipe' }).trim();

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await handle(
    { name: 'github', version: '0', tools },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ctx,
  );
  const result = r?.result as { content: { text: string }[]; isError: boolean };
  const text = result.content[0]?.text ?? '';
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(BASIC);
  return { text, isError: result.isError };
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orbit-gh-git-'));
  home = join(base, 'home');
  mkdirSync(home);
  setupEnv = {
    PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Owner',
    GIT_AUTHOR_EMAIL: 'owner@example.test',
    GIT_COMMITTER_NAME: 'Owner',
    GIT_COMMITTER_EMAIL: 'owner@example.test',
  };
  repo = join(base, 'repo');
  bare = join(base, 'remote.git');
  wt = join(base, 'wt');
  git(base, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'README.md'), '# Widgets\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(base, 'clone', '-q', '--bare', repo, bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'worktree', 'add', '-q', '-b', 'orbit/test', wt);

  // Hooks the Bot could have written: they must never run through the plugin.
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, 'pre-commit'),
    `#!/bin/sh\ntouch "${join(base, 'pre-commit-ran')}"\nexit 1\n`,
  );
  writeFileSync(
    join(hooks, 'post-commit'),
    `#!/bin/sh\ntouch "${join(base, 'post-commit-ran')}"\n`,
  );
  writeFileSync(
    join(hooks, 'pre-push'),
    `#!/bin/sh\ntouch "${join(base, 'pre-push-ran')}"\nexit 1\n`,
  );
  for (const h of ['pre-commit', 'post-commit', 'pre-push']) chmodSync(join(hooks, h), 0o755);

  // A `git` first on PATH that records every argv and the GIT_CONFIG_* it got.
  const bin = join(base, 'bin');
  mkdirSync(bin);
  argvLog = join(base, 'argv.log');
  envLog = join(base, 'env.log');
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argvLog}"; done\nenv | grep '^GIT_' >> "${envLog}"\nexec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);

  ctx = {
    workspace: wt,
    env: {
      PATH: `${bin}${delimiter}${PATH}`,
      HOME: home,
      GITHUB_TOKEN: TOKEN,
      GIT_AUTHOR_NAME: 'Test Bot',
      GIT_AUTHOR_EMAIL: 'test-bot@example.test',
      // Inherited git variables are dropped, never honoured.
      GIT_DIR: join(base, 'elsewhere'),
    },
  };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD');

describe('github plugin: git in the workspace', { timeout: 30_000 }, () => {
  it('commits on the Bot branch as the configured author, and never runs hooks', async () => {
    // Positive control: the hook is live for anyone committing normally.
    writeFileSync(join(wt, 'a.txt'), 'a\n');
    git(wt, 'add', 'a.txt');
    expect(() => git(wt, 'commit', '-q', '-m', 'by hand')).toThrow();
    expect(existsSync(join(base, 'pre-commit-ran'))).toBe(true);
    rmSync(join(base, 'pre-commit-ran'));

    const r = await call('git_commit', { message: 'Add a.txt\n\nWith a body.' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(
      /^Committed [0-9a-f]{7,} on orbit\/test: Add a\.txt\n1 file changed, 1 insertion/,
    );
    expect(git(wt, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%B')).toBe(
      'Test Bot <test-bot@example.test>|Test Bot <test-bot@example.test>|Add a.txt\n\nWith a body.',
    );
    expect(existsSync(join(base, 'pre-commit-ran'))).toBe(false);
    expect(existsSync(join(base, 'post-commit-ran'))).toBe(false);
    expect(readFileSync(envLog, 'utf8')).toContain('GIT_CONFIG_VALUE_0=/dev/null');
  });

  it('falls back to the default identity when no author is configured', async () => {
    ctx = { workspace: wt, env: { PATH, HOME: home } };
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    expect((await call('git_commit', { message: 'b' })).isError).toBe(false);
    expect(git(wt, 'log', '-1', '--format=%an <%ae>')).toBe('Orbit Bot <orbit-bot@localhost>');
  });

  it('commits only the given paths, and says so when there is nothing to commit', async () => {
    writeFileSync(join(wt, 'a.txt'), 'a\n');
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    expect((await call('git_commit', { message: 'only a', paths: ['a.txt'] })).isError).toBe(false);
    expect(git(wt, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt');
    expect(git(wt, 'status', '--short')).toBe('?? b.txt');
    expect(await call('git_commit', { message: 'again', paths: ['a.txt'] })).toEqual({
      isError: false,
      text: 'Nothing to commit on orbit/test: no changes in the given paths.',
    });
    rmSync(join(wt, 'b.txt'));
    expect(await call('git_commit', { message: 'again' })).toMatchObject({
      isError: false,
      text: matching(/^Nothing to commit/),
    });
  });

  it('refuses unsafe paths and blank messages before running git', async () => {
    writeFileSync(join(wt, 'a.txt'), 'a\n');
    const before = head(wt);
    for (const p of [
      '../outside',
      '/etc/passwd',
      '-A',
      '--all',
      'a\0b',
      ':(top)a.txt',
      'x/../../y',
      'C:\\x',
      '',
    ]) {
      expect(await call('git_commit', { message: 'm', paths: [p] })).toMatchObject({
        isError: true,
        text: matching(/Invalid arguments/),
      });
    }
    expect(await call('git_commit', { message: '   ' })).toMatchObject({ isError: true });
    expect(await call('git_commit', { message: 'x'.repeat(5001) })).toMatchObject({
      isError: true,
    });
    expect(head(wt)).toBe(before);
    expect(existsSync(argvLog)).toBe(false);
    expect(pathProblem('src/a.ts')).toBeNull();
    expect(pathProblem('docs/..hidden/x')).toBeNull();
  });

  it('commits and pushes only on orbit/* branches, and only inside a work tree', async () => {
    const feature = join(base, 'feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
    ctx = { ...ctx, workspace: feature };
    writeFileSync(join(feature, 'm.txt'), 'm\n');
    for (const tool of ['git_commit', 'git_push']) {
      expect(await call(tool, { message: 'm' })).toMatchObject({
        isError: true,
        text: matching(/on branch "feature"; .*orbit\/<bot> branch/),
      });
    }
    git(wt, 'checkout', '-q', '--detach');
    ctx = { ...ctx, workspace: wt };
    expect(await call('git_commit', { message: 'm' })).toMatchObject({
      isError: true,
      text: matching(/detached/),
    });
    const plain = join(base, 'plain');
    mkdirSync(plain);
    ctx = { ...ctx, workspace: plain };
    for (const tool of ['git_commit', 'git_push', 'git_status', 'git_log']) {
      expect(await call(tool, { message: 'm' })).toMatchObject({
        isError: true,
        text: 'The workspace is not inside a git work tree',
      });
    }
  });

  it('refuses a workspace that keeps its own .git (Bot-writable config) or sits inside another repo', async () => {
    // The main checkout's .git is inside its folder: its config is Bot-writable there.
    git(repo, 'checkout', '-q', '-b', 'orbit/own-git');
    ctx = { ...ctx, workspace: repo };
    writeFileSync(join(repo, 'm.txt'), 'm\n');
    for (const tool of ['git_commit', 'git_push', 'git_status', 'git_diff', 'git_log']) {
      expect(await call(tool, { message: 'm' })).toMatchObject({
        isError: true,
        text: matching(/keeps its own \.git/),
      });
    }
    const nested = join(repo, 'sub');
    mkdirSync(nested);
    ctx = { ...ctx, workspace: nested };
    expect(await call('git_status', {})).toMatchObject({
      isError: true,
      text: matching(/not the top of a git work tree/),
    });
  });

  it('pushes the Bot branch to the remote, without hooks and without forcing', async () => {
    writeFileSync(join(wt, 'a.txt'), 'a\n');
    await call('git_commit', { message: 'a' });
    const r = await call('git_push');
    expect(r).toMatchObject({
      isError: false,
      text: matching(/^Pushed orbit\/test \([0-9a-f]+\) to origin\./),
    });
    expect(git(bare, 'rev-parse', 'refs/heads/orbit/test')).toBe(head(wt));
    expect(existsSync(join(base, 'pre-push-ran'))).toBe(false);
    const argv = readFileSync(argvLog, 'utf8').split('\n');
    expect(argv).toContain('HEAD:refs/heads/orbit/test');
    expect(argv.some((a) => /^-f$|^--force/.test(a) || a.startsWith('+'))).toBe(false);

    expect(await call('git_push', { remote: 'nope' })).toMatchObject({
      isError: true,
      text: 'There is no remote named "nope" in this repository',
    });
    for (const remote of ['-x', '--mirror', 'a b', '..', 'origin/x']) {
      expect(await call('git_push', { remote })).toMatchObject({ isError: true });
    }
  });

  it('fails clearly when the remote branch has diverged, and leaves it alone', async () => {
    writeFileSync(join(wt, 'a.txt'), 'a\n');
    await call('git_commit', { message: 'a' });
    expect((await call('git_push')).isError).toBe(false);

    const other = join(base, 'other');
    git(base, 'clone', '-q', '-b', 'orbit/test', bare, other);
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
    git(other, 'add', '-A');
    git(other, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'theirs');
    git(other, 'push', '-q', 'origin', 'orbit/test');
    const theirs = head(other);

    writeFileSync(join(wt, 'mine.txt'), 'mine\n');
    await call('git_commit', { message: 'mine' });
    expect(await call('git_push')).toMatchObject({
      isError: true,
      text: matching(/rejected.*non-fast-forward.*never force-pushes/),
    });
    expect(git(bare, 'rev-parse', 'refs/heads/orbit/test')).toBe(theirs);
  });

  it('passes the push token only through GIT_CONFIG_* for an https github.com remote, never on argv', async () => {
    // origin looks like GitHub; git rewrites it to the local bare remote.
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git');
    git(repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/widgets.git');
    writeFileSync(join(wt, 'a.txt'), 'a\n');
    await call('git_commit', { message: 'a' });
    expect((await call('git_push')).isError).toBe(false);
    expect(git(bare, 'rev-parse', 'refs/heads/orbit/test')).toBe(head(wt));

    const argv = readFileSync(argvLog, 'utf8');
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain(BASIC);
    expect(argv.split('\n')).not.toContain('-c');
    const env = readFileSync(envLog, 'utf8');
    expect(env).toContain('=http.https://github.com/.extraheader');
    expect(env).toContain(`=AUTHORIZATION: basic ${BASIC}`);
    // The raw token never reaches git's environment (only the scoped header does).
    expect(env).not.toContain(TOKEN);
    expect(env).not.toContain(join(base, 'elsewhere'));
  });

  it('shows status, diff and log', async () => {
    writeFileSync(join(wt, 'README.md'), '# Widgets\nmore\n');
    writeFileSync(join(wt, 'new.txt'), 'new\n');
    writeFileSync(join(wt, 'staged.txt'), 'staged\n');
    git(wt, 'add', 'staged.txt');
    const status = await call('git_status');
    expect(status.text).toMatch(/^## orbit\/test\n/);
    expect(status.text).toContain(' M README.md');
    expect(status.text).toContain('A  staged.txt');
    expect(status.text).toContain('?? new.txt');

    const diff = await call('git_diff');
    expect(diff.text).toMatch(/^Staged changes:\ndiff --git a\/staged\.txt/);
    expect(diff.text).toContain('Unstaged changes:\ndiff --git a/README.md');
    expect(diff.text).toContain('+more');
    expect(diff.text).toContain('Untracked files:\nnew.txt');
    const narrowed = await call('git_diff', { paths: ['README.md'], maxChars: 1000 });
    expect(narrowed.text).toContain('Staged changes:\n(none)');
    expect(narrowed.text).toContain('Untracked files:\n(none)');
    writeFileSync(join(wt, 'big.txt'), 'line\n'.repeat(2000));
    git(wt, 'add', 'big.txt');
    expect((await call('git_diff', { maxChars: 1000 })).text).toMatch(
      /truncated at 1000 characters/,
    );

    expect((await call('git_log', { limit: 5 })).text).toMatch(
      /^[0-9a-f]{7,} \d{4}-\d\d-\d\d Owner: init$/,
    );

    git(wt, 'reset', '-q', '--hard');
    git(wt, 'clean', '-qfd');
    expect((await call('git_status')).text).toBe('## orbit/test\n(clean: nothing to commit)');
  });
});

describe('github plugin: git environment', () => {
  it('builds config only as GIT_CONFIG_* variables, dropping inherited git variables and the token', () => {
    const env = gitEnv(
      {
        workspace: '.',
        env: {
          PATH: '/bin',
          GITHUB_TOKEN: TOKEN,
          GIT_DIR: '/x',
          GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/evil'",
          GIT_AUTHOR_NAME: 'Bot <evil>\nx',
        },
      },
      pushAuthConfig('https://github.com/acme/widgets.git', TOKEN),
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Bot  evil  x',
      GIT_COMMITTER_EMAIL: 'orbit-bot@localhost',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'commit.gpgSign',
      GIT_CONFIG_VALUE_1: 'false',
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    const n = Number(env.GIT_CONFIG_COUNT);
    expect(env[`GIT_CONFIG_KEY_${n - 1}`]).toBe('http.https://github.com/.extraheader');
    expect(env[`GIT_CONFIG_VALUE_${n - 1}`]).toBe(`AUTHORIZATION: basic ${BASIC}`);
    expect(env[`GIT_CONFIG_VALUE_${n - 2}`]).toBe('');
  });

  it('sends push credentials only to https github.com remotes', () => {
    expect(pushAuthConfig('https://github.com/acme/widgets.git', TOKEN)).toHaveLength(2);
    expect(pushAuthConfig('https://GitHub.com/acme/widgets', TOKEN)).toHaveLength(2);
    for (const url of [
      'http://github.com/acme/widgets.git',
      'https://github.com.evil.test/acme/widgets.git',
      'https://gitlab.com/acme/widgets.git',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
      '/tmp/remote.git',
    ]) {
      expect(pushAuthConfig(url, TOKEN)).toEqual([]);
    }
    expect(pushAuthConfig('https://github.com/acme/widgets.git', undefined)).toEqual([]);
  });
});
