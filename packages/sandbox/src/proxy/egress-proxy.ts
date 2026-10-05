import { lookup as dnsLookup } from 'node:dns/promises';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { type Socket, connect, isIP } from 'node:net';
import {
  type ParsedAllowlist,
  addressAllowed,
  blockedAddressReason,
  nameAllowed,
  normalizeHostName,
} from './addresses';
import { Counters, type ProxyCounters, type ProxyRefusal } from './stats';

/** Resolves a host name to every address it has (injected by tests). */
export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

export const systemLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface EgressProxyOptions {
  /** The Bot's current allowlist; read for every tunnel, so spec changes apply at once. */
  allowlist: () => ParsedAllowlist;
  /** True while a Run of the Bot is active; tunnels are refused otherwise. */
  armed: () => boolean;
  lookup?: Lookup;
  connectTimeoutMs?: number;
  /** An open tunnel with no traffic for this long is closed. */
  idleTimeoutMs?: number;
  /** Concurrent tunnels per Bot. */
  maxTunnels?: number;
  onRefusal?: (r: ProxyRefusal) => void;
  now?: () => Date;
}

export interface ProxyServer {
  /** Not listening yet: the caller binds it (a Unix socket for container Bots). */
  server: Server;
  stats(): ProxyCounters;
  /** Close every open connection (a Run ended or orbitd stops). */
  dropConnections(): void;
}

/** `host:port` of a CONNECT request (`[v6]:port` for IPv6), or null when malformed. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(authority);
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  const host = m[1] ?? m[2] ?? '';
  if (m[1] !== undefined && isIP(host) !== 6) return null;
  return { host, port };
}

export type EgressDecision =
  | { allow: true; address: string; family: number }
  | { allow: false; reason: string; status: 403 | 502 };

/**
 * Decide one tunnel (pure apart from the lookup): the name must be
 * allowlisted, and the proxy connects only to an address it checked here —
 * never to a private, loopback, link-local, CGNAT, unique-local, multicast,
 * unspecified or metadata address unless the owner allowlisted that literal
 * address. IP literals must be allowlisted literally.
 */
export async function decideEgress(
  list: ParsedAllowlist,
  host: string,
  port: number,
  lookup: Lookup,
): Promise<EgressDecision> {
  const family = isIP(host);
  if (family !== 0) {
    return addressAllowed(list.rules, host, port)
      ? { allow: true, address: host, family }
      : { allow: false, status: 403, reason: 'address is not on the allowlist' };
  }
  const name = normalizeHostName(host);
  if (name === null) return { allow: false, status: 403, reason: 'not a valid host name' };
  if (!nameAllowed(list.rules, name, port)) {
    return { allow: false, status: 403, reason: 'host is not on the allowlist' };
  }
  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(name);
  } catch {
    return { allow: false, status: 502, reason: 'host name did not resolve' };
  }
  let blocked: string | null = null;
  for (const a of answers) {
    if (addressAllowed(list.rules, a.address, port)) return { allow: true, ...a };
    const why = blockedAddressReason(a.address);
    if (why === null) return { allow: true, ...a };
    blocked ??= why;
  }
  return blocked === null
    ? { allow: false, status: 502, reason: 'host name did not resolve' }
    : { allow: false, status: 403, reason: `host resolves to a ${blocked} address` };
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

function reply(socket: Socket, status: number, message: string): void {
  const body = `Orbit egress proxy: ${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

/** `host:port` of a plain-HTTP proxy request, without path or query. */
function plainTarget(req: IncomingMessage): string {
  try {
    const u = new URL(req.url ?? '');
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return '(invalid URL)';
  }
}

/**
 * A container Bot's only way to the network (ADR-018): an HTTP CONNECT proxy
 * on the host, reached from inside the container through a Unix socket.
 * Only HTTPS tunnels to allowlisted hosts are opened; plain-HTTP proxying,
 * upgrades and everything else are refused. Every refusal is counted.
 */
export function createEgressProxy(opts: EgressProxyOptions): ProxyServer {
  const lookup = opts.lookup ?? systemLookup;
  const counters = new Counters(opts.now, opts.onRefusal);
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
  const maxTunnels = opts.maxTunnels ?? 64;
  const sockets = new Set<Socket>();
  const track = (s: Socket): void => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  };
  let tunnels = 0;

  const server = createServer((req, res) => {
    counters.refuse(plainTarget(req), 'only HTTPS tunnels (CONNECT) are allowed');
    res.writeHead(405, { 'content-type': 'text/plain', connection: 'close' });
    res.end('Orbit egress proxy: only HTTPS tunnels (CONNECT) are allowed\n');
  });
  server.on('connection', track);

  server.on('upgrade', (req, socket: Socket) => {
    counters.refuse(plainTarget(req), 'only HTTPS tunnels (CONNECT) are allowed');
    reply(socket, 405, 'only HTTPS tunnels (CONNECT) are allowed');
  });

  server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const authority = req.url ?? '';
    const target = parseAuthority(authority);
    if (target === null) {
      counters.refuse('(malformed)', 'malformed CONNECT target');
      reply(socket, 400, 'malformed CONNECT target');
      return;
    }
    const label = `${target.host}:${target.port}`;
    if (!opts.armed()) {
      counters.refuse(label, 'no Run of this Bot is active');
      reply(socket, 403, 'no Run of this Bot is active');
      return;
    }
    if (tunnels >= maxTunnels) {
      counters.refuse(label, `more than ${maxTunnels} open tunnels`);
      reply(socket, 503, `more than ${maxTunnels} open tunnels`);
      return;
    }
    tunnels += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      tunnels -= 1;
    };
    socket.once('close', release);

    void decideEgress(opts.allowlist(), target.host, target.port, lookup).then((d) => {
      if (socket.destroyed) return;
      if (!d.allow) {
        if (d.status === 403) counters.refuse(label, d.reason);
        else counters.fail();
        reply(socket, d.status, `${label} refused: ${d.reason}`);
        return;
      }
      // Connect to the address checked above: no second lookup can swap it.
      const out = connect({ host: d.address, port: target.port, family: d.family });
      track(out);
      let connected = false;
      const timer = setTimeout(() => {
        out.destroy(new Error('connect timeout'));
      }, connectTimeoutMs);
      out.once('connect', () => {
        clearTimeout(timer);
        connected = true;
        counters.ok();
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) out.write(head);
        out.setTimeout(idleTimeoutMs, () => out.destroy());
        socket.setTimeout(idleTimeoutMs, () => socket.destroy());
        out.pipe(socket);
        socket.pipe(out);
      });
      out.once('error', () => {
        clearTimeout(timer);
        if (connected) return;
        counters.fail();
        reply(socket, 502, `${label} could not be reached`);
      });
      out.once('close', () => {
        clearTimeout(timer);
        if (connected) socket.destroy();
      });
      socket.once('close', () => out.destroy());
    });
  });

  return {
    server,
    stats: () => counters.snapshot(),
    dropConnections: () => {
      for (const s of sockets) s.destroy();
    },
  };
}
