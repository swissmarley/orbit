import { describe, expect, it } from 'vitest';
import { checkAuthSource } from './auth-source';

describe('checkAuthSource', () => {
  it.each([
    ['sdk', 'api_key', 'ANTHROPIC_API_KEY', null],
    ['sdk', 'api_key', 'oauth', 'auth_source_mismatch'],
    ['sdk', 'api_key', 'none', 'auth_source_mismatch'],
    ['sdk', 'api_key_helper', 'apiKeyHelper', null],
    ['sdk', 'bedrock', 'none', null],
    ['sdk', 'vertex', 'oauth', 'auth_source_mismatch'],
    ['cli', 'subscription', 'none', null],
    ['cli', 'subscription', 'ANTHROPIC_API_KEY', 'auth_source_mismatch'],
    ['mock', 'mock', 'oauth', null],
  ] as const)('%s/%s reporting %s → %s', (driver, method, source, code) => {
    const { failure } = checkAuthSource(driver, method, source);
    expect(failure?.type === 'run.failed' ? failure.data.code : null).toBe(code);
  });

  it('warns but continues when the engine does not report a source', () => {
    const r = checkAuthSource('sdk', 'api_key', null);
    expect(r.failure).toBeNull();
    expect(typeof r.warning).toBe('string');
  });
});
