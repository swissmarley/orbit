import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
  request,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitError } from '@orbit/core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  apiRouteAllowed,
  bodyRefusal,
  createApiProxy,
  forwardRequestHeaders,
  parseUpstream,
} from './api-proxy';
import type { ProxyServer } from './egress-proxy';
import { type ApiKeySource, staticApiKey } from './key-source';

const KEY = 'sk-ant-api03-REALKEY-never-in-the-container';
const root = mkdtempSync(join(tmpdir(), 'orbit-apiproxy-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A fake Anthropic API: records requests, answers through `respond`. */
async function upstream(
  respond: (req: IncomingMessage, res: ServerResponse, body: string) => void = (_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_1' });
    res.end('{"type":"message"}');
  },
  server: Server = createServer(),
): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      respond(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen };
}

let n = 0;
async function proxyFor(
  base: string,
  over: Partial<Parameters<typeof createApiProxy>[0]> = {},
): Promise<{ proxy: ProxyServer; socketPath: string; armed: { value: boolean } }> {
  const armed = { value: true };
  const proxy = createApiProxy({
    upstream: parseUpstream(base),
    key: staticApiKey(KEY),
    armed: () => armed.value,
    webTools: () => false,
    ...over,
  });
  n += 1;
  const socketPath = join(root, `api-${n}.sock`);
  await new Promise<void>((resolve) => proxy.server.listen(socketPath, resolve));
  closers.push(() => {
    proxy.dropConnections();
    proxy.server.close();
  });
  return { proxy, socketPath, armed };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** What the engine in the container does: placeholder key, its own Authorization header. */
function call(
  socketPath: string,
  opts: { method?: string; path?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body =
      opts.body ??
      (opts.method === 'GET' || opts.method === 'HEAD'
        ? ''
        : JSON.stringify({ model: 'sonnet', messages: [], max_tokens: 1 }));
    const req = request(
      {
        socketPath,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/v1/messages?beta=true',
        headers: {
          host: '127.0.0.1:47180',
          'content-type': 'application/json',
          'x-api-key': 'orbit-key-proxy-placeholder',
          authorization: 'Bearer container-token',
          cookie: 'session=1',
          'proxy-authorization': 'Basic x',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'claude-code-20250219',
          'x-stainless-lang': 'js',
          'x-claude-code-session-id': 'sess-1',
          'user-agent': 'claude-cli/2.1.289',
          ...opts.headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('API route allowlist', () => {
  const table: [string, string, boolean][] = [
    ['POST', '/v1/messages', true],
    ['POST', '/v1/messages?beta=true', true],
    ['POST', '/v1/messages/count_tokens?beta=true', true],
    ['GET', '/v1/messages', false],
    ['POST', '/v1/messages?beta=true&x=1', false],
    ['POST', '/v1/messages/batches', false],
    ['POST', '/v1/files', false],
    ['GET', '/v1/models', false],
    ['POST', '/v1/skills', false],
    ['HEAD', '/api/hello', false],
    ['POST', '/v1/messages/../files', false],
    ['POST', '/v1//messages', false],
    ['POST', 'http://evil.example/v1/messages', false],
  ];
  for (const [method, url, ok] of table) {
    it(`${method} ${url} → ${ok ? 'forwarded' : 'refused'}`, () => {
      expect(apiRouteAllowed(method, url)).toBe(ok);
    });
  }
});

describe('request headers', () => {
  it('drops credentials, cookies and proxy headers; keeps the API protocol headers', () => {
    expect(
      forwardRequestHeaders({
        'x-api-key': 'placeholder',
        authorization: 'Bearer t',
        'proxy-authorization': 'Basic x',
        cookie: 'a=1',
        host: '127.0.0.1:47180',
        connection: 'keep-alive',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'a,b',
        'x-stainless-retry-count': '0',
        'x-claude-code-session-id': 's',
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'user-agent': 'claude-cli',
        'x-app': 'cli',
        'x-forwarded-for': '1.2.3.4',
      }),
    ).toEqual({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'a,b',
      'x-stainless-retry-count': '0',
      'x-claude-code-session-id': 's',
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-encoding': 'gzip',
      'user-agent': 'claude-cli',
      'x-app': 'cli',
    });
  });
});

describe('request bodies', () => {
  const msg = (extra: Record<string, unknown>) => ({ model: 'sonnet', messages: [], ...extra });
  const table: [string, unknown, boolean, string | null][] = [
    ['a plain turn', msg({}), false, null],
    [
      'tool_search (no egress)',
      msg({ tools: [{ type: 'tool_search_tool_regex_20251119' }] }),
      false,
      null,
    ],
    [
      'remote MCP servers',
      msg({ mcp_servers: [{ url: 'https://evil.example/mcp' }] }),
      true,
      'remote MCP servers are not allowed',
    ],
    [
      'web search without network',
      msg({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] }),
      false,
      'the server tool web_search_20250305 needs sandbox.network "allowlist"',
    ],
    [
      'web search with an allowlist',
      msg({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] }),
      true,
      null,
    ],
    [
      'web fetch without network',
      msg({ tools: [{ type: 'web_fetch_20250910' }] }),
      false,
      'the server tool web_fetch_20250910 needs sandbox.network "allowlist"',
    ],
    [
      'an image from a URL',
      msg({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://evil.example/?d=secret' } },
            ],
          },
        ],
      }),
      true,
      'URL content sources are not allowed',
    ],
    [
      'a document URL inside a tool result',
      msg({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                content: [{ type: 'document', source: { type: 'url', url: 'https://x' } }],
              },
            ],
          },
        ],
      }),
      true,
      'URL content sources are not allowed',
    ],
    [
      'text that merely mentions a url',
      msg({ messages: [{ role: 'user', content: 'type url https://x' }] }),
      false,
      null,
    ],
    ['not an object', [1, 2], false, 'the request body must be a JSON object'],
  ];
  for (const [name, body, webTools, reason] of table) {
    it(`${name} → ${reason ?? 'forwarded'}`, () => {
      expect(bodyRefusal(body, { webTools })).toBe(reason);
    });
  }
});

describe('upstream base URL', () => {
  it('takes https, or http to a loopback gateway, and keeps a path prefix', () => {
    expect(parseUpstream('https://api.anthropic.com').prefix).toBe('');
    expect(parseUpstream('https://gw.example/anthropic/').prefix).toBe('/anthropic');
    expect(parseUpstream('http://127.0.0.1:4000').url.port).toBe('4000');
    expect(parseUpstream('http://localhost:4000').url.hostname).toBe('localhost');
    expect(parseUpstream('http://[::1]:4000').url.hostname).toBe('[::1]');
  });

  it('refuses plain http to another machine and URLs with credentials', () => {
    for (const bad of [
      'http://gateway.internal',
      'http://10.0.0.5:4000',
      'https://user:pass@gw.example',
      'https://gw.example/?key=1',
      'not a url',
    ]) {
      expect(() => parseUpstream(bad), bad).toThrow(OrbitError);
    }
  });
});

describe('key-injecting API proxy', () => {
  it('replaces the container credentials with the real key and forwards only the API protocol', async () => {
    const up = await upstream();
    const { socketPath, proxy } = await proxyFor(`${up.base}/gw`);
    const r = await call(socketPath);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"type":"message"}');
    expect(r.headers['request-id']).toBe('req_1');
    expect(up.seen).toHaveLength(1);
    const seen = up.seen[0]!;
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/gw/v1/messages?beta=true');
    expect(seen.headers['x-api-key']).toBe(KEY);
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers['proxy-authorization']).toBeUndefined();
    expect(seen.headers.host).toBe(new URL(up.base).host);
    expect(seen.headers['anthropic-beta']).toBe('claude-code-20250219');
    expect(seen.headers['x-claude-code-session-id']).toBe('sess-1');
    expect(JSON.parse(seen.body)).toEqual({ model: 'sonnet', messages: [], max_tokens: 1 });
    expect(proxy.stats()).toMatchObject({ forwarded: 1, refused: 0, failed: 0 });
  });

  it('refuses other routes and risky bodies with 403 without contacting the upstream', async () => {
    const up = await upstream();
    const { socketPath, proxy } = await proxyFor(up.base);
    const files = await call(socketPath, { path: '/v1/files' });
    expect(files.status).toBe(403);
    expect(JSON.parse(files.body)).toEqual({
      type: 'error',
      error: {
        type: 'permission_error',
        message: 'Orbit: POST /v1/files is not an API route Orbit forwards',
      },
    });
    const models = await call(socketPath, { method: 'GET', path: '/v1/models?limit=5' });
    expect(models.status).toBe(403);
    const mcp = await call(socketPath, {
      body: JSON.stringify({ model: 'sonnet', messages: [], mcp_servers: [{ url: 'https://x' }] }),
    });
    expect(mcp.status).toBe(403);
    expect(mcp.body).toMatch(/remote MCP servers/);
    const notJson = await call(socketPath, { body: 'not json' });
    expect(notJson.status).toBe(400);
    expect(up.seen).toEqual([]);
    const stats = proxy.stats();
    expect(stats.refused).toBe(4);
    // Refusals name the route, never the query string, a header or the key.
    expect(stats.recent.map((r) => r.target)).toEqual([
      'POST /v1/files',
      'GET /v1/models',
      'POST /v1/messages',
      'POST /v1/messages',
    ]);
    expect(JSON.stringify(stats)).not.toMatch(/limit=5|placeholder|REALKEY/);
    for (const r of [files, models, mcp, notJson]) expect(r.body).not.toContain(KEY);
  });

  it("answers the engine's HEAD /api/hello warm-up itself (never forwarded, not a refusal)", async () => {
    const up = await upstream();
    const { socketPath, proxy } = await proxyFor(up.base);
    const r = await call(socketPath, { method: 'HEAD', path: '/api/hello', body: '' });
    expect(r.status).toBe(200);
    expect(up.seen).toEqual([]);
    expect(proxy.stats()).toMatchObject({ forwarded: 0, refused: 0, failed: 0 });
    // Any other /api path is refused.
    expect((await call(socketPath, { method: 'GET', path: '/api/hello' })).status).toBe(403);
  });

  it('refuses requests while no Run of the Bot is active', async () => {
    const up = await upstream();
    const { socketPath, armed } = await proxyFor(up.base);
    armed.value = false;
    const r = await call(socketPath);
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/no Run of this Bot is active/);
    expect(up.seen).toEqual([]);
  });

  it('bounds request bodies (declared and streamed)', async () => {
    const up = await upstream();
    const { socketPath } = await proxyFor(up.base, { maxBodyBytes: 1024 });
    const big = JSON.stringify({
      model: 'sonnet',
      messages: [{ role: 'user', content: 'x'.repeat(2048) }],
    });
    const declared = await call(socketPath, { body: big });
    expect(declared.status).toBe(413);
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(big.slice(0, 1000));
      req.end(big.slice(1000));
    });
    expect(chunked).toBe(413);
    expect(up.seen).toEqual([]);
  });

  it('streams server-sent events back as they arrive', async () => {
    let finish: () => void = () => undefined;
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      finish = () => {
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      };
    });
    const { socketPath } = await proxyFor(up.base);
    const first = await new Promise<{ chunk: string; rest: Promise<string> }>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          res.setEncoding('utf8');
          res.once('data', (chunk: string) => {
            let rest = '';
            res.on('data', (c: string) => (rest += c));
            resolve({ chunk, rest: new Promise((r) => res.on('end', () => r(rest))) });
          });
        },
      );
      req.on('error', reject);
      req.end('{"model":"sonnet","messages":[],"stream":true}');
    });
    // The first event arrived while the upstream response is still open.
    expect(first.chunk).toBe('event: message_start\ndata: {"type":"message_start"}\n\n');
    finish();
    expect(await first.rest).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });

  it('stops the upstream request when the engine goes away, and when the Run ends', async () => {
    let upstreamClosed: () => void = () => undefined;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const up = await upstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {}\n\n');
      req.socket.once('close', () => upstreamClosed());
    });
    const { socketPath, proxy } = await proxyFor(up.base);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.once('data', () => {
            proxy.dropConnections();
            resolve();
          });
        },
      );
      req.on('error', () => undefined);
      req.end('{"model":"sonnet","messages":[]}');
      setTimeout(() => reject(new Error('no data')), 5000);
    });
    await closed;
  });

  it('asks the key source for a fresh key after a 401', async () => {
    const keys = ['sk-ant-old', 'sk-ant-new'];
    let invalidated = 0;
    const source: ApiKeySource = {
      get: () => Promise.resolve(keys[invalidated] ?? null),
      invalidate: () => {
        invalidated += 1;
      },
    };
    const up = await upstream((req, res) => {
      const ok = req.headers['x-api-key'] === 'sk-ant-new';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(ok ? '{}' : '{"type":"error","error":{"type":"authentication_error"}}');
    });
    const { socketPath } = await proxyFor(up.base, { key: source });
    expect((await call(socketPath)).status).toBe(401);
    expect(invalidated).toBe(1);
    expect((await call(socketPath)).status).toBe(200);
  });

  it('answers 503 without a key and 502 when the key or the upstream is unavailable — never with the key', async () => {
    const up = await upstream();
    const none = await proxyFor(up.base, { key: null });
    const noKey = await call(none.socketPath);
    expect(noKey.status).toBe(503);
    expect(noKey.body).toMatch(/no API key/);

    const failing: ApiKeySource = {
      get: () =>
        Promise.reject(new OrbitError('auth_required', 'The API key helper exited with code 1')),
      invalidate: () => undefined,
    };
    const helper = await proxyFor(up.base, { key: failing });
    const helperDown = await call(helper.socketPath);
    expect(helperDown.status).toBe(502);
    expect(helperDown.body).toMatch(/API key helper exited with code 1/);
    expect(up.seen).toEqual([]);

    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const { port } = dead.address() as AddressInfo;
    dead.close();
    const unreachable = await proxyFor(`http://127.0.0.1:${port}`);
    const down = await call(unreachable.socketPath);
    expect(down.status).toBe(502);
    expect(down.body).toMatch(/could not be reached/);
    for (const r of [noKey, helperDown, down]) expect(r.body).not.toContain(KEY);
    expect(unreachable.proxy.stats()).toMatchObject({ forwarded: 0, failed: 1 });
  });

  it('refuses CONNECT tunnels through the API socket', async () => {
    const up = await upstream();
    const { socketPath, proxy } = await proxyFor(up.base);
    const status = await new Promise<string>((resolve) => {
      const req = request({ socketPath, method: 'CONNECT', path: 'evil.example:443' });
      req.on('connect', (res) => resolve(String(res.statusCode)));
      req.on('error', () => resolve('closed'));
      req.end();
    });
    expect(status).toBe('closed');
    expect(proxy.stats().recent.at(-1)?.reason).toMatch(/does not tunnel/);
  });

  const openssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!openssl)('forwards over TLS to an https upstream', async () => {
    const dir = mkdtempSync(join(root, 'tls-'));
    const r = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore', timeout: 30_000 },
    );
    expect(r.status).toBe(0);
    const cert = readFileSync(join(dir, 'cert.pem'));
    const server = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert });
    const up = await upstream(undefined, server);
    const base = up.base.replace(/^http:/, 'https:');
    const verified = await proxyFor(base, { ca: cert });
    expect((await call(verified.socketPath)).status).toBe(200);
    expect(up.seen[0]?.headers['x-api-key']).toBe(KEY);
    // Without the CA the certificate is not trusted: the key is never sent.
    const untrusted = await proxyFor(base);
    const refused = await call(untrusted.socketPath);
    expect(refused.status).toBe(502);
    expect(up.seen).toHaveLength(1);
  });
});
