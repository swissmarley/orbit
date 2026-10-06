import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { type Server, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PluginManifest, type PluginManifestInput } from '@orbit/core';
import { SecretVault } from '@orbit/policy';
import { type PluginSandboxSupport, detectPluginSandbox } from '@orbit/sandbox';
import { type OrbitDb, openDatabase } from '@orbit/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildChildEnv } from '../env';
import { StdioMcpClient } from './client';
import { buildPluginEnv } from './manifest';
import { PluginRegistry, defaultPluginPaths } from './registry';
import {
  gitBind,
  hiddenFolders,
  moduleRoots,
  outermostNodeModules,
  prepareSandboxedCommand,
  requestedFolders,
  sandboxStatus,
} from './sandbox';

const manifest = (over: Partial<PluginManifestInput> = {}) =>
  PluginManifest.parse({
    schemaVersion: 1,
    id: 'probe',
    name: 'Probe',
    version: '1.0.0',
    server: { transport: 'stdio', command: '${node}', args: ['${pluginDir}/server.mjs'] },
    tools: [{ name: 'run_probe', tier: 'EXTERNAL' }],
    ...over,
  });

const BWRAP: PluginSandboxSupport = {
  available: true,
  engine: 'bwrap',
  path: '/usr/bin/bwrap',
  reason: null,
  platform: 'linux',
};
const SEATBELT: PluginSandboxSupport = {
  available: true,
  engine: 'sandbox-exec',
  path: '/usr/bin/sandbox-exec',
  reason: null,
  platform: 'darwin',
};
const NONE: PluginSandboxSupport = {
  available: false,
  engine: null,
  path: null,
  reason: 'bubblewrap (bwrap) is not installed',
  platform: 'linux',
};

describe('sandboxStatus', () => {
  it.each([
    ['auto', BWRAP, 'sandboxed', null],
    ['required', BWRAP, 'sandboxed', null],
    ['auto', NONE, 'unsandboxed', 'bubblewrap (bwrap) is not installed'],
    ['required', NONE, 'refused', 'bubblewrap (bwrap) is not installed'],
    ['off', BWRAP, 'off', 'plugins.sandbox is off'],
  ] as const)('%s with %o → %s', (mode, support, state, reason) => {
    const s = sandboxStatus(manifest(), mode, support);
    expect(s).toMatchObject({ state, reason });
    expect(s.engine).toBe(state === 'sandboxed' ? 'bwrap' : null);
  });

  it('a nested sandbox (Chromium) works under bwrap, not inside sandbox-exec', () => {
    const browser = manifest({ sandbox: { network: true, nestedSandbox: true } });
    expect(sandboxStatus(browser, 'auto', BWRAP).state).toBe('sandboxed');
    expect(sandboxStatus(browser, 'auto', SEATBELT)).toMatchObject({
      state: 'unsandboxed',
      reason: expect.stringMatching(/cannot run inside macOS sandbox-exec/) as unknown,
    });
    expect(sandboxStatus(browser, 'required', SEATBELT).state).toBe('refused');
  });

  it('an http server runs elsewhere; a manifest without a sandbox section gets the defaults', () => {
    const http = manifest({ server: { transport: 'http', url: 'https://mcp.example.com/' } });
    expect(sandboxStatus(http, 'required', NONE).state).toBe('remote');
    expect(sandboxStatus(manifest(), 'auto', BWRAP).needs).toEqual({
      workspace: 'none',
      network: false,
      paths: [],
      nestedSandbox: false,
    });
  });
});

describe('requestedFolders', () => {
  const m = manifest({
    settings: [{ name: 'FS_ROOTS', required: true }, { name: 'BROWSER_EXECUTABLE' }],
    env: ['PLAYWRIGHT_BROWSERS_PATH'],
    sandbox: {
      paths: [
        { name: 'FS_ROOTS', access: 'write' },
        { name: 'BROWSER_EXECUTABLE', parent: true },
        {
          name: 'PLAYWRIGHT_BROWSERS_PATH',
          default: ['~/.cache/ms-playwright', '/opt/browsers'],
        },
      ],
    },
  });

  it('reads setting and env values (several per value), parents, and defaults under the home', () => {
    expect(
      requestedFolders(
        m,
        {
          settings: {
            FS_ROOTS: '/data/a:relative/b: /data/c ',
            BROWSER_EXECUTABLE: '/opt/chrome/chrome',
          },
          env: {},
        },
        '/home/owner',
      ),
    ).toEqual([
      { path: '/data/a', access: 'write', from: 'FS_ROOTS' },
      { path: '/data/c', access: 'write', from: 'FS_ROOTS' },
      { path: '/opt/chrome', access: 'read', from: 'BROWSER_EXECUTABLE' },
      {
        path: '/home/owner/.cache/ms-playwright',
        access: 'read',
        from: 'PLAYWRIGHT_BROWSERS_PATH',
      },
      { path: '/opt/browsers', access: 'read', from: 'PLAYWRIGHT_BROWSERS_PATH' },
    ]);
    const fromEnv = requestedFolders(
      m,
      { settings: {}, env: { PLAYWRIGHT_BROWSERS_PATH: '/srv/pw' } },
      '/home/owner',
    );
    expect(fromEnv).toEqual([
      { path: '/srv/pw', access: 'read', from: 'PLAYWRIGHT_BROWSERS_PATH' },
    ]);
  });

  it('reports folders that overlap a denied path', () => {
    const folders = requestedFolders(
      m,
      { settings: { FS_ROOTS: '/home/owner:/data' }, env: { PLAYWRIGHT_BROWSERS_PATH: '/srv/pw' } },
      '/home/owner',
    );
    expect(hiddenFolders(folders, ['/home/owner/.ssh', '/srv/orbit'])).toEqual([
      { path: '/home/owner', from: 'FS_ROOTS', overlaps: '/home/owner/.ssh' },
    ]);
  });

  it('never brings devices, kernel state or runtime sockets in as a folder', () => {
    const folders = requestedFolders(
      m,
      { settings: { FS_ROOTS: '/dev:/run/user/1000:/var/run:/proc/1:/data' }, env: {} },
      '/home/owner',
    );
    expect(hiddenFolders(folders, []).map((h) => [h.path, h.overlaps])).toEqual([
      ['/dev', '/dev'],
      ['/run/user/1000', '/run'],
      ['/var/run', '/var/run'],
      ['/proc/1', '/proc'],
    ]);
  });
});

describe('module roots and git directories', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'orbit-modroots-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds the outermost node_modules of a path', () => {
    expect(outermostNodeModules('/repo/node_modules/.pnpm/zod@4/node_modules/zod')).toBe(
      '/repo/node_modules',
    );
    expect(outermostNodeModules('/repo/plugins/kit')).toBeNull();
  });

  it('follows a pnpm layout: the store and sibling workspace packages, never arbitrary folders', () => {
    const repo = join(root, 'repo');
    const zod = join(repo, 'node_modules', '.pnpm', 'zod@4', 'node_modules', 'zod');
    mkdirSync(zod, { recursive: true });
    const kit = join(repo, 'plugins', 'kit');
    mkdirSync(join(kit, 'node_modules'), { recursive: true });
    writeFileSync(join(kit, 'package.json'), '{}');
    symlinkSync(zod, join(kit, 'node_modules', 'zod'));
    const plugin = join(repo, 'plugins', 'probe');
    mkdirSync(join(plugin, 'node_modules', '@orbit'), { recursive: true });
    symlinkSync(kit, join(plugin, 'node_modules', '@orbit', 'plugin-kit'));
    symlinkSync(zod, join(plugin, 'node_modules', 'zod'));
    // A link to a folder that is neither a store nor a package is not followed.
    const docs = join(root, 'Documents');
    mkdirSync(docs);
    symlinkSync(docs, join(plugin, 'node_modules', 'docs'));
    expect(moduleRoots(plugin).sort()).toEqual([join(repo, 'node_modules'), kit].sort());
  });

  it("names a repository's git directory; only objects, refs, logs and the Bot's entry are writable", () => {
    const repo = join(root, 'owner-repo');
    const common = join(repo, '.git');
    for (const d of ['hooks', 'objects', 'refs', 'modules/sub']) {
      mkdirSync(join(common, d), { recursive: true });
    }
    writeFileSync(join(common, 'config'), '[core]\n');
    expect(gitBind(repo, 'read')).toEqual({
      dir: common,
      access: 'read',
      writable: [],
      protect: [],
    });
    expect(existsSync(join(common, 'logs'))).toBe(false);
    // The Bot's worktree entry is found by its gitdir back-pointer, not by the workspace's .git.
    const ws = join(root, 'bot-ws');
    mkdirSync(ws);
    writeFileSync(join(ws, '.git'), `gitdir: ${join(common, 'worktrees', 'decoy')}\n`);
    for (const [name, tree] of [
      ['decoy', join(root, 'elsewhere')],
      ['bot', ws],
    ] as const) {
      mkdirSync(join(common, 'worktrees', name), { recursive: true });
      writeFileSync(join(common, 'worktrees', name, 'gitdir'), `${join(tree, '.git')}\n`);
      writeFileSync(join(common, 'worktrees', name, 'commondir'), '../..\n');
    }
    const entry = join(common, 'worktrees', 'bot');
    expect(gitBind(repo, 'write', ws)).toEqual({
      dir: common,
      access: 'write',
      writable: [join(common, 'objects'), join(common, 'refs'), join(common, 'logs'), entry],
      protect: [join(entry, 'commondir'), join(entry, 'gitdir'), join(entry, 'config.worktree')],
    });
    // logs and an empty config.worktree are created so they can be bound.
    expect(existsSync(join(common, 'logs'))).toBe(true);
    expect(readFileSync(join(entry, 'config.worktree'), 'utf8')).toBe('');
    // A repository that is itself a linked worktree: its common dir, and the .git file read-only.
    const linked = join(root, 'linked');
    mkdirSync(join(repo, '.git', 'worktrees', 'linked'), { recursive: true });
    writeFileSync(join(repo, '.git', 'worktrees', 'linked', 'commondir'), '../..\n');
    mkdirSync(linked);
    writeFileSync(join(linked, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'linked')}\n`);
    expect(gitBind(linked, 'read')).toMatchObject({
      dir: join(repo, '.git'),
      access: 'read',
      dotGit: join(linked, '.git'),
    });
    expect(gitBind(join(root, 'nothing'), 'read')).toBeNull();
  });
});

describe('prepareSandboxedCommand', () => {
  const req = (over: Partial<Parameters<typeof prepareSandboxedCommand>[1]> = {}) => ({
    manifest: manifest(),
    dir: '/opt/plugins/probe',
    command: { command: process.execPath, args: ['/opt/plugins/probe/server.mjs'] },
    settings: {},
    env: {},
    home: '/home/owner',
    orbitHome: '/home/owner/.orbit',
    denied: ['/home/owner/.ssh', '/home/owner/.orbit'],
    workspace: '/home/owner/.orbit/workspaces/bot_1',
    paths: { node: process.execPath, tsx: 'tsx' },
    platform: 'linux' as const,
    ...over,
  });

  it('leaves the command alone when off, or in auto mode without a sandbox', () => {
    const cmd = req().command;
    expect(prepareSandboxedCommand({ mode: 'off', support: () => BWRAP }, req())).toEqual(cmd);
    expect(prepareSandboxedCommand({ mode: 'auto', support: () => NONE }, req())).toEqual(cmd);
  });

  it('refuses in required mode, saying why', () => {
    expect(() => prepareSandboxedCommand({ mode: 'required', support: () => NONE }, req())).toThrow(
      /Probe cannot be sandboxed here: bubblewrap \(bwrap\) is not installed/,
    );
  });

  it('wraps in bwrap: no workspace or network unless declared', () => {
    const w = prepareSandboxedCommand({ mode: 'auto', support: () => BWRAP }, req());
    expect(w.command).toBe('/usr/bin/bwrap');
    expect(w.args).not.toContain('--share-net');
    expect(w.args).not.toContain('/home/owner/.orbit/workspaces/bot_1');
    expect(w.args.slice(w.args.indexOf('--') + 1)).toEqual([
      process.execPath,
      '/opt/plugins/probe/server.mjs',
    ]);
    expect(w.envPaths).toBeUndefined();
    const ws = prepareSandboxedCommand(
      { mode: 'auto', support: () => BWRAP },
      req({ manifest: manifest({ sandbox: { workspace: 'read', network: true } }) }),
    );
    expect(ws.args).toContain('--share-net');
    expect(ws.args).toContain('/home/owner/.orbit/workspaces/bot_1');
  });

  it("binds Node's install prefix only when it is one; a lone binary (~/.local/bin/node) alone", () => {
    const root = mkdtempSync(join(tmpdir(), 'orbit-node-prefix-'));
    try {
      const lone = join(root, 'home', '.local', 'bin', 'node');
      mkdirSync(dirname(lone), { recursive: true });
      mkdirSync(join(root, 'home', '.local', 'share', 'keyrings'), { recursive: true });
      writeFileSync(lone, '');
      const roBinds = (node: string) => {
        const w = prepareSandboxedCommand(
          { mode: 'auto', support: () => BWRAP },
          req({ paths: { node, tsx: 'tsx' } }),
        );
        return w.args.flatMap((a, i) => (a === '--ro-bind' ? [w.args[i + 1] ?? ''] : []));
      };
      const loneBinds = roBinds(lone);
      expect(loneBinds).toContain(lone);
      expect(loneBinds).not.toContain(join(root, 'home', '.local'));
      expect(loneBinds).not.toContain(join(root, 'home', '.local', 'bin'));

      // nvm, Volta, Homebrew, the official tarball: bin/node beside lib/node_modules or include/node.
      const prefix = join(root, 'nvm', 'versions', 'node', 'v22.22.0');
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
      writeFileSync(join(prefix, 'bin', 'node'), '');
      expect(roBinds(join(prefix, 'bin', 'node'))).toContain(prefix);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('registry: plugins.sandbox required', () => {
  let root: string;
  let db: OrbitDb;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'orbit-sbreg-'));
    db = openDatabase(':memory:');
  });
  afterAll(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a plugin that cannot be sandboxed shows why, does not enable and is not offered', async () => {
    const vault = await SecretVault.open({ db, home: join(root, 'home'), keySource: 'file' });
    const dir = join(root, 'probe');
    mkdirSync(dir);
    writeFileSync(join(dir, 'orbit-plugin.json'), JSON.stringify(manifest()));
    writeFileSync(join(dir, 'server.mjs'), '');
    const registry = new PluginRegistry({
      db,
      vault,
      env: { PATH: process.env.PATH ?? '' },
      home: join(root, 'home'),
      builtInDir: null,
      bots: () => [],
      sandbox: { mode: 'required', support: () => NONE },
    });
    registry.install(dir, 'owner');
    const s = registry.get('probe');
    expect(s.sandbox).toMatchObject({ state: 'refused', reason: NONE.reason });
    expect(s.warnings).toContain('It does not start: bubblewrap (bwrap) is not installed.');
    await expect(registry.enable('probe', 'owner')).rejects.toThrow(
      /did not start: Probe cannot be sandboxed here/,
    );
    expect(registry.ready('probe')).toEqual({ reason: 'plugin probe is not enabled' });
  });
});

// ── real sandboxes (bwrap on Linux; CI installs bubblewrap) ───────────────────

const support = detectPluginSandbox({ env: buildChildEnv('tool', process.env) });
const realSandbox = support.available && support.engine === 'bwrap';
if (!realSandbox) {
  console.warn(`[sandbox.test] real-sandbox tests skipped: ${support.reason ?? 'not Linux'}`);
}

/** Playwright's Chromium is installed (CI's e2e job, a developer machine). */
const chromiumInstalled = (() => {
  const dir =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright');
  try {
    return readdirSync(dir).some((n) => n.startsWith('chromium'));
  } catch {
    return false;
  }
})();

/** An MCP server whose one tool runs a probe: read, write, list or connect. */
const PROBE = `
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect } from 'node:net';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const reply = (id, text) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'run_probe', description: '', inputSchema: { type: 'object' } }] } });
  const a = m.params.arguments;
  try {
    if (a.op === 'read') return reply(m.id, 'read:' + readFileSync(a.path, 'utf8'));
    if (a.op === 'write') { writeFileSync(a.path, 'x'); return reply(m.id, 'wrote'); }
    if (a.op === 'mkwrite') { mkdirSync(dirname(a.path), { recursive: true }); writeFileSync(a.path, 'x'); return reply(m.id, 'wrote'); }
    if (a.op === 'list') return reply(m.id, 'list:' + readdirSync(a.path).join(','));
    if (a.op === 'env') return reply(m.id, JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, cwd: process.cwd() }));
    if (a.op === 'connect') {
      const s = connect(a.port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); reply(m.id, 'connected'); });
      s.on('error', (e) => reply(m.id, 'error:' + e.code));
      return;
    }
  } catch (e) { return reply(m.id, 'error:' + e.code); }
});
`;

describe.skipIf(!realSandbox)('a plugin in a real bwrap sandbox', () => {
  let root: string;
  let pluginDir: string;
  let orbitHome: string;
  let homeSecret: string;
  let server: Server;
  let port: number;
  const clients: StdioMcpClient[] = [];

  beforeAll(async () => {
    // Outside /tmp, which the sandbox replaces anyway: the masks must do the work.
    root = mkdtempSync(join(resolve(import.meta.dirname, '../..'), '.sandbox-test-'));
    pluginDir = join(root, 'plugin');
    mkdirSync(pluginDir);
    writeFileSync(join(pluginDir, 'server.mjs'), PROBE);
    writeFileSync(join(pluginDir, 'secret-in-plugin.txt'), 'masked');
    orbitHome = join(root, 'orbit-home');
    mkdirSync(join(orbitHome, 'workspaces', 'bot_1'), { recursive: true });
    writeFileSync(join(orbitHome, 'orbit.db'), 'database');
    homeSecret = join(homedir(), `.orbit-sandbox-test-${process.pid}`);
    writeFileSync(homeSecret, 'owner secret');
    server = createServer((s) => s.end());
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    server.close();
    rmSync(homeSecret, { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const start = (
    m: PluginManifest,
    opts: {
      denied?: string[];
      home?: string;
      workspace?: string;
      git?: { repo: string; branch: string };
    } = {},
  ) => {
    const command = { command: process.execPath, args: [join(pluginDir, 'server.mjs')] };
    const workspace = opts.workspace ?? join(orbitHome, 'workspaces', 'bot_1');
    const cmd = prepareSandboxedCommand(
      { mode: 'required', support: () => support },
      {
        manifest: m,
        dir: pluginDir,
        command,
        settings: {},
        env: process.env,
        home: opts.home ?? homedir(),
        orbitHome,
        denied: [orbitHome, ...(opts.denied ?? [])],
        workspace,
        git: opts.git,
        paths: { node: process.execPath, tsx: 'tsx' },
      },
    );
    expect(cmd.command).toBe(support.path);
    const client = new StdioMcpClient({
      command: cmd.command,
      args: cmd.args,
      cwd: workspace,
      env: buildPluginEnv({
        manifest: m,
        source: { PATH: process.env.PATH ?? '', HOME: homedir() },
        settings: {},
        secret: () => undefined,
        workspace,
      }),
    });
    clients.push(client);
    return async (args: Record<string, unknown>) => (await client.callTool('run_probe', args)).text;
  };

  it("cannot read the owner's home or $ORBIT_HOME; HOME is an empty private folder", async () => {
    const probe = start(manifest());
    expect(await probe({ op: 'read', path: homeSecret })).toBe('error:ENOENT');
    // Only the directories leading to what is bound (the plugin, Node, this
    // checkout's package store) appear, as empty mount points; CI checks out
    // under $HOME (/home/runner/work/…).
    const leading = new Set(
      [pluginDir, process.execPath, process.cwd()]
        .map((p) => relative(homedir(), p))
        .filter((r) => r !== '' && !r.startsWith('..') && !isAbsolute(r))
        .map((r) => r.split(sep)[0]),
    );
    const listed = (await probe({ op: 'list', path: homedir() })).replace(/^list:/, '');
    for (const entry of listed === '' ? [] : listed.split(',')) {
      expect(leading.has(entry), `${entry} in the sandbox's HOME`).toBe(true);
    }
    expect(await probe({ op: 'read', path: join(orbitHome, 'orbit.db') })).toBe('error:ENOENT');
    expect(JSON.parse(await probe({ op: 'env' }))).toEqual({
      home: homedir(),
      tmp: '/tmp',
      cwd: homedir(),
    });
    // Its own folder is readable; a denied file inside it is masked.
    const masked = start(manifest(), { denied: [join(pluginDir, 'secret-in-plugin.txt')] });
    expect(await masked({ op: 'read', path: join(pluginDir, 'server.mjs') })).toMatch(/^read:/);
    // A masked file (bound over by /dev/null on a nodev mount) gives nothing back.
    expect(await masked({ op: 'read', path: join(pluginDir, 'secret-in-plugin.txt') })).toMatch(
      /^(read:|error:EACCES)$/,
    );
  });

  it('cannot write outside its binds; writes to the workspace only when declared', async () => {
    const ws = join(orbitHome, 'workspaces', 'bot_1');
    const none = start(manifest());
    expect(await none({ op: 'write', path: join(pluginDir, 'planted.js') })).toBe('error:EROFS');
    expect(await none({ op: 'write', path: join(ws, 'a.txt') })).toMatch(
      /^error:(ENOENT|EROFS|EACCES)$/,
    );
    // Its /tmp is private: nothing reaches the host's.
    const tmpName = `/tmp/orbit-sandbox-${process.pid}.txt`;
    expect(await none({ op: 'write', path: tmpName })).toBe('wrote');
    expect(existsSync(tmpName)).toBe(false);

    const read = start(manifest({ sandbox: { workspace: 'read' } }));
    expect(await read({ op: 'write', path: join(ws, 'b.txt') })).toBe('error:EROFS');
    expect(await read({ op: 'read', path: join(orbitHome, 'orbit.db') })).toBe('error:ENOENT');
    const write = start(manifest({ sandbox: { workspace: 'write' } }));
    expect(await write({ op: 'write', path: join(ws, 'c.txt') })).toBe('wrote');
    expect(readFileSync(join(ws, 'c.txt'), 'utf8')).toBe('x');
  });

  it('works when the plugin and $ORBIT_HOME live inside the home (a checkout under ~)', async () => {
    // `root` plays the owner's home: it holds the plugin, $ORBIT_HOME and a private file.
    writeFileSync(join(root, 'diary.txt'), 'private');
    const probe = start(manifest({ sandbox: { workspace: 'read' } }), { home: root });
    expect(await probe({ op: 'read', path: join(pluginDir, 'server.mjs') })).toMatch(/^read:/);
    expect(await probe({ op: 'read', path: join(root, 'diary.txt') })).toBe('error:ENOENT');
    expect(await probe({ op: 'read', path: join(orbitHome, 'orbit.db') })).toBe('error:ENOENT');
    expect(await probe({ op: 'list', path: join(orbitHome, 'workspaces') })).toBe('list:bot_1');
  });

  it("cannot plant git hooks, config or pointers for the owner's own git (worktree Bot)", async () => {
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Owner',
      GIT_AUTHOR_EMAIL: 'owner@example.test',
      GIT_COMMITTER_NAME: 'Owner',
      GIT_COMMITTER_EMAIL: 'owner@example.test',
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
    const repo = join(root, 'owner-repo');
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const ws = join(orbitHome, 'workspaces', 'bot_2');
    git(repo, 'worktree', 'add', '-q', '-b', 'orbit/bot_2', ws);
    git(repo, 'worktree', 'add', '-q', '-b', 'other', join(root, 'other'));
    const common = join(repo, '.git');
    // A submodule's git directory, and no hooks or info folder at all.
    mkdirSync(join(common, 'modules', 'sub', 'hooks'), { recursive: true });
    writeFileSync(join(common, 'modules', 'sub', 'config'), '[core]\n');
    rmSync(join(common, 'hooks'), { recursive: true, force: true });
    rmSync(join(common, 'info'), { recursive: true, force: true });

    const probe = start(manifest({ sandbox: { workspace: 'write' } }), {
      workspace: ws,
      git: { repo, branch: 'orbit/bot_2' },
    });
    const refused = [
      join(common, 'hooks', 'post-checkout'),
      join(common, 'info', 'attributes'),
      join(common, 'config'),
      join(common, 'config.worktree'),
      join(common, 'commondir'),
      join(common, 'packed-refs'),
      join(common, 'modules', 'sub', 'hooks', 'x'),
      join(common, 'modules', 'sub', 'config'),
      join(common, 'modules', 'other', 'config'),
      join(common, 'worktrees', 'other', 'config.worktree'),
      join(common, 'worktrees', 'other', 'commondir'),
      join(common, 'worktrees', 'bot_2', 'config.worktree'),
      join(common, 'worktrees', 'bot_2', 'commondir'),
      join(common, 'worktrees', 'bot_2', 'gitdir'),
    ];
    for (const path of refused) {
      expect(await probe({ op: 'mkwrite', path }), path).toMatch(
        /^error:(EROFS|EACCES|EPERM|ENOENT)$/,
      );
    }
    for (const path of refused) {
      // Nothing reached the host (bwrap may leave an empty mount point behind).
      expect(existsSync(path) && readFileSync(path, 'utf8') === 'x', path).toBe(false);
    }
    expect(existsSync(join(common, 'hooks', 'post-checkout'))).toBe(false);
    expect(existsSync(join(common, 'commondir'))).toBe(false);
    // What a commit needs stays writable: objects, refs, logs and the Bot's own worktree entry.
    for (const path of [
      join(common, 'objects', 'probe'),
      join(common, 'refs', 'heads', 'orbit', 'probe'),
      join(common, 'logs', 'probe'),
      join(common, 'worktrees', 'bot_2', 'probe'),
      join(ws, 'probe.txt'),
    ]) {
      expect(await probe({ op: 'mkwrite', path }), path).toBe('wrote');
    }
  });

  it('has no network unless a tool needs it', async () => {
    const offline = start(manifest());
    expect(await offline({ op: 'connect', port })).toBe('error:ECONNREFUSED');
    const online = start(manifest({ sandbox: { network: true } }));
    expect(await online({ op: 'connect', port })).toBe('connected');
  });
});

describe.skipIf(!realSandbox)('a reference plugin in a real bwrap sandbox', () => {
  let root: string;
  let db: OrbitDb;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'orbit-sbref-'));
    db = openDatabase(':memory:');
  });
  afterAll(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('the Filesystem plugin (tsx, pnpm links) reads its folder and nothing of the home', async () => {
    const vault = await SecretVault.open({ db, home: join(root, 'orbit'), keySource: 'file' });
    const marker = `orbit-sandbox-marker-${process.pid}.md`;
    writeFileSync(join(homedir(), marker), 'owner file');
    const notes = join(root, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'todo.md'), '- ship M8');
    const registry = new PluginRegistry({
      db,
      vault,
      env: { PATH: process.env.PATH ?? '', HOME: homedir() },
      home: join(root, 'orbit'),
      bots: () => [],
      sandbox: { mode: 'required', support: () => support },
      paths: defaultPluginPaths(),
    });
    registry.setSetting('filesystem', 'FS_ROOTS', `${notes}:${homedir()}`, 'owner');
    const status = await registry.enable('filesystem', 'owner');
    expect(status).toMatchObject({
      state: 'ready',
      sandbox: { state: 'sandboxed', engine: 'bwrap' },
    });
    expect(status.warnings.join('\n')).toMatch(/FS_ROOTS: .* stays out of its sandbox/);
    const ready = registry.ready('filesystem');
    if ('reason' in ready) throw new Error(ready.reason);
    const client = registry.client({
      manifest: ready.manifest,
      dir: ready.dir,
      cwd: root,
      workspace: null,
    });
    try {
      expect((await client.callTool('read_file', { path: join(notes, 'todo.md') })).text).toBe(
        '- ship M8',
      );
      // The home it was given is the sandbox's empty one: the owner's files are not there.
      const home = await client.callTool('list_directory', { path: homedir() });
      expect(home.text).not.toContain(marker);
      expect((await client.callTool('read_file', { path: join(homedir(), marker) })).isError).toBe(
        true,
      );
    } finally {
      await client.close();
      rmSync(join(homedir(), marker), { force: true });
    }
  });

  it.skipIf(!chromiumInstalled)(
    'the Browser plugin runs Chromium (with its own sandbox unless root) inside bwrap',
    async () => {
      const vault = await SecretVault.open({ db, home: join(root, 'orbit3'), keySource: 'file' });
      const site = createHttpServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<title>Sandboxed</title><body>hello from the host</body>');
      });
      await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
      const sitePort = (site.address() as { port: number }).port;
      const registry = new PluginRegistry({
        db,
        vault,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: homedir(),
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH
            ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
            : {}),
        },
        home: join(root, 'orbit3'),
        bots: () => [],
        sandbox: { mode: 'required', support: () => support },
        paths: defaultPluginPaths(),
      });
      registry.setSetting('browser', 'BROWSER_ALLOWED_DOMAINS', '127.0.0.1', 'owner');
      await registry.enable('browser', 'owner');
      const ready = registry.ready('browser');
      if ('reason' in ready) throw new Error(ready.reason);
      const client = registry.client({
        manifest: ready.manifest,
        dir: ready.dir,
        cwd: root,
        workspace: null,
      });
      try {
        const r = await client.callTool('open_page', { url: `http://127.0.0.1:${sitePort}/` });
        expect(r.text).toContain('hello from the host');
      } finally {
        await client.close();
        site.close();
      }
    },
    60_000,
  );

  it("the GitHub plugin commits on a worktree Bot's branch through the bound git directory", async () => {
    const vault = await SecretVault.open({ db, home: join(root, 'orbit2'), keySource: 'file' });
    const base = join(root, 'gh');
    mkdirSync(base);
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: join(base, 'owner-home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Owner',
      GIT_AUTHOR_EMAIL: 'owner@example.test',
      GIT_COMMITTER_NAME: 'Owner',
      GIT_COMMITTER_EMAIL: 'owner@example.test',
    };
    mkdirSync(env.HOME);
    const run = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
    const repo = join(base, 'repo');
    run(base, 'init', '-q', '-b', 'main', repo);
    writeFileSync(join(repo, 'README.md'), '# r\n');
    run(repo, 'add', '-A');
    run(repo, 'commit', '-q', '-m', 'init');
    const ws = join(root, 'orbit2', 'workspaces', 'bot_1');
    mkdirSync(join(root, 'orbit2', 'workspaces'), { recursive: true });
    run(repo, 'worktree', 'add', '-q', '-b', 'orbit/bot_1', ws);
    writeFileSync(join(ws, 'notes.md'), 'from the Bot\n');
    const registry = new PluginRegistry({
      db,
      vault,
      env: { PATH: env.PATH, HOME: env.HOME },
      home: join(root, 'orbit2'),
      bots: () => [],
      sandbox: { mode: 'required', support: () => support },
      paths: defaultPluginPaths(),
    });
    await registry.enable('github', 'owner');
    const ready = registry.ready('github');
    if ('reason' in ready) throw new Error(ready.reason);
    const client = registry.client({
      manifest: ready.manifest,
      dir: ready.dir,
      cwd: ws,
      workspace: ws,
      git: { repo, branch: 'orbit/bot_1' },
    });
    try {
      const r = await client.callTool('git_commit', { message: 'Add notes' });
      expect(r).toMatchObject({ isError: false });
      expect(run(repo, 'log', '-1', '--format=%s', 'orbit/bot_1')).toBe('Add notes');
    } finally {
      await client.close();
    }
  });
});
