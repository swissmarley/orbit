import { isIP } from 'node:net';

/**
 * Which IP addresses the browser may reach once a name on the allowlist
 * resolves (ADR-019). An allowed name must not lead to the owner's own
 * machine, network or cloud metadata service: answers in private, loopback,
 * link-local, CGNAT, unique-local, multicast, reserved or unspecified ranges
 * (and the IPv4-mapped, NAT64 and 6to4 forms of those) are refused, unless
 * the owner listed that exact address, or allowed private addresses (an
 * intranet site; cloud metadata, unspecified, multicast and reserved
 * addresses stay refused even then). Pure: the filter proxy resolves.
 */

export type AddressKind =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link-local'
  | 'cgnat'
  | 'unique-local'
  | 'metadata'
  | 'multicast'
  | 'unspecified'
  | 'reserved';

/** Kinds `BROWSER_ALLOW_PRIVATE_ADDRESSES=true` admits. */
const PRIVATE_KINDS: ReadonlySet<AddressKind> = new Set([
  'private',
  'loopback',
  'link-local',
  'cgnat',
  'unique-local',
]);

/** 16 bytes of an IPv6 address (zone ids refused), or null. */
export function parseIpv6(text: string): number[] | null {
  let s = text.replace(/^\[|\]$/g, '');
  if (s.includes('%') || isIP(s) !== 6) return null;
  let tail: number[] = [];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted?.[1]) {
    const v4 = parseIpv4(dotted[1]);
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, -dotted[1].length);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const groupsNeeded = 8 - tail.length / 2;
  const [head, rest] = s.split('::') as [string, string | undefined];
  const toGroups = (part: string) => (part === '' ? [] : part.split(':'));
  const a = toGroups(head);
  const b = rest === undefined ? [] : toGroups(rest);
  const fill = rest === undefined ? 0 : groupsNeeded - a.length - b.length;
  const groups = [...a, ...Array<string>(Math.max(0, fill)).fill('0'), ...b];
  if (groups.length !== groupsNeeded) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!/^[0-9a-fA-F]{1,4}$/.test(g) || Number.isNaN(n)) return null;
    bytes.push(n >> 8, n & 0xff);
  }
  return [...bytes, ...tail];
}

/** 4 bytes of a dotted-quad IPv4 address, or null. */
export function parseIpv4(text: string): number[] | null {
  if (isIP(text) !== 4) return null;
  return text.split('.').map(Number);
}

const inV4 = (b: number[], net: number[], bits: number): boolean => {
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if (((b[i] ?? 0) & mask) !== ((net[i] ?? 0) & mask)) return false;
  }
  return true;
};

const inV6 = (b: number[], prefix: number[], bits: number): boolean => {
  for (let i = 0; i < 16; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if (((b[i] ?? 0) & mask) !== ((prefix[i] ?? 0) & mask)) return false;
  }
  return true;
};

function v4Kind(b: number[]): AddressKind {
  const is = (net: string, bits: number) => inV4(b, net.split('.').map(Number), bits);
  if (b.join('.') === '169.254.169.254') return 'metadata';
  if (is('0.0.0.0', 8)) return 'unspecified';
  if (is('127.0.0.0', 8)) return 'loopback';
  if (is('10.0.0.0', 8) || is('172.16.0.0', 12) || is('192.168.0.0', 16)) return 'private';
  if (is('100.64.0.0', 10)) return 'cgnat';
  if (is('169.254.0.0', 16)) return 'link-local';
  if (is('224.0.0.0', 4)) return 'multicast';
  if (
    is('192.0.0.0', 24) || // IETF protocol assignments
    is('192.0.2.0', 24) || // documentation
    is('198.51.100.0', 24) ||
    is('203.0.113.0', 24) ||
    is('198.18.0.0', 15) || // benchmarking
    is('192.88.99.0', 24) || // 6to4 relay anycast
    is('240.0.0.0', 4) // reserved, and 255.255.255.255
  ) {
    return 'reserved';
  }
  return 'public';
}

const hex = (h: string): number[] => parseIpv6(h) ?? [];

function v6Kind(b: number[]): AddressKind {
  const is = (prefix: string, bits: number) => inV6(b, hex(prefix), bits);
  if (b.every((x) => x === 0)) return 'unspecified';
  if (is('::1', 128)) return 'loopback';
  // Forms that carry an IPv4 address: judged by that address.
  if (is('::ffff:0:0', 96) || is('::', 96) || is('64:ff9b::', 96)) return v4Kind(b.slice(12));
  if (is('2002::', 16)) return v4Kind(b.slice(2, 6));
  if (is('fd00:ec2::254', 128)) return 'metadata';
  if (is('fc00::', 7)) return 'unique-local';
  if (is('fe80::', 10)) return 'link-local';
  if (is('fec0::', 10) || is('64:ff9b:1::', 48)) return 'private';
  if (is('ff00::', 8)) return 'multicast';
  if (is('2001:db8::', 32) || is('100::', 64) || is('2001::', 32) || is('2001:10::', 28)) {
    return 'reserved';
  }
  return is('2000::', 3) ? 'public' : 'reserved';
}

/** What kind of address this is; anything that does not parse is `reserved`. */
export function addressKind(address: string): AddressKind {
  const v4 = parseIpv4(address);
  if (v4) return v4Kind(v4);
  const v6 = parseIpv6(address);
  return v6 ? v6Kind(v6) : 'reserved';
}

/** The canonical text of an address, as the allowlist stores IP literals (IPv6 in brackets). */
export function canonicalAddress(address: string): string | null {
  const bare = address.replace(/^\[|\]$/g, '');
  const kind = isIP(bare);
  if (kind === 0) return null;
  try {
    return new URL(`http://${kind === 6 ? `[${bare}]` : bare}/`).hostname;
  } catch {
    return null;
  }
}

export interface AddressPolicy {
  /** IP literals the owner listed exactly (canonical). */
  listed: ReadonlySet<string>;
  /** BROWSER_ALLOW_PRIVATE_ADDRESSES: private, loopback, link-local, CGNAT, unique-local. */
  allowPrivate: boolean;
}

/** Null when the browser may connect to `address`, else why not. */
export function addressRefusal(address: string, policy: AddressPolicy): string | null {
  const canonical = canonicalAddress(address);
  if (canonical === null) return `${address} is not an IP address`;
  if (policy.listed.has(canonical)) return null;
  const kind = addressKind(address);
  if (kind === 'public') return null;
  if (policy.allowPrivate && PRIVATE_KINDS.has(kind)) return null;
  const words: Record<Exclude<AddressKind, 'public'>, string> = {
    private: 'a private address',
    loopback: 'a loopback address',
    'link-local': 'a link-local address',
    cgnat: 'a carrier-grade NAT address',
    'unique-local': 'a unique-local address',
    metadata: 'a cloud metadata address',
    multicast: 'a multicast address',
    unspecified: 'an unspecified address',
    reserved: 'a reserved address',
  };
  return `${canonical} is ${words[kind]}`;
}

/** BROWSER_ALLOW_PRIVATE_ADDRESSES: only an explicit yes turns it on. */
export function allowsPrivate(value: string | undefined): boolean {
  return ['true', '1', 'yes'].includes((value ?? '').trim().toLowerCase());
}
