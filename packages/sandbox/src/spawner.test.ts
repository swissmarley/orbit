import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FULL_SUPPORT, fakeRunner } from '../test/helpers';
import { SandboxManager } from './manager';
import type { SpawnOptions, Workspace } from './types';

interface SpawnCall {
  file: string;
  args: string[];
  opts: { env: Record<string, string>; stdio: string[] };
}
const spawnCalls: SpawnCall[] = [];

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: string[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    this.killed = true;
    return true;
  }
}
const children: FakeChild[] = [];
const engineChild = () => children[0]!;

vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], opts: SpawnCall['opts']) => {
    spawnCalls.push({ file, args, opts });
    const child = new FakeChild();
    children.push(child);
    return child;
  },
}));

const ws: Workspace = {
  botId: 'bot_1',
  kind: 'docker',
  path: '/orbit/workspaces/bot',
  isolation: 'container',
  shellContained: true,
  engineSandboxSettings: null,
  docker: { container: 'orbit-bot-bot', workdir: '/workspace' },
};

const SECRET = 'sk-ant-api03-SECRETVALUE';
const engineEnv = {
  PATH: '/host/bin',
  HOME: '/home/alice',
  ANTHROPIC_API_KEY: SECRET,
  LANG: 'C.UTF-8',
  NODE_EXTRA_CA_CERTS: '/host/ca.pem',
  XDG_CONFIG_HOME: '/home/alice/.config',
  DOCKER_HOST: 'tcp://evil:2375',
};

const manager = () =>
  new SandboxManager({
    orbitHome: '/orbit',
    run: fakeRunner(),
    support: FULL_SUPPORT,
    dockerClientEnv: { PATH: '/usr/bin', HOME: '/home/alice' },
  });

const options = (over: Partial<SpawnOptions> = {}): SpawnOptions => ({
  command: 'claude',
  args: ['--output-format', 'stream-json', '--verbose'],
  cwd: '/host/cwd',
  env: {
    ...engineEnv,
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDE_AGENT_SDK_VERSION: '0.3.289',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-should-never-pass',
    SOME_UNRELATED_HOST_VAR: 'leak',
  },
  signal: new AbortController().signal,
  ...over,
});

beforeEach(() => {
  spawnCalls.length = 0;
  children.length = 0;
});

const PID_FILE = /^\/tmp\/orbit-engine-[0-9a-f-]{36}\.pid$/;

describe('SandboxManager.engineSpawner', () => {
  it('runs docker exec with variable names only; values travel in the client env', () => {
    manager().engineSpawner(ws, engineEnv)(options());
    expect(spawnCalls).toHaveLength(1);
    const { file, args, opts } = spawnCalls[0]!;
    expect(file).toBe('docker');
    expect(args).toEqual([
      'exec',
      '-i',
      '-w',
      '/workspace',
      '-e',
      'ANTHROPIC_API_KEY',
      '-e',
      'CLAUDE_AGENT_SDK_VERSION',
      '-e',
      'CLAUDE_CODE_ENTRYPOINT',
      '-e',
      'LANG',
      'orbit-bot-bot',
      'sh',
      '-c',
      'echo $$ > "$0" && exec "$@"',
      expect.stringMatching(PID_FILE),
      'claude',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(args.join(' ')).not.toContain(SECRET);
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(opts.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/alice',
      ANTHROPIC_API_KEY: SECRET,
      CLAUDE_AGENT_SDK_VERSION: '0.3.289',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      LANG: 'C.UTF-8',
    });
  });

  it('never forwards OAuth tokens, host paths or DOCKER_* steering variables', () => {
    manager().engineSpawner(ws, { ...engineEnv, CLAUDE_CODE_OAUTH_TOKEN: 'x' })(options());
    const { args, opts } = spawnCalls[0]!;
    for (const name of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'PATH',
      'HOME',
      'NODE_EXTRA_CA_CERTS',
      'XDG_CONFIG_HOME',
      'DOCKER_HOST',
      'SOME_UNRELATED_HOST_VAR',
    ]) {
      expect(args).not.toContain(name);
    }
    expect(opts.env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
    expect(Object.values(opts.env)).not.toContain('tcp://evil:2375');
    expect(Object.values(opts.env)).not.toContain('oauth-should-never-pass');
  });

  it('kills the docker exec client when the SDK aborts', () => {
    const ac = new AbortController();
    manager().engineSpawner(ws, engineEnv)(options({ signal: ac.signal }));
    const child = engineChild();
    expect(child.kills).toEqual([]);
    ac.abort();
    expect(child.kills).toEqual(['SIGTERM']);
    // docker exec does not forward signals, so the engine is signalled in place.
    const pidFile = spawnCalls[0]!.args[spawnCalls[0]!.args.indexOf('-c') + 2]!;
    expect(spawnCalls[1]!.args).toEqual([
      'exec',
      'orbit-bot-bot',
      'sh',
      '-c',
      `kill -s TERM "$(cat ${pidFile})" 2>/dev/null; rm -f ${pidFile}`,
    ]);
    expect(spawnCalls[1]!.opts.env).toEqual({ PATH: '/usr/bin', HOME: '/home/alice' });
  });

  it('kill() also signals the engine inside the container, but not after it exited', () => {
    manager().engineSpawner(ws, engineEnv)(options());
    const child = engineChild();
    child.kill('SIGKILL');
    expect(child.kills).toEqual(['SIGKILL']);
    expect(spawnCalls[1]!.args[4]).toMatch(/^kill -s KILL /);

    spawnCalls.length = 0;
    children.length = 0;
    manager().engineSpawner(ws, engineEnv)(options());
    engineChild().exitCode = 0;
    engineChild().emit('exit', 0, null);
    engineChild().kill('SIGTERM');
    // Only the pidfile cleanup after a normal exit, no in-container kill.
    expect(spawnCalls.slice(1).map((c) => c.args[4])).toEqual([
      expect.stringMatching(/^rm -f \/tmp\/orbit-engine-/),
    ]);
  });

  it('kills immediately when the signal is already aborted', () => {
    const ac = new AbortController();
    ac.abort();
    manager().engineSpawner(ws, engineEnv)(options({ signal: ac.signal }));
    expect(engineChild().kills).toEqual(['SIGTERM']);
  });

  it('streams stderr to onStderr', () => {
    const seen: string[] = [];
    manager().engineSpawner(ws, engineEnv, { onStderr: (c) => seen.push(c) })(options());
    engineChild().stderr.write('engine warning');
    expect(seen.join('')).toBe('engine warning');
  });

  it('refuses non-docker workspaces', () => {
    expect(() =>
      manager().engineSpawner({ ...ws, kind: 'directory', docker: null }, engineEnv),
    ).toThrow(/not a docker workspace/);
  });
});
