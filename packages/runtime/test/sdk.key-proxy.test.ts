import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { type IncomingHttpHeaders, type ServerResponse, createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { type RunEventBody, Redactor } from '@orbit/core';
import { API_KEY_PLACEHOLDER, HostKeyProxy, staticApiKey } from '@orbit/sandbox';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../src/drivers/fixtures';
import { type QueryFn, SdkDriver } from '../src/drivers/sdk';
import { allowAll, collect } from './driver-contract';
import { readFixture, replay } from './fake-engine.mjs';

/**
 * The host SDK engine behind orbitd's key proxy (ADR-018, amended), end to
 * end: the real HostKeyProxy, the SdkDriver's real engine environment and —
 * when the engine binary is installed — the real Claude Code engine, against
 * a fake Anthropic API on loopback. This is the docker compose deployment's
 * path (orbitd in an unprivileged container, no bubblewrap): the key never
 * enters an engine process, and Runs work without the subprocess scrub.
 */

const KEY = 'sk-ant-api03-REALKEY-host-engine-test-000000';
const FIXTURE = (name: string) => join(FIXTURES_DIR, 'claude-2.1.289', `${name}.jsonl`);
const root = mkdtempSync(join(tmpdir(), 'orbit-keyproxy-'));
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
afterAll(() => {
  // A real engine may still be flushing its session files into HOME while it exits.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

/** A model turn that answers "pong", as server-sent events. */
function pong(res: ServerResponse, model: string): void {
  const events: [string, Record<string, unknown>][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''));
}

/** The Anthropic API as the key proxy sees it: records each request, answers "pong". */
async function fakeApi(
  onRequest: (seen: Seen, res: ServerResponse, body: string) => boolean = () => false,
): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const s = { method: req.method ?? '', url: req.url ?? '', headers: req.headers };
      seen.push(s);
      if (onRequest(s, res, body)) return;
      if (s.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":3}');
        return;
      }
      let model = 'model';
      try {
        model = (JSON.parse(body) as { model?: string }).model ?? model;
      } catch {
        // not JSON: answer anyway
      }
      pong(res, model);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function keyProxy(base: string): HostKeyProxy {
  const p = new HostKeyProxy({ upstream: base, key: staticApiKey(KEY) });
  closers.push(() => p.close());
  return p;
}

/** POST a model turn the way the engine does with its environment (verified against 2.1.289). */
function engineRequest(env: Record<string, string>, onData?: () => void): Promise<number> {
  const u = new URL(`${env.ANTHROPIC_BASE_URL ?? ''}/v1/messages?beta=true`);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY ?? '' },
      },
      (res) => {
        res.on('data', () => onData?.());
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', () => resolve(res.statusCode ?? 0));
        res.on('close', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end('{"model":"sonnet","messages":[],"max_tokens":1}');
  });
}

/** An engine stand-in: calls the API with the env Orbit built, then replays a fixture. */
function engineLike(seen: Options[], statuses: number[], before?: () => Promise<void>): QueryFn {
  return async function* ({ options }) {
    seen.push(options);
    statuses.push(await engineRequest(options.env as Record<string, string>));
    await before?.();
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const signal = options.abortController!.signal;
    const messages = readFixture(FIXTURE('pong')).map((m) =>
      m.type === 'system' && m.subtype === 'init' ? { ...m, apiKeySource: 'ANTHROPIC_API_KEY' } : m,
    );
    for await (const m of replay(messages, {
      decide: (input) =>
        hook(input as Parameters<typeof hook>[0], input.tool_use_id as string, { signal }),
      sessionId: options.sessionId,
      cwd: options.cwd ?? '/',
    })) {
      yield m as never;
    }
  };
}

/** orbitd's own environment in the docker compose image: an API key, no bubblewrap. */
const ORBITD_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, ANTHROPIC_API_KEY: KEY };

function hostDriver(
  proxy: HostKeyProxy,
  queryFn: QueryFn | undefined,
  redactor: Redactor,
  env: Record<string, string> = ORBITD_ENV,
  bwrap: string | null = null,
): SdkDriver {
  return new SdkDriver({
    authMethod: 'api_key',
    env,
    bare: true,
    apiKeyHelper: null,
    keyProxy: proxy,
    secrets: redactor,
    ...(queryFn ? { queryFn } : {}),
    platform: 'linux',
    findBwrap: () => bwrap,
  });
}

describe('SdkDriver behind the real HostKeyProxy (no bubblewrap, docker compose)', () => {
  it('the engine env reaches the API through the proxy: real key injected upstream, token stripped, scrub off', async () => {
    const api = await fakeApi();
    const proxy = keyProxy(api.base);
    const redactor = new Redactor();
    const seen: Options[] = [];
    const statuses: number[] = [];
    const events = await collect(hostDriver(proxy, engineLike(seen, statuses), redactor), {});
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(statuses).toEqual([200]);
    const env = seen[0]!.env as Record<string, string>;
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('0');
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY_PLACEHOLDER);
    expect(JSON.stringify(env)).not.toContain(KEY);
    const token = new URL(env.ANTHROPIC_BASE_URL!).pathname.slice(1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(api.seen).toEqual([
      expect.objectContaining({ method: 'POST', url: '/v1/messages?beta=true' }),
    ]);
    expect(api.seen[0]!.headers['x-api-key']).toBe(KEY);
    // The token never shows in events; the segment's end killed it, and once
    // its events were consumed the redactor forgot it (M8 review L9).
    expect(JSON.stringify(events)).not.toContain(token);
    expect(await engineRequest(env)).toBe(403);
    expect(redactor.redactString(`base ${env.ANTHROPIC_BASE_URL!}`)).toContain(token);
    expect(api.seen).toHaveLength(1);
    expect(proxy.status()).toMatchObject({ activeSegments: 0, api: { forwarded: 1, refused: 1 } });
  });

  it("a segment's token never works for another segment, during or after it", async () => {
    const api = await fakeApi();
    const proxy = keyProxy(api.base);
    const redactor = new Redactor();
    const seen: Options[] = [];
    const statuses: number[] = [];
    await collect(hostDriver(proxy, engineLike(seen, statuses), redactor), {});
    const first = seen[0]!.env as Record<string, string>;
    // While the second segment runs, the first one's token is refused.
    const reuse: number[] = [];
    await collect(
      hostDriver(
        proxy,
        engineLike(seen, statuses, async () => {
          reuse.push(await engineRequest(first));
        }),
        redactor,
      ),
      {},
    );
    const second = seen[1]!.env as Record<string, string>;
    expect(second.ANTHROPIC_BASE_URL).not.toBe(first.ANTHROPIC_BASE_URL);
    expect(new URL(second.ANTHROPIC_BASE_URL!).port).toBe(new URL(first.ANTHROPIC_BASE_URL!).port);
    expect(statuses).toEqual([200, 200]);
    expect(reuse).toEqual([403]);
    expect(api.seen).toHaveLength(2);
  });

  it('stopping the Run cuts the streaming API request at once (stop, kill switch, budget)', async () => {
    let upstreamClosed: () => void = () => undefined;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const api = await fakeApi((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {"type":"ping"}\n\n');
      res.socket?.once('close', () => upstreamClosed());
      return true;
    });
    const proxy = keyProxy(api.base);
    const controller = new AbortController();
    // An engine whose model turn is still streaming when the Run is stopped.
    const streaming: QueryFn = async function* ({ options }) {
      const env = options.env as Record<string, string>;
      let first: () => void = () => undefined;
      const streamingNow = new Promise<void>((r) => (first = r));
      const done = engineRequest(env, () => first());
      await streamingNow;
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 's-stream',
        tools: [],
        model: 'm',
        apiKeySource: 'ANTHROPIC_API_KEY',
      } as never;
      // The lease ended with the stop: the proxy cut the request mid-stream.
      await done;
      const signal = options.abortController!.signal;
      await new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const events = await collect(
      hostDriver(proxy, streaming, new Redactor()),
      {},
      { signal: controller.signal },
      (e) => {
        if (e.type === 'session.init') controller.abort();
      },
    );
    await closed;
    expect(events.at(-1)?.type).toBe('run.cancelled');
    expect(proxy.status().activeSegments).toBe(0);
  });
});

// ── the real engine binary ────────────────────────────────────────────────

/** The Claude Code engine the Agent SDK would start here, or null when it is not installed. */
function engineBinary(): string | null {
  if (process.platform !== 'linux' || process.arch !== 'x64') return null;
  try {
    const local = createRequire(import.meta.url);
    const sdk = createRequire(local.resolve('@anthropic-ai/claude-agent-sdk'));
    const bin = join(
      dirname(sdk.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/package.json')),
      'claude',
    );
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

const ENGINE = engineBinary();
const bwrapWorks =
  ENGINE !== null &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'], {
    stdio: 'ignore',
    timeout: 10_000,
  }).status === 0;

/** Environment and argv of every running engine process (Linux /proc). */
function engineProcesses(): { environ: string; cmdline: string }[] {
  const out: { environ: string; cmdline: string }[] = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (ENGINE !== null && cmdline.includes(ENGINE)) {
        out.push({ cmdline, environ: readFileSync(`/proc/${pid}/environ`, 'utf8') });
      }
    } catch {
      // the process ended meanwhile
    }
  }
  return out;
}

describe.skipIf(ENGINE === null)('the real engine binary behind the HostKeyProxy', () => {
  async function realRun(bwrap: string | null): Promise<void> {
    const procs: { environ: string; cmdline: string }[][] = [];
    const api = await fakeApi((s) => {
      // While the engine waits for this answer, look at its process.
      if (s.method === 'POST') procs.push(engineProcesses());
      return false;
    });
    const proxy = keyProxy(api.base);
    const redactor = new Redactor();
    const home = mkdtempSync(join(root, 'home-'));
    // Without bubblewrap the PATH holds nothing at all: no bwrap for the engine to find.
    const path = bwrap === null ? mkdtempSync(join(root, 'empty-path-')) : process.env.PATH;
    const env = { ...ORBITD_ENV, HOME: home, PATH: path ?? '/usr/bin:/bin' };
    const events: RunEventBody[] = await collect(
      hostDriver(proxy, undefined, redactor, env, bwrap),
      {},
      { prompt: 'Say pong.', model: 'sonnet', cwd: home, permission: allowAll },
    );
    const end = events.at(-1);
    expect(end?.type, JSON.stringify(end)).toBe('run.completed');
    const init = events.find((e) => e.type === 'session.init');
    expect(init?.type === 'session.init' && init.data.apiKeySource).toBe('ANTHROPIC_API_KEY');
    expect(JSON.stringify(events)).toContain('pong');
    // Every model call reached the upstream with the real key and without the token.
    const posts = api.seen.filter((s) => s.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    for (const s of api.seen) {
      expect(s.url).toMatch(/^\/v1\/messages(\/count_tokens)?\?beta=true$/);
      expect(s.headers['x-api-key']).toBe(KEY);
      expect(s.headers.authorization).toBeUndefined();
    }
    // The engine process held the placeholder and the token URL, never the key.
    const seenProcs = procs.flat();
    expect(seenProcs.length).toBeGreaterThan(0);
    for (const p of seenProcs) {
      expect(p.environ).not.toContain(KEY);
      expect(p.cmdline).not.toContain(KEY);
      expect(p.environ).toContain(`ANTHROPIC_API_KEY=${API_KEY_PLACEHOLDER}`);
      expect(p.environ).toContain(`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=${bwrap === null ? '0' : '1'}`);
    }
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(proxy.status().activeSegments).toBe(0);
    // Let the engine finish writing its session files and exit before HOME is removed.
    for (let i = 0; i < 100 && engineProcesses().length > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('without bubblewrap (scrub off): the turn completes through the proxy', async () => {
    await realRun(null);
  }, 90_000);

  it.skipIf(!bwrapWorks)(
    'with bubblewrap (scrub on, defence in depth)',
    async () => {
      await realRun('/usr/bin/bwrap');
    },
    90_000,
  );
});
