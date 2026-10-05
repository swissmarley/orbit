import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OrbitError } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultHome, loadConfig } from './config';
import type { Env } from './env';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orbit-config-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const writeConfig = (value: unknown): void => {
  writeFileSync(join(home, 'config.json'), JSON.stringify(value));
};
const env = (extra: Env = {}): Env => ({ ORBIT_HOME: home, ...extra });

function expectInvalid(fn: () => unknown, message: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(OrbitError);
  expect((caught as OrbitError).code).toBe('invalid_config');
  expect((caught as OrbitError).message).toMatch(message);
}

describe('defaultHome', () => {
  it('uses ORBIT_HOME when set, resolved to an absolute path', () => {
    expect(defaultHome({ ORBIT_HOME: 'relative/orbit' })).toBe(resolve('relative/orbit'));
  });
  it('falls back to ~/.orbit', () => {
    expect(defaultHome({})).toBe(join(homedir(), '.orbit'));
  });
});

describe('loadConfig: defaults', () => {
  it('without config.json or env yields safe local defaults under ORBIT_HOME', () => {
    const c = loadConfig(env());
    expect(c).toMatchObject({
      home,
      mode: 'local',
      api: { host: '127.0.0.1', port: 7420, allowedOrigins: [] },
      driver: null,
      models: { default: 'opus', triage: 'haiku' },
      claudePath: null,
      sdk: { bare: true, apiKeyHelper: null },
      limits: { maxConcurrentRuns: { cli: 2, sdk: 4, mock: 8 } },
    });
    expect(c.principals).toHaveLength(1);
  });

  it('overrides.home wins over ORBIT_HOME and is where config.json is read', () => {
    const other = mkdtempSync(join(tmpdir(), 'orbit-config-other-'));
    try {
      writeFileSync(join(other, 'config.json'), JSON.stringify({ api: { port: 9001 } }));
      writeConfig({ api: { port: 9002 } });
      const c = loadConfig(env(), { home: other });
      expect(c.home).toBe(other);
      expect(c.api.port).toBe(9001);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('loadConfig: config.json', () => {
  it('merges file values over defaults, keeping defaults for missing nested keys', () => {
    writeConfig({
      mode: 'hosted',
      api: { port: 8080 },
      models: { default: 'sonnet' },
      sdk: { apiKeyHelper: '/usr/local/bin/key' },
      claudePath: '/opt/claude',
      driver: 'sdk',
      principals: [
        { id: 'a', kind: 'human' },
        { id: 'svc', kind: 'service' },
      ],
    });
    const c = loadConfig(env());
    expect(c.mode).toBe('hosted');
    expect(c.api).toEqual({ host: '127.0.0.1', port: 8080, allowedOrigins: [] });
    expect(c.models).toEqual({ default: 'sonnet', triage: 'haiku' });
    expect(c.sdk).toEqual({ bare: true, apiKeyHelper: '/usr/local/bin/key' });
    expect(c.claudePath).toBe('/opt/claude');
    expect(c.driver).toBe('sdk');
    expect(c.principals.map((p) => p.id)).toEqual(['a', 'svc']);
  });

  it('a "home" key inside config.json cannot redirect ORBIT_HOME', () => {
    writeConfig({ home: '/somewhere/else' });
    expect(loadConfig(env()).home).toBe(home);
  });

  it('drops unknown keys, so credentials pasted into config.json never enter the config', () => {
    writeConfig({ anthropicApiKey: 'sk-ant-api03-TEST-in-file', sdk: { apiKey: 'sk-ant-TEST-2' } });
    const json = JSON.stringify(loadConfig(env()));
    expect(json).not.toContain('sk-ant-api03-TEST-in-file');
    expect(json).not.toContain('sk-ant-TEST-2');
  });

  it('malformed JSON → invalid_config naming the file', () => {
    writeFileSync(join(home, 'config.json'), '{ "mode": "local", ');
    expectInvalid(() => loadConfig(env()), /Cannot parse .*config\.json/);
  });

  it.each([
    { scenario: 'unknown mode', file: { mode: 'cloud' } },
    { scenario: 'port out of range', file: { api: { port: 70000 } } },
    { scenario: 'port not an integer', file: { api: { port: 80.5 } } },
    { scenario: 'empty principal list', file: { principals: [] } },
    { scenario: 'unknown driver', file: { driver: 'gpt' } },
    { scenario: 'zero concurrency', file: { limits: { maxConcurrentRuns: { cli: 0 } } } },
  ])('schema violation in file ($scenario) → invalid_config', ({ file }) => {
    writeConfig(file);
    expectInvalid(() => loadConfig(env()), /Invalid configuration/);
  });

  it('a config.json directory instead of a file is reported as invalid_config', () => {
    mkdirSync(join(home, 'config.json'));
    expectInvalid(() => loadConfig(env()), /Cannot parse/);
  });
});

describe('loadConfig: environment overrides beat config.json', () => {
  beforeEach(() => {
    writeConfig({
      mode: 'local',
      driver: 'cli',
      api: { host: '127.0.0.1', port: 8080 },
      models: { default: 'sonnet', triage: 'sonnet' },
      sdk: { bare: true, apiKeyHelper: '/from/file' },
      claudePath: '/from/file/claude',
      limits: { maxConcurrentRuns: { cli: 1, sdk: 1, mock: 1 } },
    });
  });

  it.each<{
    scenario: string;
    vars: Env;
    check: (c: ReturnType<typeof loadConfig>) => unknown;
    want: unknown;
  }>([
    {
      scenario: 'ORBIT_HOST',
      vars: { ORBIT_HOST: '0.0.0.0' },
      check: (c) => c.api,
      want: { host: '0.0.0.0', port: 8080, allowedOrigins: [] },
    },
    {
      scenario: 'ORBIT_PORT',
      vars: { ORBIT_PORT: '9999' },
      check: (c) => c.api,
      want: { host: '127.0.0.1', port: 9999, allowedOrigins: [] },
    },
    {
      scenario: 'ORBIT_DRIVER',
      vars: { ORBIT_DRIVER: ' mock ' },
      check: (c) => c.driver,
      want: 'mock',
    },
    {
      scenario: 'ORBIT_MODE',
      vars: { ORBIT_MODE: 'hosted' },
      check: (c) => c.mode,
      want: 'hosted',
    },
    {
      scenario: 'ORBIT_DEFAULT_MODEL',
      vars: { ORBIT_DEFAULT_MODEL: 'opus' },
      check: (c) => c.models,
      want: { default: 'opus', triage: 'sonnet' },
    },
    {
      scenario: 'ORBIT_TRIAGE_MODEL',
      vars: { ORBIT_TRIAGE_MODEL: 'haiku' },
      check: (c) => c.models,
      want: { default: 'sonnet', triage: 'haiku' },
    },
    {
      scenario: 'ORBIT_SDK_BARE=false',
      vars: { ORBIT_SDK_BARE: 'false' },
      check: (c) => c.sdk.bare,
      want: false,
    },
    {
      scenario: 'ORBIT_SDK_BARE=" OFF "',
      vars: { ORBIT_SDK_BARE: ' OFF ' },
      check: (c) => c.sdk.bare,
      want: false,
    },
    {
      scenario: 'ORBIT_API_KEY_HELPER',
      vars: { ORBIT_API_KEY_HELPER: '/from/env' },
      check: (c) => c.sdk.apiKeyHelper,
      want: '/from/env',
    },
    {
      scenario: 'ORBIT_CLAUDE_PATH',
      vars: { ORBIT_CLAUDE_PATH: '/from/env/claude' },
      check: (c) => c.claudePath,
      want: '/from/env/claude',
    },
    {
      scenario: 'ORBIT_MAX_CONCURRENT_RUNS applies to every driver',
      vars: { ORBIT_MAX_CONCURRENT_RUNS: '3' },
      check: (c) => c.limits.maxConcurrentRuns,
      want: { cli: 3, sdk: 3, mock: 3 },
    },
  ])('$scenario', ({ vars, check, want }) => {
    expect(check(loadConfig(env(vars)))).toEqual(want);
  });

  it.each<{ scenario: string; vars: Env }>([
    {
      scenario: 'empty strings',
      vars: {
        ORBIT_HOST: '',
        ORBIT_PORT: '',
        ORBIT_DRIVER: '',
        ORBIT_MODE: '',
        ORBIT_SDK_BARE: '',
        ORBIT_MAX_CONCURRENT_RUNS: '',
      },
    },
    {
      scenario: 'whitespace driver/mode/bare',
      vars: { ORBIT_DRIVER: '  ', ORBIT_MODE: ' ', ORBIT_SDK_BARE: '  ' },
    },
    { scenario: 'undefined values', vars: { ORBIT_PORT: undefined, ORBIT_DRIVER: undefined } },
  ])('$scenario are treated as unset (file values survive)', ({ vars }) => {
    const c = loadConfig(env(vars));
    expect(c.driver).toBe('cli');
    expect(c.mode).toBe('local');
    expect(c.api).toEqual({ host: '127.0.0.1', port: 8080, allowedOrigins: [] });
    expect(c.sdk.bare).toBe(true);
    expect(c.limits.maxConcurrentRuns.cli).toBe(1);
  });

  // ORBIT_SDK_BARE/ORBIT_DRIVER/ORBIT_MODE trim whitespace; ORBIT_PORT does not,
  // and Number('  ') === 0, so a blank port silently becomes 0 (random port).
  it('whitespace-only ORBIT_PORT is treated as unset, not as port 0', () => {
    const c = loadConfig(env({ ORBIT_PORT: '  ' }));
    expect(c.api.port).toBe(8080);
  });
});

describe('loadConfig: App origins (ADR-011)', () => {
  it('ORBIT_ALLOWED_ORIGINS adds loopback and desktop origins, normalised', () => {
    const c = loadConfig(
      env({
        ORBIT_ALLOWED_ORIGINS: ' http://localhost:5173/ , HTTP://127.0.0.1:4173,tauri://localhost',
      }),
    );
    expect(c.api.allowedOrigins).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:4173',
      'tauri://localhost',
    ]);
  });

  it.each([
    'https://evil.example',
    'http://192.168.1.10:5173',
    'http://localhost:5173/path',
    'http://user@localhost:5173',
    'file://',
    'null',
    '*',
  ])('refuses %s', (origin) => {
    expect(() => loadConfig(env({ ORBIT_ALLOWED_ORIGINS: origin }))).toThrow(/allowedOrigins/);
  });
});

describe('loadConfig: invalid environment values', () => {
  it.each<{ scenario: string; vars: Env; message: RegExp }>([
    {
      scenario: 'ORBIT_DRIVER=gpt',
      vars: { ORBIT_DRIVER: 'gpt' },
      message: /ORBIT_DRIVER must be one of sdk, cli, mock \(got "gpt"\)/,
    },
    {
      scenario: 'ORBIT_DRIVER=CLI (case-sensitive)',
      vars: { ORBIT_DRIVER: 'CLI' },
      message: /ORBIT_DRIVER must be one of/,
    },
    {
      scenario: 'ORBIT_MODE=cloud',
      vars: { ORBIT_MODE: 'cloud' },
      message: /ORBIT_MODE must be local or hosted \(got "cloud"\)/,
    },
    {
      scenario: 'ORBIT_PORT=http',
      vars: { ORBIT_PORT: 'http' },
      message: /ORBIT_PORT must be an integer/,
    },
    {
      scenario: 'ORBIT_PORT=80.5',
      vars: { ORBIT_PORT: '80.5' },
      message: /ORBIT_PORT must be an integer/,
    },
    {
      scenario: 'ORBIT_PORT=70000',
      vars: { ORBIT_PORT: '70000' },
      message: /Invalid configuration/,
    },
    { scenario: 'ORBIT_PORT=-1', vars: { ORBIT_PORT: '-1' }, message: /Invalid configuration/ },
    {
      scenario: 'ORBIT_SDK_BARE=maybe',
      vars: { ORBIT_SDK_BARE: 'maybe' },
      message: /ORBIT_SDK_BARE must be a boolean/,
    },
    {
      scenario: 'ORBIT_MAX_CONCURRENT_RUNS=two',
      vars: { ORBIT_MAX_CONCURRENT_RUNS: 'two' },
      message: /ORBIT_MAX_CONCURRENT_RUNS must be an integer/,
    },
    {
      scenario: 'ORBIT_MAX_CONCURRENT_RUNS=0',
      vars: { ORBIT_MAX_CONCURRENT_RUNS: '0' },
      message: /Invalid configuration/,
    },
    {
      scenario: 'ORBIT_PLUGIN_SANDBOX=strict',
      vars: { ORBIT_PLUGIN_SANDBOX: 'strict' },
      message: /ORBIT_PLUGIN_SANDBOX must be auto, required or off \(got "strict"\)/,
    },
    {
      scenario: 'ORBIT_PLUGIN_CATALOG_URL over plain http to another host',
      vars: { ORBIT_PLUGIN_CATALOG_URL: 'http://catalog.example.com/catalog.json' },
      message: /Invalid configuration/,
    },
    {
      scenario: 'ORBIT_NPM_REGISTRY with credentials in the URL',
      vars: { ORBIT_NPM_REGISTRY: 'https://user:pw@registry.example.com' },
      message: /Invalid configuration/,
    },
    {
      scenario: 'ORBIT_NPM_REGISTRY as a file',
      vars: { ORBIT_NPM_REGISTRY: 'file:///srv/npm' },
      message: /Invalid configuration/,
    },
  ])('$scenario → invalid_config', ({ vars, message }) => {
    expectInvalid(() => loadConfig(env(vars)), message);
  });
});

describe('loadConfig: plugins (ADR-019)', () => {
  it('sandboxes plugins when it can, uses the published catalog and npm by default', () => {
    expect(loadConfig(env()).plugins).toEqual({
      sandbox: 'auto',
      catalogUrl: 'https://raw.githubusercontent.com/swissmarley/orbit/main/plugins/catalog.json',
      npmRegistry: 'https://registry.npmjs.org',
      storeDir: null,
    });
  });

  it('takes the sandbox mode, catalog, registry and store from the environment', () => {
    const c = loadConfig(
      env({
        ORBIT_PLUGIN_SANDBOX: 'required',
        ORBIT_PLUGIN_CATALOG_URL: 'file:///srv/orbit/catalog.json',
        ORBIT_NPM_REGISTRY: 'http://127.0.0.1:4873',
        ORBIT_PLUGIN_STORE: 'relative/store',
      }),
    );
    expect(c.plugins).toMatchObject({
      sandbox: 'required',
      catalogUrl: 'file:///srv/orbit/catalog.json',
      npmRegistry: 'http://127.0.0.1:4873',
    });
    expect(c.plugins.storeDir).toMatch(/^\/.*relative\/store$/);
  });
});

describe('loadConfig: credentials never enter the config object', () => {
  it('ignores API keys and OAuth tokens in the environment', () => {
    const c = loadConfig(
      env({
        ANTHROPIC_API_KEY: 'sk-ant-api03-TEST-env-key',
        ANTHROPIC_AUTH_TOKEN: 'TEST-auth-token-value',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-TEST-oauth-value',
        CLAUDE_CODE_USE_BEDROCK: '1',
      }),
    );
    const json = JSON.stringify(c);
    for (const v of [
      'sk-ant-api03-TEST-env-key',
      'TEST-auth-token-value',
      'sk-ant-oat01-TEST-oauth-value',
    ]) {
      expect(json).not.toContain(v);
    }
    expect(c.driver).toBeNull();
  });
});

describe('loadConfig: hosted mode (ADR-015)', () => {
  it('reads the public URL, TLS files and OIDC client from the environment', () => {
    const c = loadConfig(
      env({
        ORBIT_MODE: 'hosted',
        ORBIT_PUBLIC_URL: 'https://Orbit.Example.com/',
        ORBIT_TLS_CERT: 'certs/orbit.pem',
        ORBIT_TLS_KEY: '/etc/orbit/key.pem',
        ORBIT_OIDC_ISSUER: 'https://id.example.com/realms/orbit',
        ORBIT_OIDC_CLIENT_ID: 'orbit',
        ORBIT_OIDC_CLIENT_SECRET: 'TEST-oidc-client-secret',
      }),
    );
    expect(c.mode).toBe('hosted');
    expect(c.hosted).toEqual({
      publicUrl: 'https://orbit.example.com',
      tls: { certFile: resolve('certs/orbit.pem'), keyFile: '/etc/orbit/key.pem' },
      oidc: {
        issuer: 'https://id.example.com/realms/orbit',
        clientId: 'orbit',
        scopes: ['openid', 'email', 'profile'],
      },
    });
    // The client secret is a credential: orbitd reads it, the config never holds it.
    expect(JSON.stringify(c)).not.toContain('TEST-oidc-client-secret');
  });

  it('environment values override config.json field by field', () => {
    writeConfig({
      hosted: {
        publicUrl: 'https://old.example.com',
        oidc: { issuer: 'https://id.example.com', clientId: 'file-client', scopes: ['openid'] },
      },
    });
    const c = loadConfig(env({ ORBIT_OIDC_CLIENT_ID: 'env-client' }));
    expect(c.hosted.publicUrl).toBe('https://old.example.com');
    expect(c.hosted.oidc).toEqual({
      issuer: 'https://id.example.com',
      clientId: 'env-client',
      scopes: ['openid'],
    });
  });

  it.each<{ scenario: string; vars: Env; message: RegExp }>([
    {
      scenario: 'an http public URL',
      vars: { ORBIT_PUBLIC_URL: 'http://orbit.example.com' },
      message: /publicUrl/,
    },
    {
      scenario: 'a public URL with a path',
      vars: { ORBIT_PUBLIC_URL: 'https://example.com/orbit' },
      message: /publicUrl/,
    },
    {
      scenario: 'a TLS certificate without its key',
      vars: { ORBIT_TLS_CERT: '/x.pem' },
      message: /both ORBIT_TLS_CERT and ORBIT_TLS_KEY/,
    },
    {
      scenario: 'an issuer without a client id',
      vars: { ORBIT_OIDC_ISSUER: 'https://id.example.com' },
      message: /issuer and a client id/,
    },
    {
      scenario: 'a plain-http remote issuer',
      vars: { ORBIT_OIDC_ISSUER: 'http://id.example.com', ORBIT_OIDC_CLIENT_ID: 'x' },
      message: /issuer/,
    },
  ])('$scenario → invalid_config', ({ vars, message }) => {
    expectInvalid(() => loadConfig(env(vars)), message);
  });
});
