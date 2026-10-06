import { describe, expect, it } from 'vitest';
import { buildSdkOptions } from './sdk';
import type { DriverRunRequest } from './types';

const KEY = 'sk-ant-api03-NEVER-IN-AN-ENGINE';
const hooks = {
  preToolUse: () => Promise.resolve({}),
  canUseTool: () => Promise.resolve({ behavior: 'deny' as const, message: 'no' }),
};

function engineEnv(env: Record<string, string>, key: Parameters<typeof buildSdkOptions>[1]['key']) {
  const o = buildSdkOptions(
    { cwd: '/work' } as DriverRunRequest,
    { env, bare: true, apiKeyHelper: null, key },
    hooks,
    new AbortController(),
    () => undefined,
  );
  return o.env ?? {};
}

describe('the SDK engine environment never holds the Anthropic API key', () => {
  it('Bedrock / Vertex engines get their cloud credentials, not an API key orbitd also holds', () => {
    const env = engineEnv(
      {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: KEY,
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'eu-west-1',
        AWS_ACCESS_KEY_ID: 'AKIA-test',
      },
      { via: 'engine' },
    );
    expect(env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'AKIA-test' });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('proxied and container engines get only the placeholder', () => {
    for (const key of [
      { via: 'host_proxy' as const, baseUrl: 'http://127.0.0.1:4000/tok', scrub: false },
      { via: 'container' as const },
    ]) {
      expect(
        JSON.stringify(engineEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: KEY }, key)),
      ).not.toContain(KEY);
    }
  });
});
