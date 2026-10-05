import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitError } from '@orbit/core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FULL_SUPPORT, NO_SUPPORT, type Reply, fakeRunner, makeBot } from '../test/helpers';
import {
  SandboxManager,
  type SandboxManagerOptions,
  containerEngineEnv,
  dockerShellContained,
} from './manager';
import { staticApiKey } from './proxy/key-source';

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
  const credential = { kind: 'key' as const, source: staticApiKey('sk-ant-api03-UNITSECRET') };
  const managers: SandboxManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
  });
  const manager = (
    opts: Partial<SandboxManagerOptions> & { run: SandboxManagerOptions['run'] },
  ) => {
    const m = new SandboxManager({ ...fresh(), support: FULL_SUPPORT, credential, ...opts });
    managers.push(m);
    return m;
  };
  /** Replies of a Docker daemon that has the image and (optionally) the container. */
  const daemon =
    (container: string | null, image = 'sha256:image1', extra?: (args: string[]) => Reply) =>
    (_f: string, args: string[]): Reply => {
      const e = extra?.(args);
      if (e !== undefined) return e;
      if (args[0] === 'inspect') return container === null ? NO_SUCH : { stdout: `${container}\n` };
      if (args[0] === 'image') return { stdout: `${image}\n` };
      return undefined;
    };

  it('creates a missing container: limits, no privileges, no network, read-only socket mount', async () => {
    const dirs = fresh();
    const run = fakeRunner(daemon(null));
    const m = manager({ ...dirs, run, containerUser: '1000:1000' });
    const bot = dockerBot({ cpus: 1.5, memoryMb: 1024, pidsLimit: 256 });
    const ws = await m.prepare(bot, 'sdk');

    expect(run.calls.map((c) => c.args[0])).toEqual(['inspect', 'run', 'exec']);
    expect(run.calls[1]!.file).toBe('docker');
    const sockets = join(realpathSync(dirs.orbitHome), 'run', 'sandbox', 'bot_test1');
    expect(run.calls[1]!.args).toEqual([
      'run',
      '-d',
      '--name',
      'orbit-bot-bot_test1',
      '--label',
      'orbit.bot=bot_test1',
      '--label',
      `orbit.config=${m.containerConfigHash(bot, ws.path)}`,
      '--init',
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
      '-v',
      `${sockets}:/run/orbit:ro`,
      '-w',
      '/workspace',
      'orbit-sandbox:latest',
      'sh',
      '-c',
      'socat TCP-LISTEN:47180,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/orbit/api.sock & exec sleep infinity',
    ]);
    // The bridge is checked end to end before the workspace is handed out.
    expect(run.calls[2]!.args).toEqual([
      'exec',
      'orbit-bot-bot_test1',
      'sh',
      '-c',
      'socat -u OPEN:/dev/null UNIX-CONNECT:/run/orbit/api.sock && socat -u OPEN:/dev/null TCP:127.0.0.1:47180',
    ]);
    const { release, ...data } = ws;
    expect(typeof release).toBe('function');
    expect(data).toEqual({
      botId: 'bot_test1',
      kind: 'docker',
      path: ws.path,
      isolation: 'container',
      // No network and no key in the container: Bash is contained (ADR-018).
      shellContained: true,
      engineSandboxSettings: null,
      docker: {
        container: 'orbit-bot-bot_test1',
        workdir: '/workspace',
        env: containerEngineEnv('none'),
      },
      mounts: [{ container: '/workspace', host: ws.path, writable: true }],
    });
    expect(ws.path.endsWith(join('workspaces', 'bot_test1'))).toBe(true);
    expect(statSync(ws.path).mode & 0o777).toBe(0o700);
    // The proxy sockets: a private directory, 0600 sockets, only the API one without network.
    expect(statSync(sockets).mode & 0o777).toBe(0o700);
    expect(statSync(join(sockets, 'api.sock')).isSocket()).toBe(true);
    expect(statSync(join(sockets, 'api.sock')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(sockets, 'egress.sock'))).toBe(false);
  });

  it('with an allowlist: still no docker network, an egress bridge, Bash stays EXTERNAL', async () => {
    const run = fakeRunner(daemon(null));
    const m = manager({ run, containerUser: null });
    const ws = await m.prepare(
      dockerBot({ network: 'allowlist', allowedDomains: ['pypi.org'], repo: '/src/repo' }),
      'sdk',
    );
    const args = run.calls[1]!.args;
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).not.toContain('--user');
    expect(args.slice(-6)).toEqual([
      '-v',
      '/src/repo:/repo:ro',
      'orbit-sandbox:latest',
      'sh',
      '-c',
      'socat TCP-LISTEN:47180,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/orbit/api.sock & ' +
        'socat TCP-LISTEN:47181,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/orbit/egress.sock & ' +
        'exec sleep infinity',
    ]);
    expect(ws.shellContained).toBe(false);
    expect(ws.docker?.env).toEqual(containerEngineEnv('allowlist'));
    expect(ws.mounts).toEqual([
      { container: '/workspace', host: ws.path, writable: true },
      { container: '/repo', host: '/src/repo', writable: false },
    ]);
    expect(existsSync(join(m.socketDir(dockerBot()), 'egress.sock'))).toBe(true);
  });

  it('never puts environment values other than HOME (or any key) on the docker run command line', async () => {
    const run = fakeRunner(daemon(null));
    const m = manager({ run });
    await m.prepare(dockerBot({ network: 'allowlist', allowedDomains: ['pypi.org'] }), 'sdk');
    const args = run.calls[1]!.args;
    const envFlags = args.flatMap((a, i) => (a === '--env' || a === '-e' ? [args[i + 1]] : []));
    expect(envFlags).toEqual(['HOME=/workspace/.orbit-home']);
    expect(args.join(' ')).not.toMatch(/ANTHROPIC|API_KEY|TOKEN|sk-ant|UNITSECRET|PROXY/);
  });

  it('reuses a running container whose config and image match', async () => {
    const run = fakeRunner();
    const m = manager({ run });
    const bot = dockerBot();
    const hash = m.containerConfigHash(bot, m.workspacePath(bot));
    run.reply = daemon(`true sha256:image1 bot_test1 ${hash}`);
    const ws = await m.prepare(bot, 'sdk');
    expect(run.calls.map((c) => c.args.slice(0, 2))).toEqual([
      ['inspect', '--type'],
      ['image', 'inspect'],
    ]);
    expect(ws.shellContained).toBe(true);
  });

  it('starts a stopped container and checks its bridge', async () => {
    const run = fakeRunner();
    const m = manager({ run });
    const bot = dockerBot();
    run.reply = daemon(
      `false sha256:image1 bot_test1 ${m.containerConfigHash(bot, m.workspacePath(bot))}`,
    );
    await m.prepare(bot, 'sdk');
    expect(run.calls.map((c) => c.args[0])).toEqual(['inspect', 'image', 'start', 'exec']);
    expect(run.calls[2]!.args).toEqual(['start', 'orbit-bot-bot_test1']);
  });

  describe('recreates a container when what shapes it changed', () => {
    const recreated = ['inspect', 'image', 'rm', 'run', 'exec'];
    const cases: [string, (hash: string) => string, string[]][] = [
      [
        'limits/network/mounts changed',
        () => 'true sha256:image1 bot_test1 0123456789abcdef',
        recreated,
      ],
      ['the image was rebuilt', (h) => `true sha256:image0 bot_test1 ${h}`, recreated],
      [
        'a container from before ADR-018 (no config label)',
        () => 'true sha256:image1 bot_test1 <no value>',
        recreated,
      ],
      ['nothing changed', (h) => `true sha256:image1 bot_test1 ${h}`, ['inspect', 'image']],
    ];
    for (const [name, state, calls] of cases) {
      it(name, async () => {
        const run = fakeRunner();
        const m = manager({ run });
        const bot = dockerBot();
        run.reply = daemon(state(m.containerConfigHash(bot, m.workspacePath(bot))));
        await m.prepare(bot, 'sdk');
        expect(run.calls.map((c) => c.args[0])).toEqual(calls);
        if (calls.includes('rm')) {
          expect(run.calls[2]!.args).toEqual(['rm', '-f', 'orbit-bot-bot_test1']);
        }
      });
    }

    it('the hash covers image, limits, network, mounts and user', () => {
      const m = manager({ run: fakeRunner(), containerUser: '1000:1000' });
      const base = dockerBot();
      const path = m.workspacePath(base);
      const hash = (bot: ReturnType<typeof dockerBot>, mm = m) => mm.containerConfigHash(bot, path);
      const variants = [
        dockerBot({ image: 'orbit-sandbox:v2' }),
        dockerBot({ cpus: 3 }),
        dockerBot({ memoryMb: 4096 }),
        dockerBot({ pidsLimit: 1024 }),
        dockerBot({ network: 'allowlist', allowedDomains: ['pypi.org'] }),
        dockerBot({ repo: '/src/repo' }),
      ];
      const hashes = new Set([hash(base), ...variants.map((b) => hash(b))]);
      expect(hashes.size).toBe(variants.length + 1);
      const otherUser = manager({ run: fakeRunner(), containerUser: '1001:1001' });
      expect(otherUser.containerConfigHash(base, path)).not.toBe(hash(base));
      // The allowlist itself is read live by the egress proxy: no recreate for a new domain.
      expect(hash(dockerBot({ network: 'allowlist', allowedDomains: ['a.org'] }))).toBe(
        hash(dockerBot({ network: 'allowlist', allowedDomains: ['b.org'] })),
      );
    });

    it('keeps a stale container while a Run of the Bot is active, and treats its shell as uncontained', async () => {
      const run = fakeRunner();
      const m = manager({ run });
      const bot = dockerBot();
      const hash = m.containerConfigHash(bot, m.workspacePath(bot));
      run.reply = daemon(`true sha256:image1 bot_test1 ${hash}`);
      const first = await m.prepare(bot, 'sdk');
      run.calls.length = 0;
      run.reply = daemon('true sha256:image1 bot_test1 0123456789abcdef');
      const second = await m.prepare(bot, 'sdk');
      expect(run.calls.map((c) => c.args[0])).toEqual(['inspect', 'image']);
      expect(second.shellContained).toBe(false);
      // Both Runs end: the next prepare applies the change.
      first.release?.();
      second.release?.();
      run.calls.length = 0;
      await m.prepare(bot, 'sdk');
      expect(run.calls.map((c) => c.args[0])).toEqual(['inspect', 'image', 'rm', 'run', 'exec']);
    });

    it('does not recreate on image grounds when the image is not present locally', async () => {
      const run = fakeRunner();
      const m = manager({ run });
      const bot = dockerBot();
      const hash = m.containerConfigHash(bot, m.workspacePath(bot));
      run.reply = daemon(`true sha256:image1 bot_test1 ${hash}`, '', (args) =>
        args[0] === 'image' ? { code: 1, stderr: 'No such image' } : undefined,
      );
      await m.prepare(bot, 'sdk');
      expect(run.calls.map((c) => c.args[0])).toEqual(['inspect', 'image']);
    });

    it('prepares one Bot at a time (two Runs never both recreate)', async () => {
      const run = fakeRunner();
      const m = manager({ run });
      const bot = dockerBot();
      run.reply = daemon('true sha256:image1 bot_test1 0123456789abcdef');
      const [a, b] = await Promise.all([m.prepare(bot, 'sdk'), m.prepare(bot, 'sdk')]);
      expect(run.calls.filter((c) => c.args[0] === 'rm')).toHaveLength(1);
      expect([a.shellContained, b.shellContained].sort()).toEqual([false, true]);
    });
  });

  it(
    'fails clearly when the bridge never answers (image without socat)',
    { timeout: 15_000 },
    async () => {
      const run = fakeRunner(
        daemon(null, 'sha256:image1', (args) =>
          args[0] === 'exec' ? { code: 127, stderr: 'sh: socat: not found' } : undefined,
        ),
      );
      const m = manager({ run });
      const err = await rejection(m.prepare(dockerBot(), 'sdk'));
      expect(err.code).toBe('driver_unavailable');
      expect(err.message).toMatch(/socat: not found/);
      expect(err.hint).toMatch(/socat/);
      expect(err.hint).toMatch(/ADR-018/);
    },
  );

  it('refuses a same-named container that belongs to another Bot', async () => {
    const run = fakeRunner(daemon('true sha256:image1 bot_other abc'));
    const m = manager({ run });
    const err = await rejection(m.prepare(dockerBot(), 'sdk'));
    expect(err.code).toBe('invalid_config');
    expect(run.calls).toHaveLength(1);
  });

  it('refuses the CLI driver: subscription credentials never enter containers', async () => {
    const run = fakeRunner();
    const m = manager({ run });
    const err = await rejection(m.prepare(dockerBot(), 'cli'));
    expect(err.code).toBe('invalid_config');
    expect(err.hint).toMatch(/ADR-004/);
    expect(err.hint).toMatch(/API key/);
    expect(run.calls).toEqual([]);
  });

  it('refuses Bedrock and Vertex: their credentials cannot go through the key proxy', async () => {
    for (const provider of ['bedrock', 'vertex'] as const) {
      const run = fakeRunner();
      const m = manager({ run, credential: { kind: 'unsupported', provider } });
      const err = await rejection(m.prepare(dockerBot(), 'sdk'));
      expect(err.code).toBe('invalid_config');
      expect(err.message).toMatch(provider === 'bedrock' ? /Bedrock/ : /Vertex/);
      expect(err.hint).toMatch(/worktree/);
      expect(run.calls).toEqual([]);
    }
  });

  it('refuses the SDK driver without an API key, but lets the mock driver prepare', async () => {
    const run = fakeRunner(daemon(null));
    const m = manager({ run, credential: { kind: 'none' } });
    const err = await rejection(m.prepare(dockerBot(), 'sdk'));
    expect(err.code).toBe('auth_required');
    expect(run.calls).toEqual([]);
    await m.prepare(dockerBot(), 'mock');
    expect(run.calls.map((c) => c.args[0])).toEqual(['inspect', 'run', 'exec']);
  });

  it('fails with driver_unavailable when docker is missing', async () => {
    const run = fakeRunner();
    const m = manager({ run, support: NO_SUPPORT });
    const err = await rejection(m.prepare(dockerBot(), 'sdk'));
    expect(err.code).toBe('driver_unavailable');
    expect(err.message).toMatch(/docker CLI not found/);
    expect(err.hint).toMatch(/worktree/);
  });

  it('destroy removes an owned container, stops its proxies and keeps the directory unless purged', async () => {
    const run = fakeRunner(daemon(null));
    const m = manager({ run });
    const bot = dockerBot();
    const ws = await m.prepare(bot, 'sdk');
    expect(m.proxyStatus().map((p) => p.botId)).toEqual(['bot_test1']);
    run.calls.length = 0;
    run.reply = daemon('true sha256:image1 bot_test1 abc');
    await m.destroy(bot);
    expect(run.calls.map((c) => c.args)).toEqual([
      expect.arrayContaining(['inspect']),
      ['rm', '-f', 'orbit-bot-bot_test1'],
    ]);
    expect(m.proxyStatus()).toEqual([]);
    expect(existsSync(join(m.socketDir(bot), 'api.sock'))).toBe(false);
    expect(existsSync(ws.path)).toBe(true);
    await m.destroy(bot, { purge: true });
    expect(existsSync(ws.path)).toBe(false);
    expect(existsSync(m.socketDir(bot))).toBe(false);
  });

  it('destroy is a no-op for a missing container', async () => {
    const run = fakeRunner(() => NO_SUCH);
    const m = manager({ run });
    await m.destroy(dockerBot());
    expect(run.calls.map((c) => c.args[0])).toEqual(['inspect']);
  });

  it('reports image presence and socat for doctor', async () => {
    const run = fakeRunner((_f, args) => {
      if (args[0] === 'image') {
        return args.at(-1) === 'missing:latest' ? { code: 1 } : { stdout: 'sha256:x' };
      }
      if (args[0] === 'run') return args.includes('nosocat:latest') ? { code: 127 } : undefined;
      return undefined;
    });
    const m = manager({ run });
    expect(
      await m.imageStatus(['orbit-sandbox:latest', 'nosocat:latest', 'missing:latest']),
    ).toEqual([
      { image: 'orbit-sandbox:latest', present: true, socat: true },
      { image: 'nosocat:latest', present: true, socat: false },
      { image: 'missing:latest', present: false, socat: null },
    ]);
    const socatRun = run.calls.find((c) => c.args[0] === 'run')!;
    expect(socatRun.args).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'socat',
      'orbit-sandbox:latest',
      '-V',
    ]);
    const none = manager({ run: fakeRunner(), support: NO_SUPPORT });
    expect(await none.imageStatus(['orbit-sandbox:latest'])).toEqual([
      { image: 'orbit-sandbox:latest', present: false, socat: null },
    ]);
  });
});

describe('docker shell containment (Bash tier rule, ADR-018)', () => {
  it('is contained only without network and only in a container that matches the spec', () => {
    expect(dockerShellContained('none', false)).toBe(true);
    expect(dockerShellContained('allowlist', false)).toBe(false);
    expect(dockerShellContained('none', true)).toBe(false);
    expect(dockerShellContained('allowlist', true)).toBe(false);
  });
});

describe('SandboxManager — directory', () => {
  it('creates a private directory confined by the native sandbox', async () => {
    const dirs = fresh();
    const m = new SandboxManager({ ...dirs, run: fakeRunner(), support: FULL_SUPPORT });
    const bot = makeBot({ name: 'My Dir Bot!', readRoots: ['/srv/shared'] });
    const ws = await m.prepare(bot, 'cli');
    expect(ws.kind).toBe('directory');
    expect(ws.path.endsWith(join('workspaces', 'bot_test1'))).toBe(true);
    expect(statSync(ws.path).mode & 0o777).toBe(0o700);
    expect(ws.isolation).toBe('engine-sandbox');
    expect(ws.shellContained).toBe(false);
    expect(ws.docker).toBeNull();
    const fs = (ws.engineSandboxSettings as { filesystem: Record<string, string[]> }).filesystem;
    expect(fs.allowWrite).toEqual([ws.path]);
    expect(fs.denyRead).toContain(join(dirs.home, '.claude'));
    expect(fs.denyRead).not.toContain(ws.path);
    expect(fs.allowRead).toEqual(['/srv/shared', ws.path]);
  });

  it('moves a workspace kept under the M2 name slug to its id path, files included', async () => {
    const dirs = fresh();
    // Renamed since M2: the workspace is found by the name it had then.
    const m = new SandboxManager({
      ...dirs,
      run: fakeRunner(),
      support: FULL_SUPPORT,
      legacyName: (b) => (b.id === 'bot_test1' ? 'Legacy Bot' : null),
    });
    const bot = makeBot({ name: 'Renamed Bot' });
    const legacy = join(dirs.orbitHome, 'workspaces', 'legacy-bot');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'notes.md'), 'kept');
    const ws = await m.prepare(bot, 'cli');
    expect(ws.path.endsWith(join('workspaces', 'bot_test1'))).toBe(true);
    expect(existsSync(join(ws.path, 'notes.md'))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it("never adopts another Bot's old workspace (no legacy name → fresh directory)", async () => {
    const dirs = fresh();
    const m = new SandboxManager({ ...dirs, run: fakeRunner(), support: FULL_SUPPORT });
    const legacy = join(dirs.orbitHome, 'workspaces', 'legacy-bot');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'notes.md'), 'not yours');
    const ws = await m.prepare(makeBot({ name: 'Legacy Bot' }, 'bot_newcomer'), 'cli');
    expect(existsSync(join(ws.path, 'notes.md'))).toBe(false);
    expect(existsSync(join(legacy, 'notes.md'))).toBe(true);
  });

  it('refuses Bot ids that are not safe path, container and branch names', () => {
    const m = new SandboxManager({ ...fresh(), run: fakeRunner(), support: FULL_SUPPORT });
    expect(() => m.workspacePath(makeBot({}, '../escape'))).toThrow(/cannot name a workspace/);
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

  it('adds a worktree on branch orbit/<bot id>', async () => {
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
      ['git', '-C', repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/orbit/bot_test1'],
      ['git', '-C', repo, 'worktree', 'add', '-B', 'orbit/bot_test1', ws.path],
    ]);
    expect(ws.kind).toBe('worktree');
    // Plugins that run git get these from Orbit, never from the workspace's .git (M7 H1).
    expect(ws.git).toEqual({ repo, branch: 'orbit/bot_test1' });
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
      'orbit/bot_test1',
    ]);
  });

  it('is idempotent when the path is already a worktree of the repo', async () => {
    const dirs = fresh();
    const path = join(dirs.orbitHome, 'workspaces', 'bot_test1');
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
