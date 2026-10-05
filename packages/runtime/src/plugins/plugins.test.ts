import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Bot, BotSpec, pluginSecretKey } from '@orbit/core';
import { SecretVault } from '@orbit/policy';
import { type OrbitDb, openDatabase } from '@orbit/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrbitSessions } from '../orbit-tools/session';
import { PluginSegments } from './host';
import { buildPluginEnv, loadManifest } from './manifest';
import { PluginRegistry } from './registry';

const matching = (re: RegExp) => expect.stringMatching(re) as unknown as string;

/** A tiny MCP server: `env_names` reports its environment's names, `echo` echoes. */
const SERVER = `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'env_names', description: 'Env', inputSchema: { type: 'object' } },
    { name: 'send_message', description: 'Send', inputSchema: { type: 'object' } },
    { name: 'secret_tool', description: 'Not declared', inputSchema: { type: 'object' } },
  ] } });
  if (m.method === 'tools/call') {
    const text = m.params.name === 'env_names'
      ? Object.keys(process.env).sort().join(',') + ' cwd=' + process.cwd() + ' token=' + (process.env.FAKE_TOKEN ?? '')
      : 'echo: ' + (m.params.arguments.text ?? '');
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }], isError: false } });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
});
`;

function writePlugin(dir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'server.mjs'), SERVER);
  writeFileSync(
    join(dir, 'orbit-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'fake',
      name: 'Fake',
      version: '1.0.0',
      server: { transport: 'stdio', command: '${node}', args: ['${pluginDir}/server.mjs'] },
      tools: [
        { name: 'echo', tier: 'READ' },
        { name: 'env_names', tier: 'READ' },
        // Declared lower than its name says: Orbit raises it.
        { name: 'send_message', tier: 'WRITE_LOCAL' },
      ],
      secrets: [{ name: 'FAKE_TOKEN' }],
      env: ['FAKE_API_URL'],
      ...overrides,
    }),
  );
}

let root: string;
let db: OrbitDb;
let vault: SecretVault;
let bots: Bot[];
let registry: PluginRegistry;
const pluginDir = () => join(root, 'fake-plugin');

const ENV = {
  PATH: process.env.PATH ?? '',
  HOME: '/home/owner',
  ANTHROPIC_API_KEY: 'sk-ant-api03-secret-api-key',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value',
  ANTHROPIC_AUTH_TOKEN: 'auth-token-value',
  ORBIT_HOOK_TOKEN: 'hook-token-value',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  FAKE_API_URL: 'http://127.0.0.1:9/api',
  UNRELATED: 'not-for-plugins',
};

function bot(plugins: string[]): Bot {
  return {
    id: 'bot_1',
    version: 1,
    spec: BotSpec.parse({ name: 'B', goal: 'g', plugins }),
    pausedAt: null,
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orbit-plugins-'));
  db = openDatabase(':memory:');
  vault = await SecretVault.open({ db, home: join(root, 'home'), keySource: 'file' });
  bots = [];
  writePlugin(pluginDir());
  registry = new PluginRegistry({
    db,
    vault,
    env: ENV,
    home: join(root, 'home'),
    builtInDir: null,
    bots: () => bots,
  });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('PluginRegistry', () => {
  it('knows the reference plugins, all disabled until the owner enables them', () => {
    const builtIn = new PluginRegistry({
      db,
      vault,
      env: ENV,
      home: join(root, 'home'),
      bots: () => [],
    });
    const list = builtIn.list();
    expect(list.map((p) => p.id)).toContain('filesystem');
    for (const p of list) {
      expect(p.state).toBe('disabled');
      expect(p.error).toBeNull();
    }
  });

  it('adds, sets up, checks and enables a plugin; undeclared tools stay hidden', async () => {
    registry.install(pluginDir(), 'owner');
    let s = registry.get('fake');
    expect(s).toMatchObject({ state: 'disabled', builtIn: false, enabled: false });
    expect(s.secrets).toEqual([
      expect.objectContaining({
        name: 'FAKE_TOKEN',
        set: false,
        vaultName: 'plugin_fake_FAKE_TOKEN',
      }),
    ]);
    await expect(registry.enable('fake', 'owner')).rejects.toThrow(/needs secret FAKE_TOKEN/);
    registry.setSecret('fake', 'FAKE_TOKEN', 'fake-token-1234', 'owner');
    s = await registry.enable('fake', 'owner');
    expect(s.state).toBe('ready');
    expect(s.undeclaredTools).toEqual(['secret_tool']);
    expect(s.tools.map((t) => [t.name, t.tier, t.available])).toEqual([
      ['echo', 'READ', true],
      ['env_names', 'READ', true],
      ['send_message', 'EXTERNAL', true],
    ]);
    expect(s.warnings.join(' ')).toMatch(/send_message is declared WRITE_LOCAL.*EXTERNAL/);
    const ready = registry.ready('fake');
    expect('tools' in ready && ready.tools.map((t) => t.name)).toEqual([
      'echo',
      'env_names',
      'send_message',
    ]);
  });

  it('holds back a plugin whose manifest changed after it was enabled', async () => {
    registry.install(pluginDir(), 'owner');
    registry.setSecret('fake', 'FAKE_TOKEN', 'fake-token-1234', 'owner');
    await registry.enable('fake', 'owner');
    writePlugin(pluginDir(), { version: '1.0.1' });
    expect(registry.get('fake').state).toBe('changed');
    expect(registry.ready('fake')).toEqual({ reason: 'plugin fake changed since it was enabled' });
    await registry.enable('fake', 'owner');
    expect(registry.get('fake').state).toBe('ready');
  });

  it('gives tier overrides with exact names only, raised to the name floor', () => {
    registry.install(pluginDir(), 'owner');
    expect(registry.toolTiers()).toEqual([
      { pattern: 'mcp__fake__echo', tier: 'READ', untrusted: true },
      { pattern: 'mcp__fake__env_names', tier: 'READ', untrusted: true },
      { pattern: 'mcp__fake__send_message', tier: 'EXTERNAL', untrusted: true },
    ]);
  });

  it('refuses secrets and settings the manifest does not declare', () => {
    registry.install(pluginDir(), 'owner');
    expect(() => registry.setSecret('fake', 'OTHER', 'value-1234', 'owner')).toThrow(
      /declares no secret/,
    );
    expect(() => registry.setSetting('fake', 'FAKE_TOKEN', 'x', 'owner')).toThrow(/no setting/);
  });
});

describe('plugin environment (ADR-014)', () => {
  it('is built from the allowlist: no API key, OAuth, hook token or unrelated variables', () => {
    vault.set(pluginSecretKey('fake', 'FAKE_TOKEN'), 'fake-token-1234');
    vault.set(pluginSecretKey('other', 'FAKE_TOKEN'), 'other-plugin-secret');
    vault.set('FAKE_TOKEN', 'the-owners-own-secret');
    const env = buildPluginEnv({
      manifest: loadManifest(pluginDir()).manifest,
      source: ENV,
      settings: {},
      secret: (n) => vault.get(n),
      workspace: '/ws',
      git: { repo: '/src/widgets', branch: 'orbit/bot_1' },
      deniedPaths: ['/home/owner/.ssh', '/orbit-home'],
    });
    expect(env).toMatchObject({
      PATH: ENV.PATH,
      HOME: '/home/owner',
      FAKE_API_URL: ENV.FAKE_API_URL,
      FAKE_TOKEN: 'fake-token-1234',
      ORBIT_WORKSPACE: '/ws',
      // Orbit's own context for worktree git and path checks (review H1/H2).
      ORBIT_GIT_REPO: '/src/widgets',
      ORBIT_GIT_BRANCH: 'orbit/bot_1',
      ORBIT_DENIED_PATHS: JSON.stringify(['/home/owner/.ssh', '/orbit-home']),
    });
    for (const k of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'ORBIT_HOOK_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'UNRELATED',
    ]) {
      expect(env[k]).toBeUndefined();
    }
  });

  it("never passes an orbit-scoped secret to the plugin's process (review L6)", () => {
    writePlugin(pluginDir(), {
      secrets: [
        { name: 'FAKE_TOKEN' },
        { name: 'FAKE_APP_TOKEN', required: false, scope: 'orbit' },
      ],
    });
    vault.set(pluginSecretKey('fake', 'FAKE_TOKEN'), 'fake-token-1234');
    vault.set(pluginSecretKey('fake', 'FAKE_APP_TOKEN'), 'xapp-orbit-only-5678');
    const env = buildPluginEnv({
      manifest: loadManifest(pluginDir()).manifest,
      source: ENV,
      settings: {},
      secret: (n) => vault.get(n),
      workspace: null,
    });
    expect(env.FAKE_TOKEN).toBe('fake-token-1234');
    expect(env.FAKE_APP_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain('xapp-orbit-only-5678');
  });

  it('a manifest cannot ask for credentials or loader variables', () => {
    for (const bad of [
      { env: ['ANTHROPIC_API_KEY'] },
      { env: ['CLAUDE_CODE_OAUTH_TOKEN'] },
      { env: ['NODE_OPTIONS'] },
      { env: ['LD_PRELOAD'] },
      { secrets: [{ name: 'ORBIT_HOOK_TOKEN' }] },
      { settings: [{ name: 'AWS_SECRET_ACCESS_KEY' }] },
      { id: 'orbit' },
      { id: 'evil_name' },
      { server: { transport: 'http', url: 'http://example.com/mcp' } },
    ]) {
      writePlugin(pluginDir(), bad);
      expect(() => loadManifest(pluginDir()), JSON.stringify(bad)).toThrow(
        /not a valid plugin manifest/,
      );
    }
  });
});

describe('PluginSegment', () => {
  it('runs a call only after policy authorized exactly that input, in the Bot workspace', async () => {
    registry.install(pluginDir(), 'owner');
    registry.setSecret('fake', 'FAKE_TOKEN', 'fake-token-1234', 'owner');
    await registry.enable('fake', 'owner');
    const sessions = new OrbitSessions();
    const b = bot(['fake', 'missing']);
    const session = sessions.open({
      runId: 'run_1',
      bot: b,
      depth: 0,
      taint: () => [],
      addTaint: () => undefined,
    });
    const workspace = join(root, 'ws');
    mkdirSync(workspace);
    const segments = new PluginSegments();
    const seg = segments.open(registry, b, workspace, session);
    expect(seg.unavailable).toEqual([{ id: 'missing', reason: 'plugin missing is not installed' }]);
    const binding = seg.binding('fake');
    expect(binding?.tools.map((t) => t.name)).toEqual(['echo', 'env_names', 'send_message']);

    // Not announced and allowed: refused without starting anything.
    expect(await binding?.call('echo', { text: 'hi' })).toMatchObject({
      isError: true,
      text: matching(/did not authorize/),
    });
    session.authorize('mcp__fake__echo', { text: 'hi' });
    expect(await binding?.call('echo', { text: 'other' })).toMatchObject({ isError: true });
    expect(await binding?.call('echo', { text: 'hi' })).toEqual({
      text: 'echo: hi',
      isError: false,
    });
    // Once only.
    expect(await binding?.call('echo', { text: 'hi' })).toMatchObject({ isError: true });
    // Undeclared tools are not reachable even when "authorized".
    session.authorize('mcp__fake__secret_tool', {});
    expect(await binding?.call('secret_tool', {})).toMatchObject({ isError: true });

    session.authorize('mcp__fake__env_names', {});
    const env = await binding?.call('env_names', {});
    expect(env?.text).toContain(`cwd=${workspace}`);
    expect(env?.text).toContain('token=fake-token-1234');
    expect(env?.text).not.toMatch(/ANTHROPIC|CLAUDE_CODE_OAUTH|ORBIT_HOOK|UNRELATED|AWS_SECRET/);
    await segments.close(seg, 'run_1');
    expect(await binding?.call('echo', { text: 'hi' })).toMatchObject({ isError: true });
  });
});
