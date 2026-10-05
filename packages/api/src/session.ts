import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Browser sessions for the App (ADR-011). A bearer-token holder (the CLI's
 * `orbit app`) mints a one-time login ticket; the App redeems it once for an
 * HttpOnly, SameSite=Strict session cookie. Everything lives in memory: a
 * daemon restart (which also rotates the bearer token) signs every browser
 * out.
 */

export interface SessionOptions {
  now?: () => Date;
  /** A ticket must be redeemed within this window. Default 2 minutes. */
  ticketTtlMs?: number;
  /** A session idle this long expires. Default 12 hours. */
  idleTtlMs?: number;
  /** A session never lives longer than this. Default 7 days. */
  maxTtlMs?: number;
  /** Outstanding tickets / live sessions kept (oldest dropped first). */
  maxTickets?: number;
  maxSessions?: number;
}

interface Entry {
  value: Buffer;
  createdAt: number;
  lastSeenAt: number;
}

const HOUR = 3_600_000;

function secret(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time lookup: compares the candidate with every live entry. */
function find(entries: Map<string, Entry>, candidate: string): string | null {
  const c = Buffer.from(candidate);
  let hit: string | null = null;
  for (const [key, e] of entries) {
    if (e.value.length === c.length && timingSafeEqual(e.value, c)) hit = key;
  }
  return hit;
}

export class SessionStore {
  private readonly now: () => Date;
  private readonly ticketTtlMs: number;
  private readonly idleTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly maxTickets: number;
  private readonly maxSessions: number;
  private readonly tickets = new Map<string, Entry>();
  private readonly sessions = new Map<string, Entry>();

  constructor(opts: SessionOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.ticketTtlMs = opts.ticketTtlMs ?? 2 * 60_000;
    this.idleTtlMs = opts.idleTtlMs ?? 12 * HOUR;
    this.maxTtlMs = opts.maxTtlMs ?? 7 * 24 * HOUR;
    this.maxTickets = opts.maxTickets ?? 16;
    this.maxSessions = opts.maxSessions ?? 32;
  }

  private sweep(): void {
    const t = this.now().getTime();
    for (const [k, e] of this.tickets)
      if (t - e.createdAt > this.ticketTtlMs) this.tickets.delete(k);
    for (const [k, e] of this.sessions) {
      if (t - e.lastSeenAt > this.idleTtlMs || t - e.createdAt > this.maxTtlMs) {
        this.sessions.delete(k);
      }
    }
  }

  private static add(map: Map<string, Entry>, max: number, value: string, t: number): void {
    while (map.size >= max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    map.set(randomBytes(8).toString('hex'), {
      value: Buffer.from(value),
      createdAt: t,
      lastSeenAt: t,
    });
  }

  /** A single-use login ticket for `orbit app`. */
  mintTicket(): { ticket: string; expiresAt: string } {
    this.sweep();
    const t = this.now().getTime();
    const ticket = secret();
    SessionStore.add(this.tickets, this.maxTickets, ticket, t);
    return { ticket, expiresAt: new Date(t + this.ticketTtlMs).toISOString() };
  }

  /** Trade a ticket (once) for a session id; null when unknown, used or expired. */
  redeem(ticket: string): { session: string; maxAgeSeconds: number } | null {
    this.sweep();
    const key = find(this.tickets, ticket);
    if (key === null) return null;
    this.tickets.delete(key);
    const session = secret();
    SessionStore.add(this.sessions, this.maxSessions, session, this.now().getTime());
    return { session, maxAgeSeconds: Math.floor(this.maxTtlMs / 1000) };
  }

  /** Is this a live session? Touches it (sliding idle expiry). */
  check(session: string): boolean {
    this.sweep();
    const key = find(this.sessions, session);
    if (key === null) return false;
    const e = this.sessions.get(key);
    if (e) e.lastSeenAt = this.now().getTime();
    return true;
  }

  revoke(session: string): void {
    const key = find(this.sessions, session);
    if (key !== null) this.sessions.delete(key);
  }

  /** Sign every browser out. */
  clear(): void {
    this.tickets.clear();
    this.sessions.clear();
  }
}
