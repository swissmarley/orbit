import { lookup } from 'node:dns/promises';
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from 'node:http';
import { type LookupFunction, type Socket, connect, isIP } from 'node:net';

/**
 * The browser's only way out: a loopback HTTP proxy in the plugin process that
 * checks the host of every request and tunnel against the allowlist before it
 * connects anywhere. Chromium is launched with `--proxy-server` pointing here
 * and `--proxy-bypass-list=<-loopback>` (loopback too), so redirects, worker
 * requests and anything else Playwright's request routing does not see are
 * checked as well. An owner proxy from the environment (HTTPS_PROXY, …) is
 * chained behind it.
 *
 * Names are resolved here, once (ADR-019): every address an allowed name
 * resolves to must pass `addressAllowed` (no private, loopback, link-local or
 * metadata answers unless the owner says so), and the connection goes to
 * exactly the addresses that were checked — never a second lookup, so a DNS
 * rebinding answer cannot slip in between check and connect.
 */

/** A resolver: every address of a name (injectable for tests). */
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

export interface FilterProxyOptions {
  /** May the browser reach this URL (http://host:port/… or https://host:port/ for a tunnel)? */
  allowed(url: string): boolean;
  /** Called with the host of each refused request (and why, when its address was refused). */
  onBlocked(host: string, reason?: string): void;
  /** Null when the browser may reach `address` for `host`, else why not. */
  addressAllowed?: (address: string, host: string) => string | null;
  resolve?: Resolver;
  /** The owner's proxy, if any. */
  upstream?: { server: string; bypass?: string } | undefined;
}

export interface FilterProxy {
  port: number;
  close(): Promise<void>;
}

/** NO_PROXY matching: exact hosts, `.suffix` / `*.suffix` entries, and `*`. CIDR entries are ignored. */
export function bypassesUpstream(bypass: string | undefined, host: string): boolean {
  if (!bypass) return false;
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bypass
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((e) => {
      if (e === '*') return true;
      const noPort = e.split(':').length === 2 ? e.replace(/:\d+$/, '') : e; // IPv6 has more colons
      const name = noPort.replace(/^\[|\]$/g, '').replace(/^\*?\./, '');
      return (
        h === name || (e.startsWith('.') || e.startsWith('*.') ? h.endsWith(`.${name}`) : false)
      );
    });
}

const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, '');

function upstreamOf(server: string): { host: string; port: number; auth?: string } | undefined {
  let u: URL;
  try {
    u = new URL(server.includes('://') ? server : `http://${server}`);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:') return undefined; // only plain HTTP proxies are chained
  const auth =
    u.username || u.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`
      : undefined;
  return { host: hostOf(u), port: Number(u.port || 80), ...(auth ? { auth } : {}) };
}

/** Hop-by-hop headers a proxy must not forward. */
const HOP = [
  'proxy-connection',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
];

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP.includes(k)) out[k] = v;
  return out;
}

/** A `lookup` that answers with the addresses already checked (no second resolution). */
export function pinnedLookup(
  addresses: readonly { address: string; family: number }[],
): LookupFunction {
  return (_host, options, callback) => {
    const first = addresses[0];
    if (!first) {
      callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    if (options.all)
      callback(
        null,
        addresses.map((a) => ({ address: a.address, family: a.family })),
      );
    else callback(null, first.address, first.family);
  };
}

type Checked =
  | { ok: true; addresses: { address: string; family: number }[] | null }
  | { ok: false; reason: string };

/**
 * Resolve `host` and check every answer. Direct connections need answers;
 * through the owner's upstream proxy (which resolves for itself) a name that
 * does not resolve here is passed on, but a private answer is still refused.
 */
export async function checkHost(
  host: string,
  opts: Pick<FilterProxyOptions, 'addressAllowed' | 'resolve'>,
  viaUpstream: boolean,
): Promise<Checked> {
  const allowed = opts.addressAllowed ?? (() => null);
  if (isIP(host)) {
    const why = allowed(host, host);
    return why === null
      ? { ok: true, addresses: [{ address: host, family: isIP(host) }] }
      : { ok: false, reason: why };
  }
  let answers: { address: string; family: number }[];
  try {
    answers = await (opts.resolve ?? systemResolver)(host);
  } catch {
    answers = [];
  }
  if (answers.length === 0) {
    return viaUpstream
      ? { ok: true, addresses: null }
      : { ok: false, reason: `${host} does not resolve` };
  }
  for (const a of answers) {
    const why = allowed(a.address, host);
    if (why !== null) return { ok: false, reason: why };
  }
  return { ok: true, addresses: answers };
}

export async function startFilterProxy(opts: FilterProxyOptions): Promise<FilterProxy> {
  const upstream = opts.upstream ? upstreamOf(opts.upstream.server) : undefined;
  const viaUpstream = (host: string) =>
    upstream !== undefined && !bypassesUpstream(opts.upstream?.bypass, host);
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  };

  const server = createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:' || !opts.allowed(target.href)) {
      opts.onBlocked(target.hostname);
      // No response at all: the browser sees a network error, not a page on that host.
      req.socket.destroy();
      return;
    }
    req.pause();
    void forward(req, res, target);
  });

  const forward = async (req: IncomingMessage, res: ServerResponse, target: URL) => {
    const host = hostOf(target);
    const checked = await checkHost(host, opts, viaUpstream(host));
    if (!checked.ok) {
      opts.onBlocked(target.hostname, checked.reason);
      req.socket.destroy();
      return;
    }
    const headers = forwardHeaders(req.headers);
    const proxied = viaUpstream(host) && upstream;
    if (proxied && upstream.auth) headers['proxy-authorization'] = upstream.auth;
    const out = httpRequest(
      proxied
        ? {
            host: upstream.host,
            port: upstream.port,
            path: target.href,
            method: req.method,
            headers,
          }
        : {
            host,
            port: Number(target.port || 80),
            path: `${target.pathname}${target.search}`,
            method: req.method,
            headers,
            // Exactly the addresses that were checked.
            ...(checked.addresses ? { lookup: pinnedLookup(checked.addresses) } : {}),
          },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, forwardHeaders(upRes.headers));
        upRes.pipe(res);
      },
    );
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(out);
    req.resume();
  };

  server.on('connection', track);

  server.on('connect', (req, socket: Socket, head: Buffer) => {
    const authority = req.url ?? '';
    let target: URL;
    try {
      target = new URL(`https://${authority}/`);
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (!opts.allowed(target.href)) {
      opts.onBlocked(target.hostname);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    socket.pause();
    void tunnel(socket, head, authority, target);
  });

  const tunnel = async (socket: Socket, head: Buffer, authority: string, target: URL) => {
    const host = hostOf(target);
    const port = Number(target.port || 443);
    const checked = await checkHost(host, opts, viaUpstream(host));
    if (!checked.ok) {
      opts.onBlocked(target.hostname, checked.reason);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const proxied = viaUpstream(host) && upstream;
    const out = proxied
      ? connect(upstream.port, upstream.host)
      : connect({
          host,
          port,
          // Exactly the addresses that were checked.
          ...(checked.addresses ? { lookup: pinnedLookup(checked.addresses) } : {}),
        });
    track(out);
    out.once('connect', () => {
      if (proxied) {
        // The upstream's own "200 Connection established" goes straight back to the browser.
        const auth = upstream.auth ? `Proxy-Authorization: ${upstream.auth}\r\n` : '';
        out.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
      } else {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      }
      if (head.length) out.write(head);
      out.pipe(socket);
      socket.pipe(out);
      socket.resume();
    });
    out.on('error', () => socket.destroy());
    socket.on('error', () => out.destroy());
  };

  // A plain ws:// upgrade through the proxy: WebSockets are blocked (see browser.ts).
  server.on('upgrade', (req, socket: Socket) => {
    try {
      opts.onBlocked(new URL(req.url ?? '').hostname);
    } catch {
      opts.onBlocked('(invalid URL)');
    }
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
