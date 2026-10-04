import { type AuthMethod, type DriverKind, type RunEventBody, event } from '@orbit/core';

/** Credential sources the engine may report for each auth method. */
const EXPECTED: Partial<Record<AuthMethod, readonly string[]>> = {
  api_key: ['ANTHROPIC_API_KEY'],
  api_key_helper: ['apiKeyHelper'],
  // Bedrock / Vertex: only login sources are rejected (reporting varies by provider).
};

/** Sources that mean a subscription/console login, never acceptable for SdkDriver. */
const LOGIN_SOURCES = new Set([
  'oauth',
  '/login managed key',
  'temporary',
  'user',
  'project',
  'org',
]);

/**
 * Verify the engine authenticated the way Orbit intended (reported in its
 * `init` message). SdkDriver must never run on a subscription login; CliDriver
 * must never run on an API key that leaked into its environment.
 * Returns a terminal event when the run must be stopped.
 */
export function checkAuthSource(
  driver: DriverKind,
  authMethod: AuthMethod,
  apiKeySource: string | null,
): { failure: RunEventBody | null; warning: string | null } {
  if (driver === 'mock') return { failure: null, warning: null };
  if (apiKeySource === null) {
    return { failure: null, warning: 'The engine did not report its credential source' };
  }
  const fail = (message: string) => ({
    failure: event('run.failed', {
      code: 'auth_source_mismatch',
      message,
      retryable: false,
      sessionId: null,
    }),
    warning: null,
  });
  if (driver === 'cli') {
    return apiKeySource === 'ANTHROPIC_API_KEY'
      ? fail(
          'The claude CLI authenticated with ANTHROPIC_API_KEY in subscription mode; the run was stopped',
        )
      : { failure: null, warning: null };
  }
  if (LOGIN_SOURCES.has(apiKeySource)) {
    return fail(
      `The Agent SDK engine authenticated with "${apiKeySource}" instead of an API credential; the run was stopped`,
    );
  }
  const expected = EXPECTED[authMethod];
  if (expected && !expected.includes(apiKeySource)) {
    return fail(
      `Expected credential source ${expected.join(' or ')} but the engine reported "${apiKeySource}"`,
    );
  }
  return { failure: null, warning: null };
}
