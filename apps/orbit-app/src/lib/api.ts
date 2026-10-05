import { OrbitError } from '@orbit/core/browser';
import { CSRF_HEADER, OrbitClient } from '@orbit/sdk-client/browser';
import { createContext, useContext } from 'react';
import { createStore } from './store';

const CSRF_KEY = 'orbit.csrf';

/**
 * The session's CSRF secret from sign-in. It lives in this origin's storage
 * (scoped to scheme, host and port), so a listener on another loopback port
 * that sees the cookie (cookies ignore ports) still cannot use it.
 */
export const csrfSecret = {
  get(): string | null {
    try {
      return localStorage.getItem(CSRF_KEY);
    } catch {
      return null;
    }
  },
  set(value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(CSRF_KEY);
      else localStorage.setItem(CSRF_KEY, value);
    } catch {
      // storage unavailable: this tab signs in again next time
    }
  },
};

/**
 * The App's client: same origin as orbitd, authenticated by the HttpOnly
 * session cookie plus the session's CSRF secret (ADR-011). No API token ever
 * reaches the browser.
 */
export function createBrowserClient(baseUrl = ''): OrbitClient {
  return new OrbitClient({
    baseUrl,
    credentials: 'same-origin',
    // Before sign-in there is no secret yet; "1" lets the ticket be redeemed.
    headers: () => ({ [CSRF_HEADER]: csrfSecret.get() ?? '1' }),
  });
}

export const ClientContext = createContext<OrbitClient | null>(null);

export function useClient(): OrbitClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error('useClient outside <ClientContext>');
  return c;
}

/** 'unknown' until the first answer; 'signed-out' after any 401. */
export type AuthState = 'unknown' | 'signed-in' | 'signed-out';
export const authStore = createStore<AuthState>('unknown');

export function isUnauthorized(err: unknown): boolean {
  return err instanceof OrbitError && err.code === 'unauthorized';
}

/** User-facing text of an error (OrbitError message + hint). */
export function errorText(err: unknown): string {
  if (err instanceof OrbitError) return err.hint ? `${err.message} ${err.hint}` : err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Read and clear the one-time ticket from `#ticket=…` (never kept in history). */
export function takeTicketFromLocation(loc: Location, history: History): string | null {
  const m = /(?:^#|&)ticket=([\w-]{16,128})/.exec(loc.hash);
  if (!m) return null;
  history.replaceState(null, '', loc.pathname + loc.search);
  return m[1] ?? null;
}
