import { type IncomingHttpHeaders, createServer, request as httpRequest } from 'node:http';
import { type Socket, connect } from 'node:net';

/**
 * The browser's only way out: a loopback HTTP proxy in the plugin process that
 * checks the host of every request and tunnel against the allowlist before it
 * connects anywhere. Chromium is launched with `--proxy-server` pointing here
 * and `--proxy-bypass-list=<-loopback>` (loopback too), so redirects, worker
 * requests and anything else Playwright's request routing does not see are
 * checked as well. An owner proxy from the environment (HTTPS_PROXY, …) is
 * chained behind it.
 */

export interface FilterProxyOptions {
  /** May the browser reach this URL (http://host:port/… or https://host:port/ for a tunnel)? */
  allowed(url: string): boolean;
  /** Called with the host of each refused request. */
  onBlocked(host: string): void;
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
    const host = hostOf(target);
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
  });

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
    const host = hostOf(target);
    const port = Number(target.port || 443);
    const proxied = viaUpstream(host) && upstream;
    const out = proxied ? connect(upstream.port, upstream.host) : connect(port, host);
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
    });
    out.on('error', () => socket.destroy());
    socket.on('error', () => out.destroy());
  });

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
