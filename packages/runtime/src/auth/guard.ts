import { type OrbitConfig, OrbitError, humanPrincipalCount, isLoopbackHost } from '@orbit/core';

export type GuardViolation = 'hosted_mode' | 'non_loopback_bind' | 'multiple_principals';

export interface GuardResult {
  allowed: boolean;
  violations: GuardViolation[];
  message: string | null;
}

const EXPLANATION =
  'Orbit can use your Claude.ai subscription only through your own `claude` CLI, ' +
  'for personal, local, single-user use. Anthropic does not allow third-party ' +
  'products to offer claude.ai login or subscription rate limits to others.';

const API_KEY_HOWTO =
  'To run Orbit hosted, shared or on a network address, use an API key instead: ' +
  'set ANTHROPIC_API_KEY (or configure Amazon Bedrock / Google Vertex AI) and restart. ' +
  'Run `orbit login-help` for details.';

const REASONS: Record<GuardViolation, (c: OrbitConfig) => string> = {
  hosted_mode: () => 'ORBIT_MODE=hosted is set',
  non_loopback_bind: (c) => `the API is bound to ${c.api.host}, which is not a loopback address`,
  multiple_principals: (c) => `${humanPrincipalCount(c)} human principals are configured`,
};

/**
 * Compliance guard for CliDriver (subscription mode). Refuses when Orbit is in
 * hosted mode, reachable from the network, or shared by several humans.
 */
export function checkCliDriverAllowed(config: OrbitConfig): GuardResult {
  const violations: GuardViolation[] = [];
  if (config.mode === 'hosted') violations.push('hosted_mode');
  if (!isLoopbackHost(config.api.host)) violations.push('non_loopback_bind');
  if (humanPrincipalCount(config) > 1) violations.push('multiple_principals');
  if (violations.length === 0) return { allowed: true, violations, message: null };
  const why = violations.map((v) => REASONS[v](config)).join('; ');
  return {
    allowed: false,
    violations,
    message: `Refusing to use your Claude subscription (CliDriver): ${why}. ${EXPLANATION}`,
  };
}

export function assertCliDriverAllowed(config: OrbitConfig): void {
  const r = checkCliDriverAllowed(config);
  if (!r.allowed) {
    throw new OrbitError('compliance_refused', r.message ?? 'CliDriver refused', {
      hint: API_KEY_HOWTO,
    });
  }
}

export const GUARD_API_KEY_HOWTO = API_KEY_HOWTO;
