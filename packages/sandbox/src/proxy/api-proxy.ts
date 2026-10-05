import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
  type Agent as HttpAgent,
  createServer,
  request as httpRequest,
} from 'node:http';
import { type Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { OrbitError } from '@orbit/core';
import { blockedAddressReason } from './addresses';
import type { ProxyServer } from './egress-proxy';
import type { ApiKeySource } from './key-source';
import { Counters, type ProxyCounters, type ProxyRefusal } from './stats';

/**
 * The Anthropic API routes the engine uses (verified against Claude Code
 * 2.1.289 / Agent SDK 0.3.289 with a recording upstream, ADR-018): model
 * turns and token counting. `?beta=true` is the only query the engine sends.
 * Everything else — batches, files, models, skills, admin, `/api/*` — is
 * refused.
 */
export const API_ROUTES: readonly { method: string; path: string }[] = [
  { method: 'POST', path: '/v1/messages' },
  { method: 'POST', path: '/v1/messages/count_tokens' },
];

/** Requests the API accepts are at most 32 MB; larger bodies are refused unread. */
export const MAX_API_BODY_BYTES = 32 * 1024 * 1024;

/** Request headers forwarded upstream; everything else (auth, cookies, proxy headers) is dropped. */
const FORWARD_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'content-type',
  'user-agent',
  'x-app',
]);
const FORWARD_PREFIXES: readonly string[] = ['anthropic-', 'x-stainless-', 'x-claude-code-'];

/** Response headers a proxy must not copy back. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
]);

/** Is `METHOD url` one of the API_ROUTES (with no query or exactly `?beta=true`)? */
export function apiRouteAllowed(method: string, url: string): boolean {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q + 1);
  if (query !== '' && query !== 'beta=true') return false;
  return API_ROUTES.some((r) => r.method === method && r.path === path);
}

/** The headers sent upstream: the allowlisted ones, never the container's credentials. */
export function forwardRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const n = name.toLowerCase();
    if (FORWARD_HEADERS.has(n) || FORWARD_PREFIXES.some((p) => n.startsWith(p))) {
      out[n] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return out;
}

function forwardResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/** Server tools that make the API fetch from the internet on the caller's behalf. */
const WEB_TOOL = /^web_(search|fetch)_/;

/**
 * Why a request body must not reach the API, or null. Inside a container the
 * API socket is reachable by any process (Bash included), so the proxy keeps
 * the API from becoming a general network path: remote MCP servers and
 * URL-sourced content are always refused; server-side web search/fetch only
 * when the Bot's network is `none` (with an allowlist, Bash needs approval).
 */
export function bodyRefusal(body: unknown, opts: { webTools: boolean }): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'the request body must be a JSON object';
  }
  const b = body as Record<string, unknown>;
  if (b.mcp_servers !== undefined) return 'remote MCP servers are not allowed';
  if (!opts.webTools && Array.isArray(b.tools)) {
    for (const t of b.tools as unknown[]) {
      const type = typeof t === 'object' && t !== null ? (t as { type?: unknown }).type : null;
      if (typeof type === 'string' && WEB_TOOL.test(type)) {
        return `the server tool ${type} needs sandbox.network "allowlist"`;
      }
    }
  }
  // URL sources (images, documents) make the API fetch arbitrary URLs.
  const stack: unknown[] = [b];
  let seen = 0;
  while (stack.length > 0) {
    const v = stack.pop();
    if (++seen > 1_000_000) return 'the request body is too deeply structured';
    if (Array.isArray(v)) {
      stack.push(...(v as unknown[]));
    } else if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>;
      if (o.type === 'url' && typeof o.url === 'string')
        return 'URL content sources are not allowed';
      stack.push(...Object.values(o));
    }
  }
  return null;
}

/** An API-shaped error the engine can show. */
export function apiError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: 'error', error: { type, message: `Orbit: ${message}` } });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export interface Upstream {
  url: URL;
  /** Path prefix of a gateway base URL (`https://gw.example/anthropic`), without a trailing slash. */
  prefix: string;
}

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.']);

/**
 * orbitd's API base URL (ANTHROPIC_BASE_URL, default https://api.anthropic.com).
 * The key travels only over TLS, except to a loopback gateway on the host.
 */
export function parseUpstream(base: string): Upstream {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new OrbitError('invalid_config', 'ANTHROPIC_BASE_URL is not a valid URL', {
      hint: 'Set ANTHROPIC_BASE_URL to an https:// URL, or unset it to use https://api.anthropic.com.',
    });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback =
    LOOPBACK_NAMES.has(host) || (isIP(host) !== 0 && blockedAddressReason(host) === 'loopback');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new OrbitError(
      'invalid_config',
      "Orbit's key proxy sends the API key only over https (or to a loopback gateway)",
      { hint: 'Set ANTHROPIC_BASE_URL to an https:// URL, or unset it.' },
    );
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new OrbitError(
      'invalid_config',
      'ANTHROPIC_BASE_URL must not carry credentials, a query or a fragment',
      { hint: 'Use a plain base URL such as https://api.anthropic.com.' },
    );
  }
  return { url, prefix: url.pathname.replace(/\/+$/, '') };
}

export interface ApiProxyOptions {
  upstream: Upstream;
  /** Null when orbitd has no API key (mock mode): every request gets a 503. */
  key: ApiKeySource | null;
  /** True while a Run of the Bot is active; requests are refused otherwise. */
  armed: () => boolean;
  /** The refusal while not armed (default: no Run of this Bot is active). */
  idleReason?: string;
  /** Server-side web tools allowed (the Bot's network is an allowlist). */
  webTools: () => boolean;
  maxBodyBytes?: number;
  /** For tests: the CA of a self-signed upstream, or a custom agent. */
  ca?: string | Buffer;
  agent?: HttpAgent | HttpsAgent;
  onRefusal?: (r: ProxyRefusal) => void;
  now?: () => Date;
  /** Counters shared with other forwarders (default: this proxy's own). */
  counters?: Counters;
}

/** The request handling of a key-injecting API proxy, without a listener of its own. */
export interface ApiForwarder {
  /**
   * Answer one request. `url` is the API path and query the engine asked for
   * (default `req.url`; the host key proxy passes it without the segment token).
   */
  handle(req: IncomingMessage, res: ServerResponse, url?: string): void;
  /** Abort every request being handled: upstream requests and their clients' connections. */
  drop(): void;
  stats(): ProxyCounters;
}

/**
 * Forwards API requests with the real key (ADR-018): only API_ROUTES, with
 * the client's credential headers dropped, the key injected and the response
 * streamed back unbuffered. It never logs bodies or headers, and its error
 * messages never contain the key.
 */
export function createApiForwarder(opts: ApiProxyOptions): ApiForwarder {
  const counters = opts.counters ?? new Counters(opts.now, opts.onRefusal);
  const maxBody = opts.maxBodyBytes ?? MAX_API_BODY_BYTES;
  const { url: base, prefix } = opts.upstream;
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  /** Requests being handled; a Run's end (drop) cuts them wherever they are. */
  const inflight = new Set<{ destroy(): void }>();

  const refuse = (res: ServerResponse, target: string, status: number, reason: string): void => {
    counters.refuse(target, reason);
    apiError(res, status, status === 413 ? 'request_too_large' : 'permission_error', reason);
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    entry: { upstream: { destroy(): void } | null },
  ): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = url.split('?')[0] ?? '/';
    const target = `${method} ${path.slice(0, 200)}`;
    // The engine's connection warm-up (sent when no HTTPS_PROXY is set):
    // answered here, never forwarded, and not worth a refusal entry.
    if (method === 'HEAD' && url === '/api/hello') {
      req.resume();
      res.writeHead(200, { 'content-length': 0 });
      res.end();
      return;
    }
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > maxBody) {
      res.setHeader('connection', 'close');
      refuse(res, target, 413, `request bodies are limited to ${maxBody} bytes`);
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const tooLarge = await new Promise<boolean>((resolve, reject) => {
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) chunks.length = 0;
        else chunks.push(c);
      });
      req.once('end', () => resolve(size > maxBody));
      req.once('error', reject);
    });
    // Refusals come after the body is read (and bounded), so the client sees
    // the answer instead of a broken pipe.
    if (tooLarge) {
      refuse(res, target, 413, `request bodies are limited to ${maxBody} bytes`);
      return;
    }
    // Checked after the body arrived, so a Run that ended meanwhile forwards nothing.
    if (!opts.armed()) {
      refuse(res, target, 403, opts.idleReason ?? 'no Run of this Bot is active');
      return;
    }
    if (!apiRouteAllowed(method, url)) {
      refuse(res, target, 403, `${method} ${path} is not an API route Orbit forwards`);
      return;
    }
    const body = Buffer.concat(chunks);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      refuse(res, target, 400, 'the request body is not JSON');
      return;
    }
    const refusal = bodyRefusal(parsed, { webTools: opts.webTools() });
    if (refusal !== null) {
      refuse(res, target, 403, refusal);
      return;
    }

    let key: string | null;
    try {
      key = opts.key === null ? null : await opts.key.get();
    } catch (err) {
      counters.fail();
      // OrbitErrors from the key source never carry the key or the helper's output.
      apiError(
        res,
        502,
        'api_error',
        err instanceof OrbitError ? err.message : 'the API key is unavailable',
      );
      return;
    }
    if (key === null) {
      counters.fail();
      apiError(res, 503, 'api_error', 'orbitd has no API key to send');
      return;
    }

    const headers: Record<string, string | number> = {
      ...forwardRequestHeaders(req.headers),
      'x-api-key': key,
      'content-length': body.length,
      host: base.host,
    };
    const upstream = send(
      {
        protocol: base.protocol,
        hostname: base.hostname.replace(/^\[|\]$/g, ''),
        port: base.port === '' ? undefined : Number(base.port),
        method,
        path: `${prefix}${url}`,
        headers,
        ...(opts.ca !== undefined ? { ca: opts.ca } : {}),
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      },
      (upRes) => {
        const status = upRes.statusCode ?? 502;
        if (status === 401) opts.key?.invalidate();
        counters.ok();
        res.writeHead(status, forwardResponseHeaders(upRes.headers));
        // Server-sent events go back as they arrive.
        res.flushHeaders();
        upRes.pipe(res);
        upRes.once('error', () => res.destroy());
      },
    );
    entry.upstream = upstream;
    upstream.once('error', () => {
      if (!res.headersSent) {
        counters.fail();
        apiError(res, 502, 'api_error', `the API at ${base.host} could not be reached`);
      } else {
        res.destroy();
      }
    });
    // The engine gave up (abort, stop): stop the upstream request too.
    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.end(body);
  };

  return {
    handle: (req, res, url = req.url ?? '/') => {
      const entry: { upstream: { destroy(): void } | null; destroy(): void } = {
        upstream: null,
        destroy: () => {
          entry.upstream?.destroy();
          res.destroy();
        },
      };
      inflight.add(entry);
      res.once('close', () => inflight.delete(entry));
      handle(req, res, url, entry).catch(() => {
        apiError(res, 500, 'api_error', 'internal proxy error');
      });
    },
    drop: () => {
      for (const r of [...inflight]) r.destroy();
    },
    stats: () => counters.snapshot(),
  };
}

/**
 * The host-side key-injecting API proxy of a container Bot (ADR-018), bound
 * by its caller to a Unix socket. The container's engine talks to it with a
 * placeholder key; see createApiForwarder for what is forwarded.
 */
export function createApiProxy(opts: ApiProxyOptions): ProxyServer {
  const counters = opts.counters ?? new Counters(opts.now, opts.onRefusal);
  const forwarder = createApiForwarder({ ...opts, counters });
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => forwarder.handle(req, res));
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  // No CONNECT tunnels and no upgrades through the API socket.
  server.on('connect', (_req: IncomingMessage, socket: Socket) => {
    counters.refuse('CONNECT', 'the API socket does not tunnel');
    socket.destroy();
  });
  server.on('upgrade', (_req: IncomingMessage, socket: Socket) => {
    counters.refuse('UPGRADE', 'the API socket does not upgrade connections');
    socket.destroy();
  });

  return {
    server,
    stats: () => counters.snapshot(),
    dropConnections: () => {
      forwarder.drop();
      for (const s of sockets) s.destroy();
    },
  };
}
