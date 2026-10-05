import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionPrincipal } from './contract';

/**
 * Browser sessions for the App (ADR-011). A bearer-token holder (the CLI's
 * `orbit app`) mints a one-time login ticket; the App redeems it once for an
 * HttpOnly, SameSite=Strict session cookie. In hosted mode (ADR-015) the
 * OIDC callback mints the ticket. A ticket is bound to the principal it was
 * minted for, and so is the session it becomes. Everything lives in memory:
 * a daemon restart (which also rotates the bearer token) signs every browser
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
  /** Sessions only: the CSRF secret the App must echo (the cookie alone is not enough). */
  csrf?: Buffer;
  /** Who signs in with this ticket / acts through this session. */
  principal: SessionPrincipal;
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

  private static add(
    map: Map<string, Entry>,
    max: number,
    value: string,
    t: number,
    principal: SessionPrincipal,
    csrf?: string,
  ): void {
    while (map.size >= max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    map.set(randomBytes(8).toString('hex'), {
      value: Buffer.from(value),
      ...(csrf === undefined ? {} : { csrf: Buffer.from(csrf) }),
      principal: { ...principal },
      createdAt: t,
      lastSeenAt: t,
    });
  }

  /** A single-use login ticket (`orbit app`, or the OIDC callback) for `principal`. */
  mintTicket(principal: SessionPrincipal): { ticket: string; expiresAt: string } {
    this.sweep();
    const t = this.now().getTime();
    const ticket = secret();
    SessionStore.add(this.tickets, this.maxTickets, ticket, t, principal);
    return { ticket, expiresAt: new Date(t + this.ticketTtlMs).toISOString() };
  }

  /**
   * Trade a ticket (once) for a session: the id goes into the HttpOnly
   * cookie, the CSRF secret to the page (which keeps it in its own origin's
   * storage). Cookies ignore ports, so any listener on 127.0.0.1 may see the
   * cookie; without the secret it is useless (M5 review HIGH-1).
   */
  redeem(ticket: string): {
    session: string;
    csrf: string;
    maxAgeSeconds: number;
    principal: SessionPrincipal;
  } | null {
    this.sweep();
    const key = find(this.tickets, ticket);
    const entry = key === null ? undefined : this.tickets.get(key);
    if (key === null || !entry) return null;
    this.tickets.delete(key);
    const session = secret();
    const csrf = secret();
    const t = this.now().getTime();
    SessionStore.add(this.sessions, this.maxSessions, session, t, entry.principal, csrf);
    return {
      session,
      csrf,
      maxAgeSeconds: Math.floor(this.maxTtlMs / 1000),
      principal: { ...entry.principal },
    };
  }

  /**
   * 'ok' for a live session presented with its own CSRF secret (touches it:
   * sliding idle expiry); 'bad_csrf' for a live session without it; 'none'
   * otherwise.
   */
  check(session: string, csrf: string | undefined): 'ok' | 'bad_csrf' | 'none' {
    return this.authenticate(session, csrf).status;
  }

  /** Like check(), plus the session's principal when it is 'ok'. */
  authenticate(
    session: string,
    csrf: string | undefined,
  ):
    | { status: 'ok'; principal: SessionPrincipal }
    | { status: 'bad_csrf' | 'none'; principal?: undefined } {
    this.sweep();
    const key = find(this.sessions, session);
    if (key === null) return { status: 'none' };
    const e = this.sessions.get(key);
    if (!e?.csrf) return { status: 'none' };
    const presented = Buffer.from(csrf ?? '');
    if (presented.length !== e.csrf.length || !timingSafeEqual(presented, e.csrf)) {
      return { status: 'bad_csrf' };
    }
    e.lastSeenAt = this.now().getTime();
    return { status: 'ok', principal: { ...e.principal } };
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
