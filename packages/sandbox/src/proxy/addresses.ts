import { BlockList, isIP, isIPv6 } from 'node:net';

/**
 * Address ranges the egress proxy never connects to unless the owner
 * allowlisted that literal address (ADR-018): loopback, private, link-local
 * (including cloud metadata at 169.254.169.254 and fd00:ec2::254), CGNAT
 * (including 100.100.100.200), unique-local, multicast, unspecified and the
 * other special-purpose blocks a container has no business reaching.
 */
const BLOCKED_V4: readonly [string, number, string][] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'special-purpose'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'special-purpose'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const BLOCKED_V6: readonly [string, number, string][] = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['64:ff9b:1::', 48, 'local-use NAT64'],
  ['100::', 64, 'discard'],
  ['2001:db8::', 32, 'documentation'],
  ['fc00::', 7, 'unique-local'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast'],
];

const v4Lists = BLOCKED_V4.map(([net, prefix, reason]) => {
  const list = new BlockList();
  list.addSubnet(net, prefix, 'ipv4');
  return { list, reason };
});
const v6Lists = BLOCKED_V6.map(([net, prefix, reason]) => {
  const list = new BlockList();
  list.addSubnet(net, prefix, 'ipv6');
  return { list, reason };
});

/** The 8 groups of an IPv6 address as numbers (input must satisfy isIPv6). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  // A trailing dotted quad (::ffff:1.2.3.4) becomes two groups.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

/** IPv4 address carried inside an IPv6 one (mapped, compatible, NAT64, 6to4), or null. */
function embeddedV4(address: string): { v4: string; compatible: boolean } | null {
  const g = ipv6Groups(address);
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const v4 = quad(g[6] ?? 0, g[7] ?? 0);
  if (g.slice(0, 5).every((x) => x === 0)) {
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated "compatible")
    if (g[5] === 0xffff) return { v4, compatible: false };
    if (g[5] === 0) return { v4, compatible: true };
  }
  // 64:ff9b::a.b.c.d (well-known NAT64 prefix)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return { v4, compatible: false };
  }
  // 2002:aabb:ccdd::/48 (6to4)
  if (g[0] === 0x2002) return { v4: quad(g[1] ?? 0, g[2] ?? 0), compatible: false };
  return null;
}

/**
 * Why the proxy must not connect to `address` without an explicit literal
 * allowlist entry, or null for a public address. Anything that is not an IP
 * address is refused too. IPv6 forms that carry an IPv4 address are judged
 * by that address.
 */
export function blockedAddressReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return v4Lists.find((b) => b.list.check(address, 'ipv4'))?.reason ?? null;
  if (family !== 6) return 'not an IP address';
  const v6 = v6Lists.find((b) => b.list.check(address, 'ipv6'))?.reason;
  if (v6 !== undefined) return v6;
  const embedded = embeddedV4(address);
  if (embedded === null) return null;
  return embedded.compatible ? 'IPv4-compatible' : blockedAddressReason(embedded.v4);
}

/** Canonical text of an IP address (lower case, IPv6 fully expanded) for comparisons. */
export function canonicalAddress(address: string): string {
  if (!isIPv6(address)) return address;
  return ipv6Groups(address)
    .map((g) => g.toString(16))
    .join(':');
}

// ------------------------------------------------------------- allowlist

/** One parsed `sandbox.allowedDomains` entry. */
export type AllowRule =
  | { kind: 'host'; host: string; port: number }
  | { kind: 'suffix'; suffix: string; port: number }
  | { kind: 'address'; address: string; port: number };

export interface ParsedAllowlist {
  rules: AllowRule[];
  /** Entries that are not a host name, `*.` wildcard or IP literal (they never match). */
  invalid: string[];
}

export const DEFAULT_EGRESS_PORT = 443;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A DNS host name Orbit accepts (lower case, no trailing dot), or null. */
export function normalizeHostName(name: string): string | null {
  const host = name.toLowerCase().replace(/\.$/, '');
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  // All-numeric names are IPv4 literals in disguise (or typos): never a host name.
  if (/^[\d.]+$/.test(host)) return null;
  return host;
}

/** Split `host[:port]` / `[v6]:port`; null when the port is not a number in range. */
function splitPort(entry: string): { host: string; port: number } | null {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) {
    const port = bracketed[2] === undefined ? DEFAULT_EGRESS_PORT : Number(bracketed[2]);
    return port >= 1 && port <= 65535 ? { host: bracketed[1] ?? '', port } : null;
  }
  if (isIPv6(entry)) return { host: entry, port: DEFAULT_EGRESS_PORT };
  const m = /^([^:]+)(?::(\d+))?$/.exec(entry);
  if (!m) return null;
  const port = m[2] === undefined ? DEFAULT_EGRESS_PORT : Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1] ?? '', port } : null;
}

/**
 * Parse `sandbox.allowedDomains`: exact names (`pypi.org`), suffix wildcards
 * (`*.github.com` matches subdomains, not `github.com` itself), IP literals
 * (`10.0.0.5`, `[fd00::1]`), each optionally with `:port` (default 443).
 */
export function parseAllowlist(entries: readonly string[]): ParsedAllowlist {
  const rules: AllowRule[] = [];
  const invalid: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    const split = splitPort(entry);
    if (split === null) {
      invalid.push(raw);
      continue;
    }
    const { host, port } = split;
    if (isIP(host) !== 0) {
      rules.push({ kind: 'address', address: canonicalAddress(host), port });
    } else if (host.startsWith('*.')) {
      const suffix = normalizeHostName(host.slice(2));
      if (suffix === null) invalid.push(raw);
      else rules.push({ kind: 'suffix', suffix, port });
    } else {
      const name = normalizeHostName(host);
      if (name === null) invalid.push(raw);
      else rules.push({ kind: 'host', host: name, port });
    }
  }
  return { rules, invalid };
}

/** Does a host-name rule allow `host:port`? (`host` already normalized.) */
export function nameAllowed(rules: readonly AllowRule[], host: string, port: number): boolean {
  return rules.some(
    (r) =>
      r.port === port &&
      ((r.kind === 'host' && r.host === host) ||
        (r.kind === 'suffix' && host.endsWith(`.${r.suffix}`))),
  );
}

/** Did the owner allowlist exactly this address and port? */
export function addressAllowed(
  rules: readonly AllowRule[],
  address: string,
  port: number,
): boolean {
  const canonical = canonicalAddress(address);
  return rules.some((r) => r.kind === 'address' && r.port === port && r.address === canonical);
}
