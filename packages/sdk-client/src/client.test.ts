import { OrbitError, type RunEvent } from '@orbit/core';
import { type Harness, TOKEN, harness } from '@orbit/api/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { OrbitClient } from './client';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setup() {
  h = harness();
  const baseUrl = await h.listen();
  return { h, baseUrl, client: new OrbitClient({ baseUrl, token: TOKEN }) };
}

describe('OrbitClient', () => {
  it('calls typed routes and validates responses', async () => {
    const { h, client } = await setup();
    expect((await client.health()).ok).toBe(true);
    const bot = await client.bots.create({ name: 'Notes', goal: 'g', mock: { fixture: 'pong' } });
    expect(bot.version).toBe(1);
    const run = await client.runs.start('notes', { prompt: 'hello' });
    expect(run.status).toBe('queued');
    await h.service.queue.idle();
    expect((await client.runs.get(run.runId)).status).toBe('completed');
    expect((await client.runs.list({ bot: 'notes' })).map((r) => r.runId)).toEqual([run.runId]);
    expect((await client.runs.events(run.runId)).map((e) => e.type)).toContain('run.completed');
    expect(await client.audit.export()).toContain('bot.created');
    expect(await client.kill.status()).toEqual({ engaged: false, by: null });
  });

  it('turns API errors into OrbitErrors with code, message and hint', async () => {
    const { baseUrl, client } = await setup();
    await expect(client.bots.get('missing')).rejects.toMatchObject({
      code: 'not_found',
      message: 'Bot "missing" not found',
    });
    const wrong = new OrbitClient({ baseUrl, token: 'wrong' });
    const err = await wrong.bots.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrbitError);
    expect(err).toMatchObject({
      code: 'unauthorized',
      hint: expect.stringMatching(/daemon.token/) as unknown,
    });
    const down = new OrbitClient({ baseUrl: 'http://127.0.0.1:9', token: TOKEN });
    await expect(down.health()).rejects.toMatchObject({ code: 'daemon_unavailable' });
  });

  it('rejects a response that does not match the contract (version skew)', async () => {
    const client = new OrbitClient({
      baseUrl: 'http://orbit.test',
      token: TOKEN,
      fetch: () => Promise.resolve(Response.json({ ok: 'yes' })),
    });
    await expect(client.health()).rejects.toMatchObject({
      code: 'internal',
      message: /unexpected shape/,
    });
  });

  it('streams events and resumes after a dropped connection without gaps or duplicates', async () => {
    const { h, baseUrl } = await setup();
    let connections = 0;
    const lastEventIds: (string | null)[] = [];
    // Cut the first connection after two frames, as a flaky network would.
    const flaky = async (input: string, init?: RequestInit) => {
      const res = await fetch(input, init);
      if (!input.includes('/v1/events')) return res;
      connections += 1;
      lastEventIds.push(new Headers(init?.headers).get('last-event-id'));
      if (connections > 1) return res;
      // Pass exactly the first two SSE frames through, then drop the connection.
      const reader: ReadableStreamDefaultReader<Uint8Array> = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (!done) text += decoder.decode(value, { stream: true });
          const frames = text.split('\n\n');
          if (frames.length > 2 || done) {
            controller.enqueue(new TextEncoder().encode(`${frames.slice(0, 2).join('\n\n')}\n\n`));
            await reader.cancel();
            controller.close();
          }
        },
      });
      return new Response(body, { status: res.status, headers: res.headers });
    };
    const client = new OrbitClient({ baseUrl, token: TOKEN, fetch: flaky });
    await client.bots.create({
      name: 'Notes',
      goal: 'g',
      mock: { fixture: 'read-then-write-denied' },
    });
    const run = await client.runs.start('notes');
    const controller = new AbortController();
    const seen: RunEvent[] = [];
    for await (const e of client.events({
      run: run.runId,
      signal: controller.signal,
      reconnectDelayMs: 10,
    })) {
      seen.push(e);
      if (e.type === 'run.completed') controller.abort();
    }
    const all = h.service.store.listRunEvents(run.runId);
    expect(seen.map((e) => e.id)).toEqual(all.map((e) => e.id));
    expect(connections).toBe(2);
    expect(lastEventIds[0]).toBeNull();
    expect(Number(lastEventIds[1])).toBe(seen[1]!.id);
  });

  it('gives up with daemon_unavailable when the daemon stays away', async () => {
    const client = new OrbitClient({ baseUrl: 'http://127.0.0.1:9', token: TOKEN });
    const consume = async () => {
      for await (const _ of client.events({ maxReconnects: 2, reconnectDelayMs: 1 })) {
        // nothing arrives
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: 'daemon_unavailable' });
  });

  it('reports each (re)connect through onOpen', async () => {
    const { client } = await setup();
    const controller = new AbortController();
    let opened = 0;
    const consume = (async () => {
      for await (const _ of client.events({
        signal: controller.signal,
        onOpen: () => (opened += 1),
      })) {
        // no events on an idle daemon
      }
    })();
    for (let i = 0; i < 50 && opened === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(opened).toBe(1);
    controller.abort();
    await consume;
  });

  it('browser mode: no token, a credentials mode and extra headers on every call (ADR-011)', async () => {
    const SESSION = {
      via: 'session',
      principal: { id: 'owner', name: 'Local owner', role: 'owner' },
    };
    const seen: { headers: Headers; credentials: string | undefined }[] = [];
    const fake = (_url: string, init?: RequestInit) => {
      seen.push({ headers: new Headers(init?.headers), credentials: init?.credentials });
      return Promise.resolve(Response.json(SESSION));
    };
    const client = new OrbitClient({
      baseUrl: '',
      credentials: 'same-origin',
      headers: { 'x-orbit-csrf': '1' },
      fetch: fake,
    });
    expect(await client.call('getSession')).toEqual(SESSION);
    expect(seen[0]?.headers.get('authorization')).toBeNull();
    expect(seen[0]?.headers.get('x-orbit-csrf')).toBe('1');
    expect(seen[0]?.credentials).toBe('same-origin');
    // Headers may be read per request (the App's CSRF secret appears at sign-in).
    let secret = 'before';
    const live = new OrbitClient({
      baseUrl: '',
      headers: () => ({ 'x-orbit-csrf': secret }),
      fetch: fake,
    });
    await live.call('getSession');
    secret = 'after';
    await live.call('getSession');
    expect(seen.slice(-2).map((x) => x.headers.get('x-orbit-csrf'))).toEqual(['before', 'after']);
  });
});
