import { join } from 'node:path';
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FIXTURES_DIR } from '../src/drivers/fixtures';
import { type QueryFn, SdkDriver } from '../src/drivers/sdk';
import { type Harness, collect, expectWellFormed, runDriverContract } from './driver-contract';
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

function driver(queryFn: QueryFn, bare = true): SdkDriver {
  return new SdkDriver({
    authMethod: 'api_key',
    env: sourceEnv,
    bare,
    apiKeyHelper: null,
    queryFn,
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
  it('passes the API key to the engine but never OAuth tokens or unrelated vars', async () => {
    const seen: Options[] = [];
    await collect(driver(fakeQuery(FIXTURE('pong'), seen)), {});
    const env = seen[0]!.env!;
    expect(env.ANTHROPIC_API_KEY).toBe(PLANTED.ANTHROPIC_API_KEY);
    for (const name of [
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_SESSION_ID',
      'GITHUB_TOKEN',
    ]) {
      expect(env[name], name).toBeUndefined();
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

  it('asks the engine to scrub API credentials from its own subprocesses', async () => {
    const seen: Options[] = [];
    await collect(driver(fakeQuery(FIXTURE('pong'), seen)), {});
    expect(seen[0]!.env!.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
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

  it('behind the docker key proxy: no API credential, no apiKeyHelper, the placeholder source is accepted (ADR-018)', async () => {
    const seen: Options[] = [];
    const helperEngine = (q: QueryFn) =>
      new SdkDriver({
        authMethod: 'api_key_helper',
        env: sourceEnv,
        bare: true,
        apiKeyHelper: '/usr/local/bin/key-helper',
        queryFn: q,
      });
    const proxied = await collect(
      helperEngine(fakeQuery(FIXTURE('pong'), seen, 'ANTHROPIC_API_KEY')),
      {},
      { apiKeyProxied: true },
    );
    expect(proxied.at(-1)?.type).toBe('run.completed');
    const o = seen[0]!;
    expect(o.env!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(o.env)).not.toContain(PLANTED.ANTHROPIC_API_KEY);
    expect(o.settings).toBeUndefined();
    expect(o.extraArgs).toEqual({ bare: null });
    expect(o.env!.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    // Without the proxy, a helper engine that reports ANTHROPIC_API_KEY is still stopped.
    const direct = await collect(
      helperEngine(fakeQuery(FIXTURE('pong'), [], 'ANTHROPIC_API_KEY')),
      {},
    );
    const last = direct.at(-1)!;
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
