import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitError } from '@orbit/core';
import { afterAll, describe, expect, it } from 'vitest';
import { FULL_SUPPORT, NO_SUPPORT, fakeRunner, makeBot } from '../test/helpers';
import { SandboxManager } from './manager';

const root = mkdtempSync(join(tmpdir(), 'orbit-sandbox-unit-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
const fresh = () => {
  n += 1;
  const dir = join(root, `case-${n}`);
  return { orbitHome: join(dir, 'orbit'), home: join(dir, 'home') };
};

const NO_SUCH = { code: 1, stderr: 'Error: No such object: orbit-bot-x\n' };

async function rejection(p: Promise<unknown>): Promise<OrbitError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OrbitError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('SandboxManager — docker', () => {
  const dockerBot = (sandbox: Record<string, unknown> = {}) =>
    makeBot({ name: 'Docker Bot', sandbox: { kind: 'docker', ...sandbox } });

  it('creates a missing container with limits, no privileges and no network', async () => {
    const dirs = fresh();
    const run = fakeRunner((_f, args) => (args[0] === 'inspect' ? NO_SUCH : undefined));
    const m = new SandboxManager({
      ...dirs,
      run,
      support: FULL_SUPPORT,
      containerUser: '1000:1000',
    });
    const bot = dockerBot({ cpus: 1.5, memoryMb: 1024, pidsLimit: 256 });
    const ws = await m.prepare(bot, 'sdk');

    expect(run.calls.map((c) => c.args[0])).toEqual(['inspect', 'run']);
    expect(run.calls[1]!.file).toBe('docker');
    expect(run.calls[1]!.args).toEqual([
      'run',
      '-d',
      '--name',
      'orbit-bot-docker-bot',
      '--label',
      'orbit.bot=bot_test1',
      '--cpus',
      '1.5',
      '--memory',
      '1024m',
      '--pids-limit',
      '256',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/tmp:rw,size=256m',
      '--user',
      '1000:1000',
      '--env',
      'HOME=/workspace/.orbit-home',
      '-v',
      `${ws.path}:/workspace`,
      '-w',
      '/workspace',
      'orbit-sandbox:latest',
      'sleep',
      'infinity',
    ]);
    expect(ws).toEqual({
      botId: 'bot_test1',
      kind: 'docker',
      path: ws.path,
      isolation: 'container',
      shellContained: true,
      engineSandboxSettings: null,
      docker: { container: 'orbit-bot-docker-bot', workdir: '/workspace' },
    });
    expect(ws.path.endsWith(join('workspaces', 'docker-bot'))).toBe(true);
    expect(statSync(ws.path).mode & 0o777).toBe(0o700);
  });

  it('uses the bridge network for allowlist and mounts the repo read-only', async () => {
    const run = fakeRunner((_f, args) => (args[0] === 'inspect' ? NO_SUCH : undefined));
    const m = new SandboxManager({ ...fresh(), run, support: FULL_SUPPORT, containerUser: null });
    const ws = await m.prepare(
      dockerBot({ network: 'allowlist', allowedDomains: ['pypi.org'], repo: '/src/repo' }),
      'mock',
    );
    const args = run.calls[1]!.args;
    expect(args[args.indexOf('--network') + 1]).toBe('bridge');
    expect(args).not.toContain('--user');
    expect(args.slice(-5)).toEqual([
      '-v',
      '/src/repo:/repo:ro',
      'orbit-sandbox:latest',
      'sleep',
      'infinity',
    ]);
    expect(ws.shellContained).toBe(false);
  });

  it('never puts environment values other than HOME on the docker run command line', async () => {
    const run = fakeRunner((_f, args) => (args[0] === 'inspect' ? NO_SUCH : undefined));
    const m = new SandboxManager({ ...fresh(), run, support: FULL_SUPPORT });
    await m.prepare(dockerBot(), 'sdk');
    const args = run.calls[1]!.args;
    const envFlags = args.flatMap((a, i) => (a === '--env' || a === '-e' ? [args[i + 1]] : []));
    expect(envFlags).toEqual(['HOME=/workspace/.orbit-home']);
    expect(args.join(' ')).not.toMatch(/ANTHROPIC|API_KEY|TOKEN|sk-ant/);
  });

  it('reuses a running container', async () => {
    const run = fakeRunner(() => ({ stdout: 'true bot_test1\n' }));
    const m = new SandboxManager({ ...fresh(), run, support: FULL_SUPPORT });
    await m.prepare(dockerBot(), 'sdk');
    expect(run.calls.map((c) => c.args[0])).toEqual(['inspect']);
  });

  it('starts a stopped container', async () => {
    const run = fakeRunner(() => ({ stdout: 'false bot_test1\n' }));
    const m = new SandboxManager({ ...fresh(), run, support: FULL_SUPPORT });
    await m.prepare(dockerBot(), 'sdk');
    expect(run.calls.map((c) => c.args)).toEqual([
      expect.arrayContaining(['inspect', 'orbit-bot-docker-bot']),
      ['start', 'orbit-bot-docker-bot'],
    ]);
  });

  it('refuses a same-named container that belongs to another Bot', async () => {
    const run = fakeRunner(() => ({ stdout: 'true bot_other\n' }));
    const m = new SandboxManager({ ...fresh(), run, support: FULL_SUPPORT });
    const err = await rejection(m.prepare(dockerBot(), 'sdk'));
    expect(err.code).toBe('invalid_config');
    expect(run.calls).toHaveLength(1);
  });

  it('refuses the CLI driver: subscription credentials never enter containers', async () => {
    const run = fakeRunner();
    const m = new SandboxManager({ ...fresh(), run, support: FULL_SUPPORT });
    const err = await rejection(m.prepare(dockerBot(), 'cli'));
    expect(err.code).toBe('invalid_config');
    expect(err.hint).toMatch(/ADR-004/);
    expect(err.hint).toMatch(/API key/);
    expect(run.calls).toEqual([]);
  });

  it('fails with driver_unavailable when docker is missing', async () => {
    const run = fakeRunner();
    const m = new SandboxManager({ ...fresh(), run, support: NO_SUPPORT });
    const err = await rejection(m.prepare(dockerBot(), 'sdk'));
    expect(err.code).toBe('driver_unavailable');
    expect(err.message).toMatch(/docker CLI not found/);
    expect(err.hint).toMatch(/worktree/);
  });

  it('destroy removes an owned container and keeps the directory unless purged', async () => {
    const run = fakeRunner((_f, args) =>
      args[0] === 'inspect' ? { stdout: 'true bot_test1' } : undefined,
    );
    const m = new SandboxManager({ ...fresh(), run, support: FULL_SUPPORT });
    const bot = dockerBot();
    const ws = await m.prepare(bot, 'sdk');
    run.calls.length = 0;
    await m.destroy(bot);
    expect(run.calls.map((c) => c.args)).toEqual([
      expect.arrayContaining(['inspect']),
      ['rm', '-f', 'orbit-bot-docker-bot'],
    ]);
    expect(existsSync(ws.path)).toBe(true);
    await m.destroy(bot, { purge: true });
    expect(existsSync(ws.path)).toBe(false);
  });

  it('destroy is a no-op for a missing container', async () => {
    const run = fakeRunner(() => NO_SUCH);
    const m = new SandboxManager({ ...fresh(), run, support: FULL_SUPPORT });
    await m.destroy(dockerBot());
    expect(run.calls.map((c) => c.args[0])).toEqual(['inspect']);
  });
});

describe('SandboxManager — directory', () => {
  it('creates a private directory confined by the native sandbox', async () => {
    const dirs = fresh();
    const m = new SandboxManager({ ...dirs, run: fakeRunner(), support: FULL_SUPPORT });
    const bot = makeBot({ name: 'My Dir Bot!', readRoots: ['/srv/shared'] });
    const ws = await m.prepare(bot, 'cli');
    expect(ws.kind).toBe('directory');
    expect(ws.path.endsWith(join('workspaces', 'my-dir-bot'))).toBe(true);
    expect(statSync(ws.path).mode & 0o777).toBe(0o700);
    expect(ws.isolation).toBe('engine-sandbox');
    expect(ws.shellContained).toBe(true);
    expect(ws.docker).toBeNull();
    const fs = (ws.engineSandboxSettings as { filesystem: Record<string, string[]> }).filesystem;
    expect(fs.allowWrite).toEqual([ws.path]);
    expect(fs.denyRead).toContain(join(dirs.home, '.claude'));
    expect(fs.denyRead).not.toContain(ws.path);
    expect(fs.allowRead).toEqual(['/srv/shared', ws.path]);
  });

  it('is not shell-contained when the network is an allowlist', async () => {
    const m = new SandboxManager({ ...fresh(), run: fakeRunner(), support: FULL_SUPPORT });
    const ws = await m.prepare(
      makeBot({ sandbox: { network: 'allowlist', allowedDomains: ['pypi.org'] } }),
      'cli',
    );
    expect(ws.isolation).toBe('engine-sandbox');
    expect(ws.shellContained).toBe(false);
  });

  it('falls back to isolation none (no settings) without a native sandbox', async () => {
    const m = new SandboxManager({ ...fresh(), run: fakeRunner(), support: NO_SUPPORT });
    const ws = await m.prepare(makeBot(), 'cli');
    expect(ws).toMatchObject({
      isolation: 'none',
      shellContained: false,
      engineSandboxSettings: null,
    });
  });
});

describe('SandboxManager — worktree (commands)', () => {
  const repo = '/src/repo';
  const wtBot = () => makeBot({ name: 'WT Bot', sandbox: { kind: 'worktree', repo } });

  it('adds a worktree on branch orbit/<slug>', async () => {
    const run = fakeRunner((_f, args) =>
      args.includes('--verify')
        ? { code: 1 }
        : args.includes('list')
          ? { stdout: `worktree ${repo}\n` }
          : undefined,
    );
    const m = new SandboxManager({ ...fresh(), run, support: FULL_SUPPORT });
    const ws = await m.prepare(wtBot(), 'cli');
    expect(run.calls.map((c) => [c.file, ...c.args])).toEqual([
      ['git', '-C', repo, 'rev-parse', '--git-dir'],
      ['git', '-C', repo, 'worktree', 'list', '--porcelain'],
      ['git', '-C', repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/orbit/wt-bot'],
      ['git', '-C', repo, 'worktree', 'add', '-B', 'orbit/wt-bot', ws.path],
    ]);
    expect(ws.kind).toBe('worktree');
  });

  it('reattaches an existing Bot branch without resetting it', async () => {
    const run = fakeRunner((_f, args) =>
      args.includes('list') ? { stdout: `worktree ${repo}\n` } : undefined,
    );
    const m = new SandboxManager({ ...fresh(), run, support: FULL_SUPPORT });
    const ws = await m.prepare(wtBot(), 'cli');
    expect(run.calls.at(-1)!.args).toEqual([
      '-C',
      repo,
      'worktree',
      'add',
      ws.path,
      'orbit/wt-bot',
    ]);
  });

  it('is idempotent when the path is already a worktree of the repo', async () => {
    const dirs = fresh();
    const path = join(dirs.orbitHome, 'workspaces', 'wt-bot');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.git'), 'gitdir: /src/repo/.git/worktrees/wt-bot\n');
    const run = fakeRunner((_f, args) =>
      args.includes('list') ? { stdout: `worktree ${repo}\n\nworktree ${path}\n` } : undefined,
    );
    const m = new SandboxManager({ ...dirs, run, support: FULL_SUPPORT });
    await m.prepare(wtBot(), 'cli');
    expect(run.calls.map((c) => c.args.slice(2, 4))).toEqual([
      ['rev-parse', '--git-dir'],
      ['worktree', 'list'],
    ]);
  });

  it('requires an absolute repo path that is a git repository', async () => {
    const m = new SandboxManager({ ...fresh(), run: fakeRunner(), support: FULL_SUPPORT });
    for (const sandbox of [
      { kind: 'worktree' as const },
      { kind: 'worktree' as const, repo: 'rel/repo' },
    ]) {
      const err = await rejection(m.prepare(makeBot({ sandbox }), 'cli'));
      expect(err.code).toBe('invalid_config');
    }
    const notRepo = new SandboxManager({
      ...fresh(),
      run: fakeRunner(() => ({ code: 128, stderr: 'fatal: not a git repository' })),
      support: FULL_SUPPORT,
    });
    const err = await rejection(notRepo.prepare(wtBot(), 'cli'));
    expect(err.code).toBe('invalid_config');
    expect(err.message).toMatch(/not a git repository/);
  });
});
