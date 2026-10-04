import { describe, expect, it } from 'vitest';
import {
  ALWAYS_DENIED,
  API_CREDENTIALS,
  type ChildKind,
  EnvPolicyError,
  type Env,
  assertChildEnvSafe,
  buildChildEnv,
} from './env';

/**
 * A deliberately dirty parent environment: every credential Orbit might have
 * lying around, plus unrelated secrets and harmless basics. Values are fake.
 */
const SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-TEST-api-key',
  ANTHROPIC_AUTH_TOKEN: 'TEST-auth-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-TEST-oauth',
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'TEST-session-access-token',
  CLAUDE_CODE_SESSION_ID: 'TEST-session-id',
  GITHUB_TOKEN: 'ghp_TEST-github',
  MY_SECRET: 'TEST-my-secret',
  NPM_TOKEN: 'TEST-npm',
  OPENAI_API_KEY: 'TEST-openai',
  AWS_ACCESS_KEY_ID: 'AKIA-TEST',
  AWS_SECRET_ACCESS_KEY: 'TEST-aws-secret',
  AWS_SESSION_TOKEN: 'TEST-aws-session',
  AWS_BEARER_TOKEN_BEDROCK: 'TEST-bedrock-bearer',
  GOOGLE_APPLICATION_CREDENTIALS: '/secrets/TEST-gcp.json',
} as const;

const CLOUD_SETTINGS = {
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '0',
  AWS_REGION: 'us-east-1',
  AWS_PROFILE: 'test-profile',
  ANTHROPIC_VERTEX_PROJECT_ID: 'test-project',
  CLOUD_ML_REGION: 'us-east5',
  VERTEX_REGION_CLAUDE_X: 'europe-west1',
  ANTHROPIC_BASE_URL: 'https://gateway.test.invalid',
};

const BASICS = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/tester',
  USER: 'tester',
  SHELL: '/bin/sh',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'C.UTF-8',
  LC_CTYPE: 'C.UTF-8',
  TERM: 'xterm-256color',
  TMPDIR: '/tmp',
  XDG_CONFIG_HOME: '/home/tester/.config',
  XDG_RUNTIME_DIR: '/run/user/1000',
  HTTPS_PROXY: 'http://proxy.test.invalid:3128',
  HTTP_PROXY: 'http://proxy.test.invalid:3128',
  NO_PROXY: 'localhost,127.0.0.1',
  https_proxy: 'http://proxy.test.invalid:3128',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/test-ca.pem',
};

const DIRTY: Env = {
  ...BASICS,
  ...CLOUD_SETTINGS,
  ...SECRETS,
  CLAUDE_CONFIG_DIR: '/home/tester/.claude-alt',
  NODE_OPTIONS: '--require /tmp/evil.js',
  LD_PRELOAD: '/tmp/evil.so',
  UNSET_VAR: undefined,
};

const KINDS: ChildKind[] = ['cli-engine', 'sdk-engine', 'tool'];
const OAUTH_LIKE = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

/** Prove absence by bytes, not just keys: no secret value appears anywhere. */
function expectNoValues(env: Record<string, string>, values: readonly string[]): void {
  const blob = JSON.stringify(env);
  for (const v of values) expect(blob).not.toContain(v);
}

describe('buildChildEnv: cli-engine (the user’s own claude CLI)', () => {
  const env = buildChildEnv('cli-engine', DIRTY);

  it.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
    'CLAUDE_CODE_SESSION_ID',
    'GITHUB_TOKEN',
    'MY_SECRET',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'CLAUDE_CODE_USE_BEDROCK',
    'NODE_OPTIONS',
    'LD_PRELOAD',
  ])('never receives %s', (name) => {
    expect(env).not.toHaveProperty(name);
  });

  it('contains none of the secret values anywhere', () => {
    expectNoValues(env, Object.values(SECRETS));
  });

  it('is exactly the allowlisted basics plus CLAUDE_CONFIG_DIR / ANTHROPIC_BASE_URL', () => {
    expect(env).toEqual({
      ...BASICS,
      CLAUDE_CONFIG_DIR: DIRTY.CLAUDE_CONFIG_DIR,
      ANTHROPIC_BASE_URL: CLOUD_SETTINGS.ANTHROPIC_BASE_URL,
    });
  });
});

describe('buildChildEnv: sdk-engine (Agent SDK, API-key / cloud mode)', () => {
  const env = buildChildEnv('sdk-engine', DIRTY);

  it('receives the API key and cloud-provider variables', () => {
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY,
      AWS_ACCESS_KEY_ID: SECRETS.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: SECRETS.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: SECRETS.AWS_SESSION_TOKEN,
      AWS_BEARER_TOKEN_BEDROCK: SECRETS.AWS_BEARER_TOKEN_BEDROCK,
      GOOGLE_APPLICATION_CREDENTIALS: SECRETS.GOOGLE_APPLICATION_CREDENTIALS,
      ...CLOUD_SETTINGS,
    });
  });

  it.each([...OAUTH_LIKE, 'CLAUDE_CODE_SESSION_ID', 'GITHUB_TOKEN', 'MY_SECRET', 'NODE_OPTIONS'])(
    'never receives %s',
    (name) => {
      expect(env).not.toHaveProperty(name);
    },
  );

  it('contains no OAuth / session token values anywhere', () => {
    expectNoValues(env, [
      SECRETS.CLAUDE_CODE_OAUTH_TOKEN,
      SECRETS.CLAUDE_CODE_SESSION_ACCESS_TOKEN,
      SECRETS.ANTHROPIC_AUTH_TOKEN,
      SECRETS.CLAUDE_CODE_SESSION_ID,
      SECRETS.GITHUB_TOKEN,
      SECRETS.MY_SECRET,
    ]);
  });

  it('does not get CLAUDE_CONFIG_DIR (it must not find a CLI login on disk)', () => {
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });
});

describe('buildChildEnv: tool (MCP servers, hooks, sandboxes, probes)', () => {
  const env = buildChildEnv('tool', DIRTY);

  it.each([
    ...API_CREDENTIALS,
    ...ALWAYS_DENIED,
    'CLAUDE_CODE_SESSION_ID',
    'GITHUB_TOKEN',
    'MY_SECRET',
  ])('never receives %s', (name) => {
    expect(env).not.toHaveProperty(name);
  });

  it('contains none of the secret values anywhere', () => {
    expectNoValues(env, Object.values(SECRETS));
  });

  it('gets no engine-specific settings', () => {
    expect(env).toEqual(BASICS);
  });
});

describe('buildChildEnv: shared behaviour', () => {
  it.each(KINDS)('%s passes the allowlisted basics through unchanged', (kind) => {
    expect(buildChildEnv(kind, DIRTY)).toMatchObject(BASICS);
  });

  it.each(KINDS)('%s drops undefined values instead of stringifying them', (kind) => {
    const env = buildChildEnv(kind, { PATH: undefined, HOME: '/h', LC_ALL: undefined });
    expect(env).toEqual({ HOME: '/h' });
    expect(JSON.stringify(env)).not.toContain('undefined');
  });

  it.each(KINDS)('%s accepts Orbit-provided extras', (kind) => {
    const env = buildChildEnv(kind, { PATH: '/bin' }, { ORBIT_HOOK_URL: 'http://127.0.0.1:1/h' });
    expect(env).toEqual({ PATH: '/bin', ORBIT_HOOK_URL: 'http://127.0.0.1:1/h' });
  });

  it('does not mutate the source env', () => {
    const source: Env = { ...DIRTY };
    buildChildEnv('cli-engine', source, { X: '1' });
    expect(source).toEqual(DIRTY);
  });

  it('with an empty source yields an empty env', () => {
    expect(buildChildEnv('tool', {})).toEqual({});
  });
});

describe('buildChildEnv: extras cannot smuggle denied names', () => {
  const smuggling: { kind: ChildKind; name: string }[] = [
    ...KINDS.flatMap((kind) => OAUTH_LIKE.map((name) => ({ kind, name }))),
    ...(['cli-engine', 'tool'] as const).flatMap((kind) =>
      API_CREDENTIALS.map((name) => ({ kind, name })),
    ),
  ];

  it.each(smuggling)('$kind: extra $name → EnvPolicyError', ({ kind, name }) => {
    expect(() => buildChildEnv(kind, { PATH: '/bin' }, { [name]: 'smuggled' })).toThrow(
      EnvPolicyError,
    );
    expect(() => buildChildEnv(kind, {}, { [name]: 'smuggled' })).toThrow(
      new RegExp(`${name} may not be passed to a ${kind} child`),
    );
  });

  it('sdk-engine may receive the API key as an extra (e.g. from the vault)', () => {
    expect(buildChildEnv('sdk-engine', {}, { ANTHROPIC_API_KEY: 'k' })).toEqual({
      ANTHROPIC_API_KEY: 'k',
    });
  });
});

describe('assertChildEnvSafe', () => {
  it.each(KINDS)('%s: an env built by buildChildEnv passes', (kind) => {
    expect(() => {
      assertChildEnvSafe(kind, buildChildEnv(kind, DIRTY));
    }).not.toThrow();
  });

  // Positive controls: the guard really fires on a leaked env.
  it.each(KINDS.flatMap((kind) => OAUTH_LIKE.map((name) => ({ kind, name }))))(
    '$kind: a leaked $name is caught',
    ({ kind, name }) => {
      expect(() => {
        assertChildEnvSafe(kind, { PATH: '/bin', [name]: 'leaked' });
      }).toThrow(EnvPolicyError);
    },
  );

  it.each(
    (['cli-engine', 'tool'] as const).flatMap((kind) =>
      API_CREDENTIALS.map((name) => ({ kind, name })),
    ),
  )('$kind: a leaked $name is caught', ({ kind, name }) => {
    expect(() => {
      assertChildEnvSafe(kind, { [name]: 'leaked' });
    }).toThrow(new RegExp(`${name} leaked into a ${kind} child`));
  });

  it('catches an empty-string leak too (presence is the leak)', () => {
    expect(() => {
      assertChildEnvSafe('cli-engine', { ANTHROPIC_API_KEY: '' });
    }).toThrow(EnvPolicyError);
  });

  it('a raw copy of the dirty parent env fails for every kind', () => {
    for (const kind of KINDS) {
      expect(() => {
        assertChildEnvSafe(kind, DIRTY);
      }).toThrow(EnvPolicyError);
    }
  });

  it('sdk-engine is allowed the API key', () => {
    expect(() => {
      assertChildEnvSafe('sdk-engine', { ANTHROPIC_API_KEY: 'k' });
    }).not.toThrow();
  });
});

describe('deny lists', () => {
  it('ALWAYS_DENIED covers every OAuth-style token', () => {
    expect([...ALWAYS_DENIED].sort()).toEqual([...OAUTH_LIKE].sort());
  });

  it('API_CREDENTIALS includes the Anthropic key and cloud secrets', () => {
    expect(API_CREDENTIALS).toEqual(
      expect.arrayContaining([
        'ANTHROPIC_API_KEY',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'AWS_BEARER_TOKEN_BEDROCK',
        'GOOGLE_APPLICATION_CREDENTIALS',
      ]),
    );
  });
});
