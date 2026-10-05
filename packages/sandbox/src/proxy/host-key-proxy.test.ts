import { randomBytes } from 'node:crypto';
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  createServer,
  request,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { OrbitError } from '@orbit/core';
import { afterEach, describe, expect, it } from 'vitest';
import { HostKeyProxy } from './host-key-proxy';
import { type ApiKeySource, staticApiKey } from './key-source';
import type { ProxyRefusal } from './stats';

const KEY = 'sk-ant-api03-REALKEY-host-proxy-test';
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A fake Anthropic API: records requests, answers through `respond`. */
async function upstream(
  respond: (req: IncomingMessage, res: ServerResponse) => void = (_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message"}');
  },
): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function proxy(base: string, key: ApiKeySource = staticApiKey(KEY), refusals: ProxyRefusal[] = []) {
  const p = new HostKeyProxy({ upstream: base, key, onRefusal: (r) => refusals.push(r) });
  closers.push(() => p.close());
  return p;
}

interface Reply {
  status: number;
  body: string;
}

/** What the host engine sends: the placeholder key, to its base URL plus the API path. */
function call(
  url: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'orbit-key-proxy-placeholder',
          authorization: 'Bearer engine-token',
          'anthropic-version': '2023-06-01',
          ...opts.headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(opts.body ?? JSON.stringify({ model: 'sonnet', messages: [], max_tokens: 1 }));
  });
}

const messages = (base: string) => `${base}/v1/messages?beta=true`;

describe('HostKeyProxy (host SDK engines, ADR-018)', () => {
  it('forwards with the real key, strips the segment token and keeps a gateway prefix', async () => {
    const up = await upstream();
    const p = proxy(`${up.base}/gw`);
    const lease = await p.open();
    expect(lease.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/);
    expect(lease.baseUrl.endsWith(`/${lease.token}`)).toBe(true);
    const r = await call(messages(lease.baseUrl));
    expect(r).toEqual({ status: 200, body: '{"type":"message"}' });
    expect(up.seen).toHaveLength(1);
    const seen = up.seen[0]!;
    expect(seen.url).toBe('/gw/v1/messages?beta=true');
    expect(seen.headers['x-api-key']).toBe(KEY);
    expect(seen.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(lease.token);
    expect(p.status()).toMatchObject({ activeSegments: 1, api: { forwarded: 1, refused: 0 } });
  });

  it('refuses requests without a token, with a wrong one, an ended one, or one reused by another segment', async () => {
    const up = await upstream();
    const refusals: ProxyRefusal[] = [];
    const p = proxy(up.base, staticApiKey(KEY), refusals);
    const first = await p.open();
    const origin = new URL(first.baseUrl).origin;
    const wrong = randomBytes(32).toString('base64url');

    const replies: Reply[] = [];
    replies.push(await call(messages(origin)));
    replies.push(await call(messages(`${origin}/${wrong}`)));
    replies.push(await call(messages(`${origin}/${first.token.slice(0, 42)}`)));
    replies.push(await call(messages(`${origin}/${first.token}x`)));
    expect(up.seen).toEqual([]);

    // The first segment ends; a second one starts on the same port with its own token.
    first.close();
    first.close();
    const second = await p.open();
    expect(new URL(second.baseUrl).origin).toBe(origin);
    expect(second.token).not.toBe(first.token);
    replies.push(await call(messages(first.baseUrl)));
    expect(up.seen).toEqual([]);
    expect((await call(messages(second.baseUrl))).status).toBe(200);
    second.close();
    replies.push(await call(messages(second.baseUrl)));
    expect(up.seen).toHaveLength(1);

    for (const r of replies) {
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body)).toMatchObject({
        type: 'error',
        error: { type: 'permission_error' },
      });
      expect(r.body).not.toContain(KEY);
    }
    expect(refusals.map((r) => r.reason)).toEqual([
      'the request has no segment token',
      'the segment token is unknown or has expired',
      'the request has no segment token',
      'the request has no segment token',
      'the segment token is unknown or has expired',
      'the segment token is unknown or has expired',
    ]);
    // Refusals name the API route only: never a token, a query string or the key.
    const recorded = JSON.stringify(p.status());
    for (const secret of [first.token, second.token, wrong, KEY, 'beta=true']) {
      expect(recorded).not.toContain(secret);
    }
    expect(refusals.map((r) => r.target)).toContain('POST /v1/messages');
    expect(p.status()).toMatchObject({ activeSegments: 0, api: { forwarded: 1, refused: 6 } });
  });

  it('refuses browser requests even with a live token', async () => {
    const up = await upstream();
    const p = proxy(up.base);
    const lease = await p.open();
    const r = await call(messages(lease.baseUrl), { headers: { origin: 'http://evil.example' } });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/browser requests are refused/);
    expect(up.seen).toEqual([]);
  });

  it('keeps the proxy body rules but allows the API web tools (a host engine has network anyway)', async () => {
    const up = await upstream();
    const p = proxy(up.base);
    const lease = await p.open();
    const mcp = await call(messages(lease.baseUrl), {
      body: JSON.stringify({ model: 'sonnet', messages: [], mcp_servers: [{ url: 'https://x' }] }),
    });
    expect(mcp.status).toBe(403);
    expect(mcp.body).toMatch(/remote MCP servers/);
    const urlSource = await call(messages(lease.baseUrl), {
      body: JSON.stringify({
        model: 'sonnet',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
          },
        ],
      }),
    });
    expect(urlSource.status).toBe(403);
    const files = await call(`${lease.baseUrl}/v1/files`);
    expect(files.status).toBe(403);
    expect(up.seen).toEqual([]);
    const web = await call(messages(lease.baseUrl), {
      body: JSON.stringify({
        model: 'sonnet',
        messages: [],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });
    expect(web.status).toBe(200);
    expect(up.seen).toHaveLength(1);
  });

  it("answers the engine's warm-up under its token locally and refuses tunnels", async () => {
    const up = await upstream();
    const p = proxy(up.base);
    const lease = await p.open();
    expect((await call(`${lease.baseUrl}/api/hello`, { method: 'HEAD', body: '' })).status).toBe(
      200,
    );
    const { hostname, port } = new URL(lease.baseUrl);
    const tunnel = await new Promise<string>((resolve) => {
      const req = request({ host: hostname, port, method: 'CONNECT', path: 'evil.example:443' });
      req.on('connect', (res) => resolve(String(res.statusCode)));
      req.on('error', () => resolve('closed'));
      req.end();
    });
    expect(tunnel).toBe('closed');
    expect(up.seen).toEqual([]);
    expect(p.status().api.recent.at(-1)?.reason).toMatch(/does not tunnel/);
  });

  it('cuts a streaming request the moment its segment ends', async () => {
    let upstreamClosed: () => void = () => undefined;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const up = await upstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {}\n\n');
      req.socket.once('close', () => upstreamClosed());
    });
    const p = proxy(up.base);
    const lease = await p.open();
    const other = await p.open();
    const u = new URL(messages(lease.baseUrl));
    let clientClosed: Promise<void> = Promise.resolve();
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: u.hostname,
          port: u.port,
          path: `${u.pathname}${u.search}`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.once('data', () => {
            clientClosed = new Promise<void>((r) => res.once('close', () => r()));
            lease.close();
            resolve();
          });
        },
      );
      req.on('error', () => undefined);
      req.end('{"model":"sonnet","messages":[]}');
      setTimeout(() => reject(new Error('no data')), 5000);
    });
    await Promise.all([closed, clientClosed]);
    // Another segment's token keeps working.
    expect(p.status().activeSegments).toBe(1);
    other.close();
  });

  it('answers 502 when the key helper fails, never with the key or the token', async () => {
    const up = await upstream();
    const failing: ApiKeySource = {
      get: () =>
        Promise.reject(new OrbitError('auth_required', 'The API key helper exited with code 1')),
      invalidate: () => undefined,
    };
    const p = proxy(up.base, failing);
    const lease = await p.open();
    const r = await call(messages(lease.baseUrl));
    expect(r.status).toBe(502);
    expect(r.body).toMatch(/API key helper exited with code 1/);
    expect(r.body).not.toContain(lease.token);
    expect(up.seen).toEqual([]);
  });

  it('refuses an upstream that would carry the key in clear text to another machine', () => {
    expect(
      () => new HostKeyProxy({ upstream: 'http://gateway.example', key: staticApiKey(KEY) }),
    ).toThrow(/only over https/);
  });

  it('close() ends every segment and stops listening; a later segment listens again', async () => {
    const up = await upstream();
    const p = proxy(up.base);
    const lease = await p.open();
    await p.close();
    await expect(call(messages(lease.baseUrl))).rejects.toThrow();
    expect(p.status()).toMatchObject({ port: null, activeSegments: 0 });
    const again = await p.open();
    expect((await call(messages(again.baseUrl))).status).toBe(200);
  });
});
