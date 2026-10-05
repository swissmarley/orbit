import { OrbitError } from '@orbit/core/browser';
import { CSRF_HEADER, OrbitClient } from '@orbit/sdk-client/browser';
import { createContext, useContext } from 'react';
import { createStore } from './store';

/**
 * The App's client: same origin as orbitd, authenticated by the HttpOnly
 * session cookie plus the CSRF header (ADR-011). No token ever reaches the
 * browser.
 */
export function createBrowserClient(baseUrl = ''): OrbitClient {
  return new OrbitClient({
    baseUrl,
    credentials: 'same-origin',
    headers: { [CSRF_HEADER]: '1' },
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
