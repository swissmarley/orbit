import type { Env } from '../env';

/**
 * The single audited place that may look at Claude OAuth credentials, and it
 * only checks for *presence* of the environment variable — it never reads,
 * copies or returns the value (ADR-005). Used by `orbit doctor` to explain why
 * a token-only CLI login is not forwarded to Orbit's `claude` children.
 */
export function hasOAuthTokenEnv(env: Env): boolean {
  return Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CODE_OAUTH_TOKEN');
}
