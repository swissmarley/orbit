import { type AuthMethod, type DriverKind, OrbitConfig, type OrbitConfigInput } from '@orbit/core';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import {
  type ApiCredential,
  type AuthProbes,
  type AuthWarning,
  type CliStatus,
  ONBOARDING_STEPS,
  authLabel,
  cliAuthMethod,
  detectApiCredential,
  resolveAuth,
} from './resolver';

// ---------------------------------------------------------------------------
// Fixtures: fake probes, literal envs, no real processes or credentials.
// ---------------------------------------------------------------------------

const API_KEY = 'sk-ant-api03-TEST-ONLY-not-a-real-key';
const OAUTH_VALUE = 'sk-ant-oat01-TEST-ONLY-OAUTH-VALUE-must-never-appear';
const CLAUDE_PATH = '/fake/bin/claude';

type CliFixture =
  | { kind: 'absent' }
  | { kind: 'throws'; message: string }
  | { kind: 'status'; status: Partial<CliStatus> };

const NO_CLI: CliFixture = { kind: 'absent' };
const SUBSCRIPTION: CliFixture = {
  kind: 'status',
  status: { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' },
};
const LOGGED_OUT: CliFixture = { kind: 'status', status: { loggedIn: false } };

function fakeProbes(fixture: CliFixture) {
  const findClaude = vi.fn<AuthProbes['findClaude']>(() =>
    Promise.resolve(fixture.kind === 'absent' ? null : CLAUDE_PATH),
  );
  const cliStatus = vi.fn<AuthProbes['cliStatus']>((path) => {
    if (fixture.kind === 'throws') return Promise.reject(new Error(fixture.message));
    return Promise.resolve({
      path,
      version: '2.1.289',
      loggedIn: false,
      authMethod: null,
      apiProvider: null,
      error: null,
      ...(fixture.kind === 'status' ? fixture.status : {}),
    });
  });
  return { findClaude, cliStatus } satisfies AuthProbes;
}

function config(input: Partial<OrbitConfigInput> = {}): OrbitConfig {
  return OrbitConfig.parse({ home: '/tmp/x', ...input });
}

const HOSTED: Partial<OrbitConfigInput> = { mode: 'hosted' };
const ALL_INTERFACES: Partial<OrbitConfigInput> = { api: { host: '0.0.0.0' } };
const TWO_HUMANS: Partial<OrbitConfigInput> = {
  principals: [
    { id: 'alice', kind: 'human' },
    { id: 'bob', kind: 'human' },
  ],
};
const HUMAN_AND_SERVICE: Partial<OrbitConfigInput> = {
  principals: [
    { id: 'owner', kind: 'human' },
    { id: 'ci-bot', kind: 'service' },
  ],
};

// ---------------------------------------------------------------------------
// The decision table (PLAN.md §2.2). One row per branch.
// ---------------------------------------------------------------------------

interface Row {
  name: string;
  config?: Partial<OrbitConfigInput>;
  env?: Env;
  cli: CliFixture;
  driver: DriverKind | null;
  authMethod: AuthMethod;
  source: 'forced' | 'auto';
  apiCredential: ApiCredential | null;
  refusal: 'compliance_refused' | 'driver_unavailable' | null;
  onboarding: boolean;
  warnings: AuthWarning['code'][];
  /** Whether the CLI must have been probed at all. */
  probed: boolean;
}

const rows: Row[] = [
  // d. forced driver ---------------------------------------------------------
  {
    name: 'ORBIT_DRIVER=mock (demo mode) → MockDriver, the CLI is never probed',
    config: { driver: 'mock' },
    env: { ANTHROPIC_API_KEY: API_KEY },
    cli: SUBSCRIPTION,
    driver: 'mock',
    authMethod: 'mock',
    source: 'forced',
    apiCredential: 'api_key',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: false,
  },
  {
    name: 'ORBIT_DRIVER=sdk with an API key → SdkDriver',
    config: { driver: 'sdk' },
    env: { ANTHROPIC_API_KEY: API_KEY },
    cli: NO_CLI,
    driver: 'sdk',
    authMethod: 'api_key',
    source: 'forced',
    apiCredential: 'api_key',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'ORBIT_DRIVER=sdk but no credentials at all → no driver, driver_unavailable + onboarding',
    config: { driver: 'sdk' },
    cli: NO_CLI,
    driver: null,
    authMethod: 'none',
    source: 'forced',
    apiCredential: null,
    refusal: 'driver_unavailable',
    onboarding: true,
    warnings: [],
    probed: true,
  },
  {
    name: 'ORBIT_DRIVER=sdk with only a subscription login → refused (subscription is never used by the SDK)',
    config: { driver: 'sdk' },
    cli: SUBSCRIPTION,
    driver: null,
    authMethod: 'none',
    source: 'forced',
    apiCredential: null,
    refusal: 'driver_unavailable',
    onboarding: true,
    warnings: [],
    probed: true,
  },
  {
    name: 'ORBIT_DRIVER=cli but claude is not installed → driver_unavailable',
    config: { driver: 'cli' },
    cli: NO_CLI,
    driver: null,
    authMethod: 'none',
    source: 'forced',
    apiCredential: null,
    refusal: 'driver_unavailable',
    onboarding: true,
    warnings: [],
    probed: true,
  },
  {
    name: 'ORBIT_DRIVER=cli, claude installed but logged out → driver_unavailable',
    config: { driver: 'cli' },
    cli: LOGGED_OUT,
    driver: null,
    authMethod: 'none',
    source: 'forced',
    apiCredential: null,
    refusal: 'driver_unavailable',
    onboarding: true,
    warnings: [],
    probed: true,
  },
  {
    name: 'ORBIT_DRIVER=cli, logged in, local single user → CliDriver (subscription)',
    config: { driver: 'cli' },
    cli: SUBSCRIPTION,
    driver: 'cli',
    authMethod: 'subscription',
    source: 'forced',
    apiCredential: null,
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'ORBIT_DRIVER=cli, logged in, but ORBIT_MODE=hosted → compliance_refused',
    config: { driver: 'cli', ...HOSTED },
    cli: SUBSCRIPTION,
    driver: null,
    authMethod: 'subscription',
    source: 'forced',
    apiCredential: null,
    refusal: 'compliance_refused',
    onboarding: true,
    warnings: [],
    probed: true,
  },
  {
    // The CliDriver child never receives ANTHROPIC_API_KEY (ADR-005), so the
    // subscription is what gets billed; "pay-as-you-go will be used" is false.
    name: 'ORBIT_DRIVER=cli with a stray API key while logged in → CliDriver, no pay-as-you-go warning (key is scrubbed)',
    config: { driver: 'cli' },
    env: { ANTHROPIC_API_KEY: API_KEY },
    cli: SUBSCRIPTION,
    driver: 'cli',
    authMethod: 'subscription',
    source: 'forced',
    apiCredential: 'api_key',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },

  // a. API credentials → SdkDriver ------------------------------------------
  {
    name: 'API key only, no claude CLI → SdkDriver (api_key), no warning',
    env: { ANTHROPIC_API_KEY: API_KEY },
    cli: NO_CLI,
    driver: 'sdk',
    authMethod: 'api_key',
    source: 'auto',
    apiCredential: 'api_key',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'API key + claude installed but logged out → SdkDriver, no stray-key warning',
    env: { ANTHROPIC_API_KEY: API_KEY },
    cli: LOGGED_OUT,
    driver: 'sdk',
    authMethod: 'api_key',
    source: 'auto',
    apiCredential: 'api_key',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'CLAUDE_CODE_USE_BEDROCK=1 → SdkDriver (bedrock)',
    env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' },
    cli: NO_CLI,
    driver: 'sdk',
    authMethod: 'bedrock',
    source: 'auto',
    apiCredential: 'bedrock',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'CLAUDE_CODE_USE_VERTEX=true → SdkDriver (vertex)',
    env: { CLAUDE_CODE_USE_VERTEX: 'true' },
    cli: NO_CLI,
    driver: 'sdk',
    authMethod: 'vertex',
    source: 'auto',
    apiCredential: 'vertex',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'Bedrock flag and an API key → Bedrock wins',
    env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: API_KEY },
    cli: NO_CLI,
    driver: 'sdk',
    authMethod: 'bedrock',
    source: 'auto',
    apiCredential: 'bedrock',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'apiKeyHelper in config.json → SdkDriver (api_key_helper)',
    config: { sdk: { apiKeyHelper: '/usr/local/bin/print-key' } },
    cli: NO_CLI,
    driver: 'sdk',
    authMethod: 'api_key_helper',
    source: 'auto',
    apiCredential: 'api_key_helper',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'empty ANTHROPIC_API_KEY is not a credential → onboarding',
    env: { ANTHROPIC_API_KEY: '' },
    cli: NO_CLI,
    driver: null,
    authMethod: 'none',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: true,
    warnings: [],
    probed: true,
  },
  {
    name: 'whitespace-only ANTHROPIC_API_KEY while logged in → still the subscription CLI',
    env: { ANTHROPIC_API_KEY: '   \t' },
    cli: SUBSCRIPTION,
    driver: 'cli',
    authMethod: 'subscription',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'API key on a hosted server → SdkDriver (the guard only limits CliDriver)',
    config: { ...HOSTED, ...ALL_INTERFACES, ...TWO_HUMANS },
    env: { ANTHROPIC_API_KEY: API_KEY },
    cli: NO_CLI,
    driver: 'sdk',
    authMethod: 'api_key',
    source: 'auto',
    apiCredential: 'api_key',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },

  // b. logged-in claude CLI → CliDriver ---------------------------------------
  {
    name: 'no key + logged-in subscription CLI, local → CliDriver (subscription)',
    cli: SUBSCRIPTION,
    driver: 'cli',
    authMethod: 'subscription',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'CLI logged in with a Console API key (authMethod api_key) → CliDriver (claude_cli_other)',
    cli: {
      kind: 'status',
      status: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' },
    },
    driver: 'cli',
    authMethod: 'claude_cli_other',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'CLI logged in through Bedrock (apiProvider bedrock) → CliDriver (claude_cli_other)',
    cli: {
      kind: 'status',
      status: { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'bedrock' },
    },
    driver: 'cli',
    authMethod: 'claude_cli_other',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'subscription CLI but ORBIT_MODE=hosted → refused (compliance_refused)',
    config: HOSTED,
    cli: SUBSCRIPTION,
    driver: null,
    authMethod: 'subscription',
    source: 'auto',
    apiCredential: null,
    refusal: 'compliance_refused',
    onboarding: true,
    warnings: [],
    probed: true,
  },
  {
    name: 'subscription CLI but API bound to 0.0.0.0 → refused (compliance_refused)',
    config: ALL_INTERFACES,
    cli: SUBSCRIPTION,
    driver: null,
    authMethod: 'subscription',
    source: 'auto',
    apiCredential: null,
    refusal: 'compliance_refused',
    onboarding: true,
    warnings: [],
    probed: true,
  },
  {
    name: 'subscription CLI shared by two humans → refused (compliance_refused)',
    config: TWO_HUMANS,
    cli: SUBSCRIPTION,
    driver: null,
    authMethod: 'subscription',
    source: 'auto',
    apiCredential: null,
    refusal: 'compliance_refused',
    onboarding: true,
    warnings: [],
    probed: true,
  },
  {
    name: 'subscription CLI with one human + one service principal → still allowed',
    config: HUMAN_AND_SERVICE,
    cli: SUBSCRIPTION,
    driver: 'cli',
    authMethod: 'subscription',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'non-subscription CLI login on a hosted server → refused too (CliDriver is local-only)',
    config: HOSTED,
    cli: {
      kind: 'status',
      status: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' },
    },
    driver: null,
    authMethod: 'claude_cli_other',
    source: 'auto',
    apiCredential: null,
    refusal: 'compliance_refused',
    onboarding: true,
    warnings: [],
    probed: true,
  },

  // c. nothing → onboarding ---------------------------------------------------
  {
    name: 'fresh machine: no key, no claude CLI → onboarding',
    cli: NO_CLI,
    driver: null,
    authMethod: 'none',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: true,
    warnings: [],
    probed: true,
  },
  {
    name: 'claude installed but logged out, no key → onboarding',
    cli: LOGGED_OUT,
    driver: null,
    authMethod: 'none',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: true,
    warnings: [],
    probed: true,
  },

  // Warnings -----------------------------------------------------------------
  {
    name: 'stray API key while logged in with a subscription → SdkDriver + billing warning',
    env: { ANTHROPIC_API_KEY: API_KEY },
    cli: SUBSCRIPTION,
    driver: 'sdk',
    authMethod: 'api_key',
    source: 'auto',
    apiCredential: 'api_key',
    refusal: null,
    onboarding: false,
    warnings: ['stray_api_key'],
    probed: true,
  },
  {
    name: 'stray API key while CLI uses a non-subscription login → SdkDriver, no billing warning',
    env: { ANTHROPIC_API_KEY: API_KEY },
    cli: {
      kind: 'status',
      status: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' },
    },
    driver: 'sdk',
    authMethod: 'api_key',
    source: 'auto',
    apiCredential: 'api_key',
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: 'CLAUDE_CODE_OAUTH_TOKEN set but claude not logged in → onboarding + "token not forwarded" warning',
    env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_VALUE },
    cli: LOGGED_OUT,
    driver: null,
    authMethod: 'none',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: true,
    warnings: ['oauth_token_env_not_forwarded'],
    probed: true,
  },
  {
    name: 'CLAUDE_CODE_OAUTH_TOKEN set and claude not installed → "token not forwarded" warning',
    env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_VALUE },
    cli: NO_CLI,
    driver: null,
    authMethod: 'none',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: true,
    warnings: ['oauth_token_env_not_forwarded'],
    probed: true,
  },
  {
    name: 'CLAUDE_CODE_OAUTH_TOKEN set while claude is logged in on its own → CliDriver, no warning',
    env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_VALUE },
    cli: SUBSCRIPTION,
    driver: 'cli',
    authMethod: 'subscription',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: false,
    warnings: [],
    probed: true,
  },
  {
    name: '`claude auth status` crashes → onboarding + cli_probe_failed warning, no exception',
    cli: { kind: 'throws', message: 'spawn EACCES' },
    driver: null,
    authMethod: 'none',
    source: 'auto',
    apiCredential: null,
    refusal: null,
    onboarding: true,
    warnings: ['cli_probe_failed'],
    probed: true,
  },
  {
    name: '`claude auth status` crashes but an API key is set → SdkDriver + cli_probe_failed warning',
    env: { ANTHROPIC_API_KEY: API_KEY },
    cli: { kind: 'throws', message: 'timed out' },
    driver: 'sdk',
    authMethod: 'api_key',
    source: 'auto',
    apiCredential: 'api_key',
    refusal: null,
    onboarding: false,
    warnings: ['cli_probe_failed'],
    probed: true,
  },
];

describe('resolveAuth decision table (PLAN.md §2.2)', () => {
  it.each(rows)('$name', async (row) => {
    const probes = fakeProbes(row.cli);
    const r = await resolveAuth({ config: config(row.config), env: row.env ?? {}, probes });

    expect({
      driver: r.driver,
      authMethod: r.authMethod,
      source: r.source,
      apiCredential: r.apiCredential,
      refusal: r.refusal?.code ?? null,
      onboarding: r.onboarding !== null,
      warnings: r.warnings.map((w) => w.code).sort(),
    }).toEqual({
      driver: row.driver,
      authMethod: row.authMethod,
      source: row.source,
      apiCredential: row.apiCredential,
      refusal: row.refusal,
      onboarding: row.onboarding,
      warnings: [...row.warnings].sort(),
    });

    // Every resolution carries a human-readable label that matches its method.
    expect(r.label.trim().length).toBeGreaterThan(0);
    expect(r.label).toBe(authLabel(r.authMethod, r.cli));

    // A driver and a refusal are mutually exclusive; a refusal always has a hint.
    if (r.driver !== null) expect(r.refusal).toBeNull();
    if (r.refusal) {
      expect(r.refusal.message.length).toBeGreaterThan(0);
      expect(r.refusal.hint.length).toBeGreaterThan(0);
    }
    for (const w of r.warnings) expect(w.message.length).toBeGreaterThan(0);

    if (row.probed) {
      expect(probes.findClaude).toHaveBeenCalledTimes(1);
    } else {
      expect(probes.findClaude).not.toHaveBeenCalled();
      expect(probes.cliStatus).not.toHaveBeenCalled();
      expect(r.cli).toBeNull();
    }
  });
});

describe('resolveAuth details', () => {
  const refused = async (cfg: Partial<OrbitConfigInput>) =>
    resolveAuth({ config: config(cfg), env: {}, probes: fakeProbes(SUBSCRIPTION) });

  it.each([
    { scenario: 'hosted mode', cfg: HOSTED, why: /ORBIT_MODE=hosted/ },
    { scenario: 'API bound to 0.0.0.0', cfg: ALL_INTERFACES, why: /0\.0\.0\.0.*not a loopback/ },
    { scenario: 'two human principals', cfg: TWO_HUMANS, why: /2 human principals/ },
  ])(
    'compliance refusal for $scenario explains why and how to use an API key',
    async ({ cfg, why }) => {
      const r = await refused(cfg);
      expect(r.refusal?.code).toBe('compliance_refused');
      expect(r.refusal?.message).toMatch(why);
      expect(r.refusal?.message).toMatch(/Anthropic does not allow third-party/);
      expect(r.refusal?.hint).toMatch(/API key/);
      expect(r.refusal?.hint).toMatch(/ANTHROPIC_API_KEY/);
      expect(r.guard.allowed).toBe(false);
      expect(r.onboarding?.steps).toEqual([...ONBOARDING_STEPS]);
    },
  );

  it('onboarding offers exactly the three ways in: subscription CLI, API key, demo mode', async () => {
    const r = await resolveAuth({ config: config(), env: {}, probes: fakeProbes(NO_CLI) });
    expect(r.onboarding?.steps).toHaveLength(3);
    const [cli, apiKey, demo] = r.onboarding?.steps ?? [];
    expect(cli).toMatch(/claude auth login/);
    expect(cli).toMatch(/127\.0\.0\.1/);
    expect(apiKey).toMatch(/ANTHROPIC_API_KEY/);
    expect(apiKey).toMatch(/CLAUDE_CODE_USE_BEDROCK=1/);
    expect(apiKey).toMatch(/CLAUDE_CODE_USE_VERTEX=1/);
    expect(demo).toMatch(/ORBIT_DRIVER=mock/);
  });

  it('onboarding reason distinguishes "installed but not logged in" from "not found"', async () => {
    const notFound = await resolveAuth({ config: config(), env: {}, probes: fakeProbes(NO_CLI) });
    const loggedOut = await resolveAuth({
      config: config(),
      env: {},
      probes: fakeProbes(LOGGED_OUT),
    });
    expect(notFound.onboarding?.reason).toMatch(/not found/);
    expect(notFound.onboarding?.reason).not.toMatch(/not logged in/);
    expect(loggedOut.onboarding?.reason).toMatch(/installed but not logged in/);
    expect(loggedOut.onboarding?.reason).not.toMatch(/not found/);
  });

  it('forced cli refusals distinguish "not found on PATH" from "not logged in"', async () => {
    const cfg = config({ driver: 'cli' });
    const missing = await resolveAuth({ config: cfg, env: {}, probes: fakeProbes(NO_CLI) });
    const out = await resolveAuth({ config: cfg, env: {}, probes: fakeProbes(LOGGED_OUT) });
    expect(missing.refusal?.message).toMatch(/not found on PATH/);
    expect(out.refusal?.message).toMatch(/not logged in/);
  });

  it('stray-key warning tells the user how to switch back to the subscription', async () => {
    const r = await resolveAuth({
      config: config(),
      env: { ANTHROPIC_API_KEY: API_KEY },
      probes: fakeProbes(SUBSCRIPTION),
    });
    const w = r.warnings.find((x) => x.code === 'stray_api_key');
    expect(w?.message).toMatch(/pay-as-you-go/);
    expect(w?.message).toMatch(/Unset ANTHROPIC_API_KEY/);
    expect(w?.message).not.toContain(API_KEY);
  });

  it('never copies the OAuth token value or the API key value into the resolution', async () => {
    const envs: Env[] = [
      { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_VALUE },
      { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_VALUE, ANTHROPIC_API_KEY: API_KEY },
    ];
    const fixtures: CliFixture[] = [
      NO_CLI,
      LOGGED_OUT,
      SUBSCRIPTION,
      { kind: 'throws', message: 'x' },
    ];
    const forced: (DriverKind | null)[] = [null, 'sdk', 'cli', 'mock'];
    let checked = 0;
    for (const env of envs) {
      for (const fixture of fixtures) {
        for (const driver of forced) {
          const r = await resolveAuth({
            config: config({ driver }),
            env,
            probes: fakeProbes(fixture),
          });
          const json = JSON.stringify(r);
          expect(json).not.toContain(OAUTH_VALUE);
          expect(json).not.toContain(API_KEY);
          checked++;
        }
      }
    }
    expect(checked).toBe(32);
  });

  it('the OAuth warning is a positive control: it fires on presence alone', async () => {
    const r = await resolveAuth({
      config: config(),
      env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_VALUE },
      probes: fakeProbes(NO_CLI),
    });
    const w = r.warnings.find((x) => x.code === 'oauth_token_env_not_forwarded');
    expect(w?.message).toMatch(/never forwards OAuth credentials/);
    expect(w?.message).toMatch(/claude auth login/);
  });

  it('a crashing probe is reported with its message and the CLI is treated as logged out', async () => {
    const r = await resolveAuth({
      config: config(),
      env: {},
      probes: fakeProbes({ kind: 'throws', message: 'spawn EACCES' }),
    });
    expect(r.cli).toMatchObject({ path: CLAUDE_PATH, loggedIn: false, error: 'spawn EACCES' });
    expect(r.warnings[0]?.message).toContain('spawn EACCES');
  });

  it('a non-Error rejection from the probe is still caught', async () => {
    const probes: AuthProbes = {
      findClaude: () => Promise.resolve(CLAUDE_PATH),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      cliStatus: () => Promise.reject('boom'),
    };
    const r = await resolveAuth({ config: config(), env: {}, probes });
    expect(r.warnings.map((w) => w.code)).toEqual(['cli_probe_failed']);
    expect(r.cli?.error).toBe('boom');
  });

  it('exposes the guard result even when the guard is irrelevant (SDK path)', async () => {
    const r = await resolveAuth({
      config: config(HOSTED),
      env: { ANTHROPIC_API_KEY: API_KEY },
      probes: fakeProbes(NO_CLI),
    });
    expect(r.driver).toBe('sdk');
    expect(r.guard).toMatchObject({ allowed: false, violations: ['hosted_mode'] });
  });
});

describe('detectApiCredential', () => {
  const cfg = config();
  const helper = config({ sdk: { apiKeyHelper: 'print-key' } });
  it.each<{ scenario: string; env: Env; config?: OrbitConfig; want: ApiCredential | null }>([
    { scenario: 'nothing set', env: {}, want: null },
    { scenario: 'API key', env: { ANTHROPIC_API_KEY: API_KEY }, want: 'api_key' },
    { scenario: 'empty API key', env: { ANTHROPIC_API_KEY: '' }, want: null },
    { scenario: 'whitespace API key', env: { ANTHROPIC_API_KEY: ' \n ' }, want: null },
    { scenario: 'undefined API key', env: { ANTHROPIC_API_KEY: undefined }, want: null },
    { scenario: 'Bedrock "1"', env: { CLAUDE_CODE_USE_BEDROCK: '1' }, want: 'bedrock' },
    { scenario: 'Bedrock " YES "', env: { CLAUDE_CODE_USE_BEDROCK: ' YES ' }, want: 'bedrock' },
    { scenario: 'Bedrock "0" is off', env: { CLAUDE_CODE_USE_BEDROCK: '0' }, want: null },
    { scenario: 'Bedrock "false" is off', env: { CLAUDE_CODE_USE_BEDROCK: 'false' }, want: null },
    { scenario: 'Vertex "on"', env: { CLAUDE_CODE_USE_VERTEX: 'on' }, want: 'vertex' },
    {
      scenario: 'Bedrock beats Vertex and API key',
      env: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: '1',
        ANTHROPIC_API_KEY: API_KEY,
      },
      want: 'bedrock',
    },
    {
      scenario: 'Vertex beats API key',
      env: { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_API_KEY: API_KEY },
      want: 'vertex',
    },
    { scenario: 'apiKeyHelper only', env: {}, config: helper, want: 'api_key_helper' },
    {
      scenario: 'API key beats apiKeyHelper',
      env: { ANTHROPIC_API_KEY: API_KEY },
      config: helper,
      want: 'api_key',
    },
    {
      scenario: 'ANTHROPIC_AUTH_TOKEN is not an API credential',
      env: { ANTHROPIC_AUTH_TOKEN: 'bearer-x' },
      want: null,
    },
    {
      scenario: 'CLAUDE_CODE_OAUTH_TOKEN is not an API credential',
      env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_VALUE },
      want: null,
    },
  ])('$scenario → $want', ({ env, config: c, want }) => {
    expect(detectApiCredential(env, c ?? cfg)).toBe(want);
  });
});

describe('cliAuthMethod', () => {
  const status = (s: Partial<CliStatus>): CliStatus => ({
    path: CLAUDE_PATH,
    version: null,
    loggedIn: true,
    authMethod: null,
    apiProvider: null,
    error: null,
    ...s,
  });
  it.each<{ scenario: string; s: Partial<CliStatus>; want: AuthMethod }>([
    { scenario: 'logged out', s: { loggedIn: false, authMethod: 'oauth_token' }, want: 'none' },
    {
      scenario: 'claude.ai OAuth login',
      s: { authMethod: 'oauth_token', apiProvider: 'firstParty' },
      want: 'subscription',
    },
    { scenario: 'unknown method, no provider', s: {}, want: 'subscription' },
    {
      scenario: 'provider case-insensitive',
      s: { apiProvider: 'FIRSTPARTY' },
      want: 'subscription',
    },
    { scenario: 'api_key', s: { authMethod: 'api_key' }, want: 'claude_cli_other' },
    { scenario: 'apiKey', s: { authMethod: 'apiKey' }, want: 'claude_cli_other' },
    { scenario: 'apiKeyHelper', s: { authMethod: 'apiKeyHelper' }, want: 'claude_cli_other' },
    { scenario: 'bedrock provider', s: { apiProvider: 'bedrock' }, want: 'claude_cli_other' },
    { scenario: 'vertex provider', s: { apiProvider: 'vertex' }, want: 'claude_cli_other' },
  ])('$scenario → $want', ({ s, want }) => {
    expect(cliAuthMethod(status(s))).toBe(want);
  });
});

describe('authLabel', () => {
  it('gives every auth method a distinct, non-empty label', () => {
    const methods: AuthMethod[] = [
      'api_key',
      'api_key_helper',
      'bedrock',
      'vertex',
      'subscription',
      'claude_cli_other',
      'mock',
      'none',
    ];
    const labels = methods.map((m) => authLabel(m));
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(methods.length);
  });

  it('names the CLI login method for claude_cli_other', () => {
    expect(
      authLabel('claude_cli_other', {
        path: CLAUDE_PATH,
        version: null,
        loggedIn: true,
        authMethod: 'api_key',
        apiProvider: null,
        error: null,
      }),
    ).toContain('api_key');
    expect(authLabel('claude_cli_other', null)).toContain('unknown method');
  });

  it('marks pay-as-you-go methods so users notice the billing', () => {
    expect(authLabel('api_key')).toMatch(/pay-as-you-go/);
    expect(authLabel('api_key_helper')).toMatch(/pay-as-you-go/);
    expect(authLabel('subscription')).not.toMatch(/pay-as-you-go/);
  });
});
