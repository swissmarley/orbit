import { join } from 'node:path';
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FIXTURES_DIR } from '../src/drivers/fixtures';
import { type AuthMethod, OrbitConfig, OrbitError } from '@orbit/core';
import { API_KEY_PLACEHOLDER } from '@orbit/sandbox';
import { resolveAuth } from '../src/auth/resolver';
import { type EngineKeyProxy, type QueryFn, SdkDriver } from '../src/drivers/sdk';
import { type Harness, collect, expectWellFormed, runDriverContract } from './driver-contract';
import { FakeKeyProxy } from './fake-key-proxy';
import { readFixture, replay } from './fake-engine.mjs';

const FIXTURE = (name: string) => join(FIXTURES_DIR, 'claude-2.1.289', `${name}.jsonl`);

const PLANTED = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-REAL-KEY-FOR-SDK-000000',
  ANTHROPIC_AUTH_TOKEN: 'planted-auth-token-000000',
  CLAUDE_CODE_OAUTH_TOKEN: 'planted-oauth-token-000000',
  CLAUDE_CODE_SESSION_ID: 'parent-session-should-not-leak',
  GITHUB_TOKEN: 'ghp_plantedplantedplantedplantedplanted',
};
const sourceEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...PLANTED };

/** Fake Agent SDK query(): replays a fixture and calls the driver's real PreToolUse hook. */
function fakeQuery(
  fixture: string,
  seen: Options[] = [],
  apiKeySource = 'ANTHROPIC_API_KEY',
): QueryFn {
  return async function* ({ options }) {
    seen.push(options);
    const sessionId = options.resume ?? options.sessionId;
    const signal = options.abortController!.signal;
    if (fixture === 'hang') {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId ?? 's-hang',
        tools: [],
        model: 'm',
      } as unknown as SDKMessage;
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new Error('Claude Code process aborted by user')),
        );
      });
      return;
    }
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const decide = (input: Record<string, unknown>) =>
      hook(input as Parameters<HookCallback>[0], input.tool_use_id as string, { signal });
    // An API-key engine reports its credential source in init.
    const messages = readFixture(fixture).map((m) =>
      m.type === 'system' && m.subtype === 'init' ? { ...m, apiKeySource } : m,
    );
    for await (const m of replay(messages, {
      decide,
      sessionId,
      cwd: options.cwd ?? '/',
    })) {
      yield m as unknown as SDKMessage;
    }
  };
}

function driver(
  queryFn: QueryFn,
  bare = true,
  keyProxy: EngineKeyProxy = new FakeKeyProxy(),
  secrets: string[] = [],
): SdkDriver {
  return new SdkDriver({
    authMethod: 'api_key',
    env: sourceEnv,
    bare,
    apiKeyHelper: null,
    keyProxy,
    secrets: { addSecret: (v) => secrets.push(v) },
    queryFn,
    // The host check below has its own tests; the contract runs on any host.
    findBwrap: () => '/usr/bin/bwrap',
  });
}

runDriverContract('SdkDriver', (): Harness => ({
  prepare(scenario) {
    const q = scenario === 'hang' ? fakeQuery('hang') : fakeQuery(FIXTURE(scenario));
    return Promise.resolve({ driver: driver(q), base: {} });
  },
  cleanup: () => Promise.resolve(),
}));

describe('SdkDriver specifics', () => {
  it('never gives the engine the API key: the placeholder and the key proxy with its segment token, no OAuth tokens or unrelated vars', async () => {
    const seen: Options[] = [];
    const proxy = new FakeKeyProxy();
    const secrets: string[] = [];
    const events = await collect(
      driver(fakeQuery(FIXTURE('pong'), seen), true, proxy, secrets),
      {},
    );
    expect(events.at(-1)?.type).toBe('run.completed');
    const o = seen[0]!;
    const env = o.env!;
    const lease = proxy.leases[0]!;
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY_PLACEHOLDER);
    expect(env.ANTHROPIC_BASE_URL).toBe(lease.baseUrl);
    expect(env.NO_PROXY?.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost']));
    // Not in the env, the engine's argv or its settings (the API key helper stays in orbitd).
    expect(JSON.stringify([o.env, o.extraArgs, o.executableArgs, o.settings])).not.toContain(
      PLANTED.ANTHROPIC_API_KEY,
    );
    expect(o.settings).toBeUndefined();
    for (const name of [
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_SESSION_ID',
      'GITHUB_TOKEN',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
    // The segment token is a secret too: the redactor learns it, events never carry it.
    expect(secrets).toEqual([lease.token]);
    expect(JSON.stringify(events)).not.toContain(lease.token);
    expect(JSON.stringify(events)).not.toContain(PLANTED.ANTHROPIC_API_KEY);
    expect(lease.closed).toBe(true);
  });

  it('opens one key-proxy lease per segment and ends it on completion, failure and abort', async () => {
    const proxy = new FakeKeyProxy();
    await collect(driver(fakeQuery(FIXTURE('pong')), true, proxy), {});
    // eslint-disable-next-line require-yield
    const failing: QueryFn = async function* () {
      throw new Error('engine crashed');
    };
    await collect(driver(failing, true, proxy), {});
    expect(proxy.leases.map((l) => l.closed)).toEqual([true, true]);
    // A stop (kill switch, budget, owner) ends the lease the moment the signal fires.
    let closedAtAbort: boolean | null = null;
    const stopped = await collect(driver(fakeQuery('hang'), true, proxy), {}, {}, (e, c) => {
      if (e.type === 'session.init') {
        c.abort();
        closedAtAbort = proxy.leases[2]!.closed;
      }
    });
    expect(closedAtAbort).toBe(true);
    expect(stopped.at(-1)?.type).toBe('run.cancelled');
    // Stopped before the engine started: no engine, and the lease is gone too.
    const seen: Options[] = [];
    const early = new AbortController();
    early.abort();
    const never = await collect(
      driver(fakeQuery(FIXTURE('pong'), seen), true, proxy),
      {},
      {
        signal: early.signal,
      },
    );
    expect(never.at(-1)?.type).toBe('run.cancelled');
    expect(seen).toHaveLength(0);
    expect(proxy.leases.map((l) => l.closed)).toEqual([true, true, true, true]);
    expect(new Set(proxy.leases.map((l) => l.token)).size).toBe(4);
  });

  it('refuses to construct an API-key engine without the key proxy', () => {
    for (const authMethod of ['api_key', 'api_key_helper'] as AuthMethod[]) {
      expect(
        () =>
          new SdkDriver({
            authMethod,
            env: sourceEnv,
            bare: true,
            apiKeyHelper: null,
            keyProxy: null,
          }),
      ).toThrow(OrbitError);
    }
  });

  it('starts the engine in --bare auth mode with no user settings or MCP servers', async () => {
    const seen: Options[] = [];
    await collect(
      driver(fakeQuery(FIXTURE('pong'), seen)),
      {},
      { appendSystemPrompt: 'Goal: x', model: 'opus' },
    );
    const o = seen[0]!;
    expect(o.extraArgs).toEqual({ bare: null });
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({});
    expect(o.permissionMode).toBe('default');
    expect(o.model).toBe('opus');
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Goal: x' });
    expect(typeof o.canUseTool).toBe('function');
  });

  it('asks the engine to scrub its subprocesses where Claude Code can (bubblewrap on Linux), and runs without the scrub elsewhere', async () => {
    for (const [platform, bwrap, scrub] of [
      ['linux', '/usr/bin/bwrap', '1'],
      ['linux', null, '0'],
      ['darwin', null, '1'],
    ] as const) {
      const seen: Options[] = [];
      const events = await collect(
        new SdkDriver({
          authMethod: 'api_key',
          env: sourceEnv,
          bare: true,
          apiKeyHelper: null,
          keyProxy: new FakeKeyProxy(),
          queryFn: fakeQuery(FIXTURE('pong'), seen),
          platform,
          findBwrap: () => bwrap,
        }),
        {},
      );
      expect(seen[0]!.env!.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, `${platform} ${String(bwrap)}`).toBe(
        scrub,
      );
      expect(seen[0]!.env!.ANTHROPIC_API_KEY).toBe(API_KEY_PLACEHOLDER);
      expect(events.at(-1)?.type).toBe('run.completed');
    }
  });

  it.each(['oauth', '/login managed key', 'none'])(
    'stops the run when an API-key engine reports credential source %s',
    async (source) => {
      const events = await collect(
        driver(fakeQuery(FIXTURE('read-then-write-denied'), [], source)),
        {},
      );
      const last = events.at(-1)!;
      expect(last.type === 'run.failed' && last.data.code).toBe('auth_source_mismatch');
      expect(events.some((e) => e.type === 'tool.call')).toBe(false);
    },
  );

  it('behind the docker key proxy: no API credential, no apiKeyHelper, no host lease, the placeholder source is accepted (ADR-018)', async () => {
    const seen: Options[] = [];
    const proxy = new FakeKeyProxy();
    const helperEngine = (q: QueryFn) =>
      new SdkDriver({
        authMethod: 'api_key_helper',
        env: sourceEnv,
        bare: true,
        apiKeyHelper: '/usr/local/bin/key-helper',
        keyProxy: proxy,
        queryFn: q,
        findBwrap: () => '/usr/bin/bwrap',
      });
    const proxied = await collect(
      helperEngine(fakeQuery(FIXTURE('pong'), seen, 'ANTHROPIC_API_KEY')),
      {},
      { apiKeyProxied: true },
    );
    expect(proxied.at(-1)?.type).toBe('run.completed');
    const o = seen[0]!;
    expect(o.env!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(o.env!.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(JSON.stringify(o.env)).not.toContain(PLANTED.ANTHROPIC_API_KEY);
    expect(o.settings).toBeUndefined();
    expect(o.extraArgs).toEqual({ bare: null });
    expect(o.env!.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    // The container has its own key proxy path: the host proxy is not involved.
    expect(proxy.leases).toEqual([]);
    // On the host, the helper engine is behind the host key proxy: the helper
    // runs in orbitd, so the engine reports the placeholder key...
    const hostSeen: Options[] = [];
    const host = await collect(
      helperEngine(fakeQuery(FIXTURE('pong'), hostSeen, 'ANTHROPIC_API_KEY')),
      {},
    );
    expect(host.at(-1)?.type).toBe('run.completed');
    expect(hostSeen[0]!.settings).toBeUndefined();
    expect(hostSeen[0]!.env!.ANTHROPIC_API_KEY).toBe(API_KEY_PLACEHOLDER);
    // ...and an engine that found a helper of its own anyway is stopped.
    const ownHelper = await collect(
      helperEngine(fakeQuery(FIXTURE('pong'), [], 'apiKeyHelper')),
      {},
    );
    const last = ownHelper.at(-1)!;
    expect(last.type === 'run.failed' && last.data.code).toBe('auth_source_mismatch');
    // And a proxied engine reporting a login source is stopped too.
    const login = await collect(
      helperEngine(fakeQuery(FIXTURE('pong'), [], 'oauth')),
      {},
      { apiKeyProxied: true },
    );
    const end = login.at(-1)!;
    expect(end.type === 'run.failed' && end.data.code).toBe('auth_source_mismatch');
  });

  it('can disable --bare explicitly', async () => {
    const seen: Options[] = [];
    await collect(driver(fakeQuery(FIXTURE('pong'), seen), false), {});
    expect(seen[0]!.extraArgs).toBeUndefined();
  });

  it('routes the canUseTool backstop through the same permission handler', async () => {
    const seen: Options[] = [];
    await collect(driver(fakeQuery(FIXTURE('pong'), seen)), {});
    const r = await seen[0]!.canUseTool!('Write', { file_path: 'x' }, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_x',
    } as Parameters<NonNullable<Options['canUseTool']>>[2]);
    expect(r).toEqual({ behavior: 'deny', message: 'writes need approval', interrupt: false });
  });

  it('maps a thrown SDK error to run.failed', async () => {
    // eslint-disable-next-line require-yield
    const failing: QueryFn = async function* () {
      throw new Error('ANTHROPIC_API_KEY is invalid');
    };
    const events = await collect(driver(failing), {});
    expectWellFormed(events);
    const last = events.at(-1)!;
    expect(last.type === 'run.failed' && last.data.code).toBe('engine_error');
  });

  it('maps an iterator that ends without a result to run.failed', async () => {
    const empty: QueryFn = async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 's',
        tools: [],
        model: 'm',
      } as unknown as SDKMessage;
    };
    const events = await collect(driver(empty), {});
    expectWellFormed(events);
    expect(events.at(-1)!.type === 'run.failed').toBe(true);
  });
});

describe('SdkDriver: Orbit tools and subagents (M6)', () => {
  it('serves Orbit tools in-process (no token, no port) and passes subagents as `agents`', async () => {
    const seen: Options[] = [];
    const calls: string[] = [];
    await collect(
      driver(fakeQuery(FIXTURE('pong'), seen)),
      {},
      {
        orbitTools: {
          http: null,
          tools: [
            {
              name: 'memory_search',
              description: 'search',
              inputSchema: { type: 'object' },
              schema: z.object({ query: z.string() }),
            },
          ],
          call: (name) => {
            calls.push(name);
            return Promise.resolve({ text: 'ok', isError: false });
          },
        },
        agents: { scan: { description: 'd', prompt: 'p', tools: ['Read'], model: 'haiku' } },
      },
    );
    const o = seen[0]!;
    const orbit = o.mcpServers?.orbit as { type: string; name: string } | undefined;
    expect(orbit?.type).toBe('sdk');
    expect(orbit?.name).toBe('orbit');
    expect(JSON.stringify(Object.keys(o.mcpServers ?? {}))).toBe('["orbit"]');
    expect(o.agents).toEqual({
      scan: { description: 'd', prompt: 'p', tools: ['Read'], model: 'haiku' },
    });
  });
});

describe('Bedrock / Vertex engines hold their cloud credentials and need bubblewrap on Linux', () => {
  const CLOUD = {
    ...sourceEnv,
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_ACCESS_KEY_ID: 'AKIAPLANTEDPLANTED00',
    AWS_SECRET_ACCESS_KEY: 'planted-aws-secret-000000000000',
  };
  const cloud = (
    authMethod: 'bedrock' | 'vertex',
    platform: NodeJS.Platform,
    bwrap: string | null,
    q: QueryFn,
    proxy = new FakeKeyProxy(),
  ) =>
    new SdkDriver({
      authMethod,
      env: CLOUD,
      bare: true,
      apiKeyHelper: null,
      keyProxy: proxy,
      queryFn: q,
      platform,
      findBwrap: () => bwrap,
    });

  it('fails the Run before the engine starts, saying how to fix it, and never turns the scrub off', async () => {
    for (const authMethod of ['bedrock', 'vertex'] as const) {
      const seen: Options[] = [];
      const events = await collect(
        cloud(authMethod, 'linux', null, fakeQuery(FIXTURE('pong'), seen)),
        {},
      );
      expect(seen).toHaveLength(0);
      const failed = events.find((e) => e.type === 'run.failed');
      expect(failed?.data).toMatchObject({ code: 'engine_sandbox_missing', retryable: true });
      expect(JSON.stringify(failed)).toContain('apt-get install -y bubblewrap');
    }
  });

  it('unchanged otherwise: the engine gets the cloud credentials with the scrub on, and no key proxy', async () => {
    for (const [platform, bwrap] of [
      ['linux', '/usr/bin/bwrap'],
      ['darwin', null],
    ] as const) {
      const seen: Options[] = [];
      const proxy = new FakeKeyProxy();
      const events = await collect(
        cloud('bedrock', platform, bwrap, fakeQuery(FIXTURE('pong'), seen, 'none'), proxy),
        {},
      );
      expect(events.at(-1)?.type, platform).toBe('run.completed');
      const env = seen[0]!.env!;
      expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
      expect(env.AWS_SECRET_ACCESS_KEY).toBe(CLOUD.AWS_SECRET_ACCESS_KEY);
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(proxy.leases).toEqual([]);
    }
  });

  it('doctor: only an engine holding cloud credentials warns (sdk_needs_bubblewrap); API keys are proxied either way', async () => {
    const probes = {
      findClaude: () => Promise.resolve(null),
      cliStatus: () => Promise.reject(new Error('unused')),
      platform: 'linux' as const,
      findBwrap: () => null,
    };
    const config = OrbitConfig.parse({ home: '/tmp/orbit-test' });
    const key = await resolveAuth({
      config,
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-test-000000' },
      probes,
    });
    expect(key.driver).toBe('sdk');
    expect(key.warnings).toEqual([]);
    expect(key.engineKey).toEqual({ delivery: 'proxied', subprocessScrub: false });
    const bedrock = await resolveAuth({ config, env: { CLAUDE_CODE_USE_BEDROCK: '1' }, probes });
    expect(bedrock.driver).toBe('sdk');
    expect(bedrock.warnings.map((w) => w.code)).toEqual(['sdk_needs_bubblewrap']);
    expect(bedrock.engineKey).toEqual({ delivery: 'in_engine', subprocessScrub: false });
    const withBwrap = await resolveAuth({
      config,
      env: { CLAUDE_CODE_USE_VERTEX: '1' },
      probes: { ...probes, findBwrap: () => '/usr/bin/bwrap' },
    });
    expect(withBwrap.warnings).toEqual([]);
    expect(withBwrap.engineKey).toEqual({ delivery: 'in_engine', subprocessScrub: true });
  });
});
