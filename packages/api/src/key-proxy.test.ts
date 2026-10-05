import { readFileSync } from 'node:fs';
import { type IncomingHttpHeaders, createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Bot, RunState } from '@orbit/core';
import { type AuthProbes, FIXTURES_DIR, type QueryFn } from '@orbit/runtime';
import { API_KEY_PLACEHOLDER } from '@orbit/sandbox';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from '../test/harness';
import type { DoctorReport } from './contract';

/**
 * orbitd with an API key on a host without bubblewrap — the docker compose
 * deployment (ADR-017, ADR-018): Runs work, the engine reaches the API only
 * through orbitd's key proxy, and doctor says so.
 */

const KEY = 'sk-ant-api03-REALKEY-orbitd-key-proxy-0000';

/** The Agent SDK options the driver built (the SDK is a runtime dependency, not the API's). */
type Options = Parameters<QueryFn>[0]['options'];

let h: Harness | undefined;
const closers: (() => void)[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const c of closers.splice(0)) c();
});

/** No `claude` CLI, Linux, no bubblewrap. */
const noBwrap: AuthProbes = {
  findClaude: () => Promise.resolve(null),
  cliStatus: () => Promise.reject(new Error('not installed')),
  platform: 'linux',
  findBwrap: () => null,
};

async function fakeApi(): Promise<{
  base: string;
  seen: { url: string; headers: IncomingHttpHeaders }[];
}> {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"type":"message","content":[]}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** POST a model turn with the engine's env, as Claude Code does (verified against 2.1.289). */
function post(env: Record<string, string>): Promise<number> {
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
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end('{"model":"sonnet","messages":[]}');
  });
}

/** An engine stand-in: one API call with Orbit's env, then the recorded "pong" session. */
function engine(seen: Options[], statuses: number[]): QueryFn {
  const lines = readFileSync(join(FIXTURES_DIR, 'claude-2.1.289', 'pong.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return async function* ({ options }) {
    seen.push(options);
    statuses.push(await post(options.env as Record<string, string>));
    for (const m of lines) {
      yield {
        ...m,
        session_id: options.sessionId,
        ...(m.type === 'system' && m.subtype === 'init'
          ? { apiKeySource: 'ANTHROPIC_API_KEY' }
          : {}),
      } as never;
    }
  };
}

describe('orbitd with an API key and no bubblewrap (docker compose)', () => {
  it('runs a Bot through the key proxy: the real key only upstream, never in the engine, events or doctor', async () => {
    const api = await fakeApi();
    const seen: Options[] = [];
    const statuses: number[] = [];
    h = harness({
      config: { driver: 'sdk' },
      // No bubblewrap on orbitd's PATH (the driver looks for it before each segment).
      env: { PATH: '/nonexistent', ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: api.base },
      service: { probes: noBwrap, queryFn: engine(seen, statuses) },
    });
    const before = (await h.json<DoctorReport>('GET', '/v1/doctor')).body;
    expect(before.engineKey).toMatchObject({
      delivery: 'proxied',
      subprocessScrub: false,
      proxy: null,
    });
    expect(before.warnings.map((w) => w.code)).not.toContain('sdk_needs_bubblewrap');

    const bot = (await h.json<Bot>('POST', '/v1/bots', { name: 'Composed', goal: 'Say pong' }))
      .body;
    const run = (await h.json<RunState>('POST', `/v1/bots/${bot.id}/runs`, {})).body;
    await h.service.queue.idle();
    expect(h.service.store.getRun(run.runId)?.status).toBe('completed');

    expect(statuses).toEqual([200]);
    expect(api.seen).toEqual([expect.objectContaining({ url: '/v1/messages?beta=true' })]);
    expect(api.seen[0]!.headers['x-api-key']).toBe(KEY);
    const env = seen[0]!.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY_PLACEHOLDER);
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('0');
    expect(JSON.stringify(env)).not.toContain(KEY);
    const token = new URL(env.ANTHROPIC_BASE_URL!).pathname.slice(1);
    const events = JSON.stringify(h.service.store.listRunEvents(run.runId));
    expect(events).not.toContain(KEY);
    expect(events).not.toContain(token);

    const after = (await h.json<DoctorReport>('GET', '/v1/doctor')).body;
    expect(after.engineKey?.proxy).toMatchObject({
      activeSegments: 0,
      api: { forwarded: 1, refused: 0 },
    });
    expect(after.engineKey?.proxy?.port).toBe(Number(new URL(env.ANTHROPIC_BASE_URL!).port));
    expect(JSON.stringify(after)).not.toContain(KEY);
    // The segment ended, and its token with it.
    expect(await post(env)).toBe(403);
    expect(api.seen).toHaveLength(1);
  });

  it('doctor: Bedrock / Vertex keep their credentials in the engine and still need bubblewrap', async () => {
    h = harness({
      config: { driver: 'sdk' },
      env: { CLAUDE_CODE_USE_BEDROCK: '1' },
      service: { probes: noBwrap },
    });
    const d = (await h.json<DoctorReport>('GET', '/v1/doctor')).body;
    expect(d.engineKey).toMatchObject({ delivery: 'in_engine', subprocessScrub: false });
    expect(d.warnings.map((w) => w.code)).toContain('sdk_needs_bubblewrap');
  });

  it('doctor: a gateway the key proxy would reach in clear text is a warning, and other drivers report no engine key', async () => {
    h = harness({
      config: { driver: 'sdk' },
      env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'http://gateway.example' },
      service: { probes: { ...noBwrap, findBwrap: () => '/usr/bin/bwrap' } },
    });
    const d = (await h.json<DoctorReport>('GET', '/v1/doctor')).body;
    expect(d.engineKey).toMatchObject({ delivery: 'proxied', subprocessScrub: true });
    const warning = d.warnings.find((w) => w.code === 'key_proxy_upstream');
    expect(warning?.message).toMatch(/only over https/);
    await h.close();
    h = harness();
    expect((await h.json<DoctorReport>('GET', '/v1/doctor')).body.engineKey).toBeNull();
  });
});
