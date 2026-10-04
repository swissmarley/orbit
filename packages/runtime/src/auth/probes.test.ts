import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { OrbitConfig, type OrbitConfigInput } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type FakeClaude,
  type FakeClaudeOptions,
  makeFakeClaude,
} from '../../test/fake-claude-auth';
import type { Env } from '../env';
import { findExecutable, parseVersion, systemProbes } from './probes';
import { resolveAuth } from './resolver';

const API_KEY = 'sk-ant-api03-TEST-probe-key';
const AUTH_TOKEN = 'TEST-probe-auth-token';
const OAUTH_VALUE = 'sk-ant-oat01-TEST-probe-oauth';
const SESSION_TOKEN = 'TEST-probe-session-access';

const config = (input: Partial<OrbitConfigInput> = {}): OrbitConfig =>
  OrbitConfig.parse({ home: '/tmp/x', ...input });

// ---------------------------------------------------------------------------
// findExecutable / parseVersion
// ---------------------------------------------------------------------------

describe('findExecutable', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orbit-find-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const dir = (name: string): string => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const file = (d: string, name: string, mode: number): string => {
    const p = join(d, name);
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, mode);
    return p;
  };

  it('finds an executable in PATH', () => {
    const a = dir('a');
    const p = file(a, 'claude', 0o755);
    expect(findExecutable('claude', a)).toBe(p);
  });

  it('first PATH entry wins', () => {
    const a = dir('a');
    const b = dir('b');
    const pa = file(a, 'claude', 0o755);
    file(b, 'claude', 0o755);
    expect(findExecutable('claude', [a, b].join(delimiter))).toBe(pa);
  });

  it('skips a non-executable file and keeps searching', () => {
    const a = dir('a');
    const b = dir('b');
    file(a, 'claude', 0o644);
    const pb = file(b, 'claude', 0o755);
    expect(findExecutable('claude', [a, b].join(delimiter))).toBe(pb);
  });

  it('skips empty PATH segments and missing directories', () => {
    const b = dir('b');
    const pb = file(b, 'claude', 0o755);
    const path = ['', join(root, 'missing'), '', b].join(delimiter);
    expect(findExecutable('claude', path)).toBe(pb);
  });

  it('returns null when not found, or when PATH is unset/empty', () => {
    const a = dir('a');
    expect(findExecutable('claude', a)).toBeNull();
    expect(findExecutable('claude', undefined)).toBeNull();
    expect(findExecutable('claude', '')).toBeNull();
  });

  // A directory has the x bit (search permission), so accessSync(X_OK) passes.
  // `which` skips directories; findExecutable should too.
  it('skips a directory named claude and keeps searching', () => {
    const a = dir('a');
    mkdirSync(join(a, 'claude'));
    const b = dir('b');
    const pb = file(b, 'claude', 0o755);
    expect(findExecutable('claude', [a, b].join(delimiter))).toBe(pb);
  });
});

describe('parseVersion', () => {
  it.each([
    ['2.1.289 (Claude Code)\n', '2.1.289'],
    ['claude 1.0.0-beta.3', '1.0.0-beta.3'],
    ['v10.20.30', '10.20.30'],
    ['', null],
    ['no version here', null],
    ['1.2', null],
  ])('%j → %j', (input, want) => {
    expect(parseVersion(input)).toBe(want);
  });
});

// ---------------------------------------------------------------------------
// systemProbes against a fake `claude` executable
// ---------------------------------------------------------------------------

describe('systemProbes with a fake claude', () => {
  let fakes: FakeClaude[] = [];
  const fake = (opts?: FakeClaudeOptions): FakeClaude => {
    const f = makeFakeClaude(opts);
    fakes.push(f);
    return f;
  };
  afterEach(() => {
    for (const f of fakes) f.cleanup();
    fakes = [];
  });

  /** A dirty parent env: credentials Orbit might hold, plus harmless basics. */
  const dirtyEnv = (f: FakeClaude, extra: Env = {}): Env => ({
    PATH: f.dir,
    HOME: f.dir,
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: join(f.dir, 'claude-config'),
    ANTHROPIC_API_KEY: API_KEY,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH_VALUE,
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: SESSION_TOKEN,
    CLAUDE_CODE_SESSION_ID: 'TEST-session-id',
    GITHUB_TOKEN: 'ghp_TEST',
    ...extra,
  });

  it('findClaude locates claude on the given env PATH', async () => {
    const f = fake();
    await expect(systemProbes(config(), dirtyEnv(f)).findClaude()).resolves.toBe(f.path);
  });

  it('findClaude returns null when claude is not on PATH', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'orbit-empty-'));
    try {
      await expect(systemProbes(config(), { PATH: empty }).findClaude()).resolves.toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('findClaude prefers config.claudePath over PATH', async () => {
    const onPath = fake();
    const configured = fake();
    const probes = systemProbes(config({ claudePath: configured.path }), dirtyEnv(onPath));
    await expect(probes.findClaude()).resolves.toBe(configured.path);
  });

  it('findClaude returns null when config.claudePath is not executable (no PATH fallback)', async () => {
    const onPath = fake();
    const probes = systemProbes(config({ claudePath: join(onPath.dir, 'nope') }), dirtyEnv(onPath));
    await expect(probes.findClaude()).resolves.toBeNull();
  });

  it('cliStatus parses a logged-in subscription and the version', async () => {
    const f = fake();
    const status = await systemProbes(config(), dirtyEnv(f)).cliStatus(f.path);
    expect(status).toEqual({
      path: f.path,
      version: '2.1.289',
      loggedIn: true,
      authMethod: 'oauth_token',
      apiProvider: 'firstParty',
      error: null,
    });
    expect(f.received('auth')?.argv).toEqual(['auth', 'status', '--json']);
    expect(f.received('version')?.argv).toEqual(['--version']);
  });

  it('the claude child never receives API keys or OAuth/session tokens, even when Orbit holds them', async () => {
    const f = fake();
    await systemProbes(config(), dirtyEnv(f)).cliStatus(f.path);

    for (const which of ['auth', 'version'] as const) {
      const received = f.received(which);
      expect(received, `fake claude was not invoked for ${which}`).not.toBeNull();
      const env = received?.env ?? {};
      // Positive control: the dump is real and allowlisted vars do arrive.
      expect(env.HOME).toBe(f.dir);
      expect(env.PATH).toBe(f.dir);
      expect(env.CLAUDE_CONFIG_DIR).toBe(join(f.dir, 'claude-config'));
      // Negative guarantee, by name...
      for (const name of [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
        'CLAUDE_CODE_SESSION_ID',
        'GITHUB_TOKEN',
      ]) {
        expect(env, `${name} reached the ${which} child`).not.toHaveProperty(name);
      }
      // ...and by bytes.
      const blob = JSON.stringify(env);
      for (const v of [API_KEY, AUTH_TOKEN, OAUTH_VALUE, SESSION_TOKEN]) {
        expect(blob).not.toContain(v);
      }
    }
  });

  it("the probe reports the CLI's own login, not Orbit's API key", async () => {
    // This fake would claim an api_key login if ANTHROPIC_API_KEY reached it.
    const f = fake({ reflectApiKey: true });
    const status = await systemProbes(config(), dirtyEnv(f)).cliStatus(f.path);
    expect(status.authMethod).toBe('oauth_token');
  });

  it('logged out: exit 1 with {"loggedIn":false} → loggedIn false, no throw', async () => {
    const f = fake({ status: { loggedIn: false }, statusExit: 1 });
    const status = await systemProbes(config(), dirtyEnv(f)).cliStatus(f.path);
    expect(status).toMatchObject({
      loggedIn: false,
      authMethod: null,
      apiProvider: null,
      error: null,
      version: '2.1.289',
    });
  });

  it('non-JSON failure rejects with the stderr text', async () => {
    const f = fake({ status: null, statusExit: 3, statusStderr: 'unknown command "auth"' });
    await expect(systemProbes(config(), dirtyEnv(f)).cliStatus(f.path)).rejects.toThrow(
      'unknown command "auth"',
    );
  });

  it('a failing --version does not break the status probe', async () => {
    const f = fake({ version: 'oops', versionExit: 1 });
    const status = await systemProbes(config(), dirtyEnv(f)).cliStatus(f.path);
    expect(status.version).toBeNull();
    expect(status.loggedIn).toBe(true);
  });

  it('ignores non-string / non-boolean fields from a confused CLI', async () => {
    const f = fake({ status: { loggedIn: 'yes', authMethod: 42, apiProvider: ['x'] } });
    const status = await systemProbes(config(), dirtyEnv(f)).cliStatus(f.path);
    expect(status).toMatchObject({ loggedIn: false, authMethod: null, apiProvider: null });
  });

  it('a hanging CLI is killed after the timeout and the probe rejects', async () => {
    const f = fake({ hangMs: 10_000 });
    const started = Date.now();
    await expect(systemProbes(config(), dirtyEnv(f), 300).cliStatus(f.path)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // End-to-end through resolveAuth with real (fake-backed) probes.
  it('resolveAuth: stray API key + fake subscription login → SdkDriver + stray_api_key warning', async () => {
    const f = fake();
    const env = dirtyEnv(f);
    const r = await resolveAuth({ config: config(), env, probes: systemProbes(config(), env) });
    expect(r.driver).toBe('sdk');
    expect(r.cli?.loggedIn).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['stray_api_key']);
    expect(JSON.stringify(r)).not.toContain(OAUTH_VALUE);
    expect(JSON.stringify(r)).not.toContain(API_KEY);
  });

  it('resolveAuth: no key + fake subscription login → CliDriver', async () => {
    const f = fake();
    const env: Env = { PATH: f.dir, HOME: f.dir };
    const r = await resolveAuth({ config: config(), env, probes: systemProbes(config(), env) });
    expect(r.driver).toBe('cli');
    expect(r.authMethod).toBe('subscription');
    expect(r.cli?.version).toBe('2.1.289');
  });

  it('resolveAuth: crashing CLI → cli_probe_failed warning, onboarding, no throw', async () => {
    const f = fake({ status: null, statusExit: 1, statusStderr: 'segfault' });
    const env: Env = { PATH: f.dir, HOME: f.dir };
    const r = await resolveAuth({ config: config(), env, probes: systemProbes(config(), env) });
    expect(r.driver).toBeNull();
    expect(r.warnings.map((w) => w.code)).toEqual(['cli_probe_failed']);
    expect(r.warnings[0]?.message).toContain('segfault');
    expect(r.onboarding?.reason).toMatch(/installed but not logged in/);
  });
});
