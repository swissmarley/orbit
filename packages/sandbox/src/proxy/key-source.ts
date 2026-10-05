import { OrbitError } from '@orbit/core';
import type { CommandRunner } from '../types';

/**
 * Where the host-side API proxy gets the key it injects (ADR-018). The key
 * lives only in orbitd; a container sees a placeholder.
 */
export interface ApiKeySource {
  /** The key, or null when Orbit has none. Never logged, never part of an error. */
  get(): Promise<string | null>;
  /** The upstream answered 401: the next get() fetches a fresh key (apiKeyHelper). */
  invalidate(): void;
}

/** `ANTHROPIC_API_KEY` of orbitd. */
export function staticApiKey(value: string): ApiKeySource {
  const key = value.trim();
  return {
    get: () => Promise.resolve(key.length > 0 ? key : null),
    invalidate: () => undefined,
  };
}

/** Claude Code's default apiKeyHelper refresh interval. */
export const API_KEY_HELPER_TTL_MS = 5 * 60_000;

export interface ApiKeyHelperOptions {
  /** The owner's `apiKeyHelper` shell command (ORBIT_API_KEY_HELPER). */
  command: string;
  /**
   * Runs `/bin/sh -c <command>` with the environment the SDK engine would
   * have given the helper (built by the caller from an allowlist, ADR-005).
   */
  run: CommandRunner;
  /** Refresh interval (CLAUDE_CODE_API_KEY_HELPER_TTL_MS, like Claude Code). */
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The output of the owner's apiKeyHelper, run on the host the way Claude
 * Code runs it: cached for the TTL, refreshed after it or after a 401.
 * Concurrent requests share one helper run. The helper's output and stderr
 * never appear in an error message.
 */
export function apiKeyHelper(opts: ApiKeyHelperOptions): ApiKeySource {
  const ttlMs = opts.ttlMs ?? API_KEY_HELPER_TTL_MS;
  const now = opts.now ?? Date.now;
  let cached: { key: string; at: number } | null = null;
  let pending: Promise<string> | null = null;

  const fetchKey = async (): Promise<string> => {
    let r;
    try {
      r = await opts.run('/bin/sh', ['-c', opts.command], { timeoutMs: opts.timeoutMs ?? 30_000 });
    } catch {
      throw new OrbitError('auth_required', 'The API key helper could not be run', {
        hint: 'Check ORBIT_API_KEY_HELPER: run the command yourself and make sure it prints the key.',
      });
    }
    const key = r.stdout.trim();
    if (r.code !== 0 || key.length === 0 || /\s/.test(key)) {
      throw new OrbitError(
        'auth_required',
        `The API key helper ${r.code !== 0 ? `exited with code ${r.code}` : 'printed no usable key'}`,
        { hint: 'Check ORBIT_API_KEY_HELPER: it must print only the key on stdout.' },
      );
    }
    cached = { key, at: now() };
    return key;
  };

  return {
    get: async () => {
      if (cached !== null && now() - cached.at < ttlMs) return cached.key;
      pending ??= fetchKey().finally(() => {
        pending = null;
      });
      return pending;
    },
    invalidate: () => {
      cached = null;
    },
  };
}
