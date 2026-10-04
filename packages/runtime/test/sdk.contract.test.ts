import { join } from 'node:path';
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
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
function fakeQuery(fixture: string, seen: Options[] = []): QueryFn {
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
    for await (const m of replay(readFixture(fixture), {
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
