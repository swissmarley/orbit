import { createHash, randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  type ApiForwarder,
  type ApiProxyOptions,
  type Upstream,
  apiError,
  createApiForwarder,
  parseUpstream,
} from './api-proxy';
import type { ApiKeySource } from './key-source';
import { Counters, type ProxyCounters, type ProxyRefusal } from './stats';

/** The host key proxy listens here only: other machines can never reach it. */
export const HOST_KEY_PROXY_ADDRESS = '127.0.0.1';

/** 32 random bytes, base64url: the first path segment of a segment's base URL. */
const TOKEN = /^\/([A-Za-z0-9_-]{43})(\/.*)?$/s;

export interface HostKeyProxyOptions {
  /** orbitd's API base URL (ANTHROPIC_BASE_URL, default https://api.anthropic.com). */
  upstream: string;
  key: ApiKeySource;
  /** Test hooks for the API upstream (self-signed CA, custom agent, body limit). */
  api?: Pick<ApiProxyOptions, 'ca' | 'agent' | 'maxBodyBytes'>;
  onRefusal?: (r: ProxyRefusal) => void;
  now?: () => Date;
}

/** One Run segment's access to the key proxy. */
export interface HostKeyLease {
  /**
   * The engine's ANTHROPIC_BASE_URL: `http://127.0.0.1:<port>/<token>`. The
   * token is the segment's credential for the proxy; register it with the
   * redactor and never show it.
   */
  baseUrl: string;
  token: string;
  /** Stop forwarding for this segment at once and cut its requests. Idempotent. */
  close(): void;
}

/** What the host key proxy did since orbitd started (doctor). */
export interface HostKeyProxyStatus {
  /** The loopback port, or null while no segment has opened it yet. */
  port: number | null;
  /** Run segments whose token works right now. */
  activeSegments: number;
  api: ProxyCounters;
}

interface Lease {
  forwarder: ApiForwarder;
  closed: boolean;
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * orbitd's key proxy for SDK engines on the host (ADR-018, amended): one
 * loopback TCP listener per daemon; each Run segment gets its own random
 * path token, and only requests that carry a live token are forwarded — with
 * the real key injected and the token stripped from the forwarded path. The
 * engine holds a placeholder key, so no secret remains in its environment
 * (or its children's). Other local users and processes can connect to the
 * port but cannot spend the key without a segment's token, and a token dies
 * with its segment.
 */
export class HostKeyProxy {
  private readonly upstream: Upstream;
  private readonly counters: Counters;
  /** Live segments by sha256 of their token: a lookup never compares the secret itself. */
  private readonly leases = new Map<string, Lease>();
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private listening: Promise<number> | null = null;
  private port: number | null = null;

  constructor(private readonly opts: HostKeyProxyOptions) {
    this.upstream = parseUpstream(opts.upstream);
    this.counters = new Counters(opts.now, opts.onRefusal);
  }

  /** Give a Run segment its token (the listener starts with the first segment). */
  async open(): Promise<HostKeyLease> {
    const port = await this.listen();
    const token = randomBytes(32).toString('base64url');
    const id = digest(token);
    const lease: Lease = {
      closed: false,
      forwarder: createApiForwarder({
        upstream: this.upstream,
        key: this.opts.key,
        armed: () => !lease.closed,
        idleReason: 'the Run segment of this token has ended',
        // A host engine has the host's network anyway: refusing the API's own
        // web tools would take WebSearch away without closing a path (ADR-018).
        webTools: () => true,
        counters: this.counters,
        ...this.opts.api,
      }),
    };
    this.leases.set(id, lease);
    return {
      baseUrl: `http://${HOST_KEY_PROXY_ADDRESS}:${port}/${token}`,
      token,
      close: () => {
        if (lease.closed) return;
        lease.closed = true;
        this.leases.delete(id);
        lease.forwarder.drop();
      },
    };
  }

  status(): HostKeyProxyStatus {
    return { port: this.port, activeSegments: this.leases.size, api: this.counters.snapshot() };
  }

  /** Stop forwarding for every segment and stop listening (orbitd shutdown). */
  async close(): Promise<void> {
    for (const lease of this.leases.values()) {
      lease.closed = true;
      lease.forwarder.drop();
    }
    this.leases.clear();
    const server = this.server;
    this.server = null;
    this.listening = null;
    this.port = null;
    for (const s of this.sockets) s.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    const m = TOKEN.exec(req.url ?? '/');
    const rest = m?.[2] ?? '/';
    const lease = m === null ? undefined : this.leases.get(digest(m[1] ?? ''));
    // A browser page cannot use the proxy, even with a token it guessed or leaked.
    const refusal =
      req.headers.origin !== undefined
        ? 'browser requests are refused'
        : m === null
          ? 'the request has no segment token'
          : null;
    if (refusal !== null || lease === undefined) {
      const reason = refusal ?? 'the segment token is unknown or has expired';
      // The target never carries the token, a query string or a header.
      const path = m === null ? '/…' : (rest.split('?')[0] ?? '/').slice(0, 200);
      this.counters.refuse(`${method} ${path}`, reason);
      res.setHeader('connection', 'close');
      apiError(res, 403, 'permission_error', reason);
      req.resume();
      return;
    }
    lease.forwarder.handle(req, res, rest);
  }

  private listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.on('connection', (s: Socket) => {
        this.sockets.add(s);
        s.once('close', () => this.sockets.delete(s));
      });
      // No CONNECT tunnels and no upgrades through the key proxy.
      server.on('connect', (_req: IncomingMessage, socket: Socket) => {
        this.counters.refuse('CONNECT', 'the key proxy does not tunnel');
        socket.destroy();
      });
      server.on('upgrade', (_req: IncomingMessage, socket: Socket) => {
        this.counters.refuse('UPGRADE', 'the key proxy does not upgrade connections');
        socket.destroy();
      });
      server.once('error', (err) => {
        this.listening = null;
        reject(err);
      });
      server.listen(0, HOST_KEY_PROXY_ADDRESS, () => {
        server.unref();
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
    return this.listening;
  }
}
