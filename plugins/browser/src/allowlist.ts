import { ToolError } from '@orbit/plugin-kit';

/**
 * The owner's domain allowlist (BROWSER_ALLOWED_DOMAINS) and the URL checks
 * built on it. Pure: no browser, no network. Every request the page makes
 * goes through `requestVerdict`; the URLs the Bot asks to open also go
 * through `checkPageUrl` first.
 */

export interface Allowlist {
  /** Exact hosts (canonical: lowercase ASCII, no trailing dot, IPv6 in brackets). */
  readonly exact: ReadonlySet<string>;
  /** `*.example.com` entries, stored as `.example.com`: subdomains only, any depth. */
  readonly suffixes: readonly string[];
  /** The entries as configured, for messages. */
  readonly entries: readonly string[];
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** An IPv4 or IPv6 literal (as the URL parser writes hostnames). */
export function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || host.startsWith('[');
}

/**
 * The canonical form of a host name or IP literal, or null if it is not one:
 * the WHATWG URL parser lowercases, converts IDN to punycode and normalises
 * IPv4 forms (`127.1`, `0x7f.0.0.1`); a single trailing dot is dropped.
 * Anything with a scheme, port, path or credentials is not a host.
 */
export function canonicalHost(raw: string): string | null {
  let h = raw.trim();
  if (!h || /[/?#@\\\s]/.test(h)) return null;
  if (h.includes(':') && !h.startsWith('[')) h = `[${h}]`; // a bare IPv6 literal
  let u: URL;
  try {
    u = new URL(`http://${h}/`);
  } catch {
    return null;
  }
  if (u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash) return null;
  return trimDot(u.hostname);
}

function trimDot(host: string): string | null {
  const h = host.endsWith('.') ? host.slice(0, -1) : host;
  if (!h || h.startsWith('.') || h.endsWith('.') || h.includes('..')) return null;
  return h;
}

/** Parse BROWSER_ALLOWED_DOMAINS; a bad entry is an error the owner sees (never silently ignored). */
export function parseAllowlist(raw: string): Allowlist {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  const entries: string[] = [];
  const bad: string[] = [];
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    entries.push(entry);
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      const host = base.includes('*') ? null : canonicalHost(base);
      // A wildcard needs a registrable-looking base (`*.com` is too broad) and never covers IPs.
      if (!host || isIpLiteral(host) || !host.includes('.')) bad.push(entry);
      else suffixes.push(`.${host}`);
      continue;
    }
    const host = entry.includes('*') ? null : canonicalHost(entry);
    if (!host) bad.push(entry);
    else exact.add(host);
  }
  if (bad.length) {
    throw new ToolError(
      `BROWSER_ALLOWED_DOMAINS has entries that are not host names: ${bad.join(', ')} ` +
        "(use names like 'example.com' or '*.example.com', no scheme, port or path)",
    );
  }
  if (exact.size === 0 && suffixes.length === 0) {
    throw new ToolError(
      'BROWSER_ALLOWED_DOMAINS lists no domains; ask your owner to configure the plugin',
    );
  }
  return { exact, suffixes, entries };
}

/** True when `hostname` (as `URL.hostname` gives it) is on the allowlist. Ports never matter. */
export function hostAllowed(allow: Allowlist, hostname: string): boolean {
  const host = trimDot(hostname.toLowerCase());
  if (!host) return false;
  if (allow.exact.has(host)) return true;
  if (isIpLiteral(host)) return false; // IP literals only when listed exactly
  return allow.suffixes.some((s) => host.endsWith(s));
}

const PAGE_SCHEMES = new Set(['http:', 'https:']);
/** Schemes whose requests never leave the browser. */
const LOCAL_SCHEMES = new Set(['data:', 'blob:']);
const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * The URL the Bot asked to open, checked: http(s) only, no credentials, an
 * allowed host. Returns the parsed URL or throws a ToolError saying why.
 */
export function checkPageUrl(allow: Allowlist, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ToolError(`Not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (!PAGE_SCHEMES.has(u.protocol)) {
    throw new ToolError(`Only http and https pages can be opened (refused a ${u.protocol} URL)`);
  }
  if (u.username || u.password)
    throw new ToolError('URLs with a user name or password are refused');
  if (!hostAllowed(allow, u.hostname)) {
    throw new ToolError(
      `${u.hostname} is not in the domains your owner allows (${allow.entries.join(', ')})`,
    );
  }
  return u;
}

export type Verdict = { allowed: true } | { allowed: false; host: string };

/**
 * May the page make this request? Network requests (http, https, ws, wss)
 * only to allowed hosts and never with credentials in the URL; data: and
 * blob: stay in the browser; every other scheme is refused.
 */
export function requestVerdict(allow: Allowlist, raw: string): Verdict {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { allowed: false, host: '(invalid URL)' };
  }
  if (LOCAL_SCHEMES.has(u.protocol)) return { allowed: true };
  if (!NETWORK_SCHEMES.has(u.protocol)) return { allowed: false, host: u.protocol };
  if (u.username || u.password) return { allowed: false, host: u.hostname };
  return hostAllowed(allow, u.hostname) ? { allowed: true } : { allowed: false, host: u.hostname };
}
