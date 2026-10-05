import type { AuthMethod, DriverKind, OrbitConfig } from '@orbit/core';
import type { Env } from '../env';
import { type GuardResult, GUARD_API_KEY_HOWTO, checkCliDriverAllowed } from './guard';
import {
  BUBBLEWRAP_HOWTO,
  type EngineKeyDelivery,
  engineKeyDelivery,
  engineScrubBlocker,
  subprocessScrub,
} from '../drivers/sdk';
import { hasOAuthTokenEnv } from './oauth-presence';

export interface CliStatus {
  path: string;
  version: string | null;
  loggedIn: boolean;
  /** As reported by `claude auth status --json`, e.g. "oauth_token". */
  authMethod: string | null;
  apiProvider: string | null;
  error: string | null;
}

/** Side-effecting probes, injected so every resolver branch is unit-testable. */
export interface AuthProbes {
  findClaude(): Promise<string | null>;
  cliStatus(path: string): Promise<CliStatus>;
  /**
   * Where bubblewrap is, or null. On Linux Claude Code needs it to scrub its
   * children's environment (see `subprocessScrub`); omitted = not checked.
   */
  findBwrap?(): string | null;
  /** The host platform (default: this process's). */
  platform?: NodeJS.Platform;
}

export type ApiCredential = 'api_key' | 'api_key_helper' | 'bedrock' | 'vertex';

export interface AuthWarning {
  code:
    | 'stray_api_key'
    | 'oauth_token_env_not_forwarded'
    | 'cli_probe_failed'
    | 'base_url_not_forwarded'
    | 'sdk_needs_bubblewrap';
  message: string;
}

/** How the SDK engine gets its API credential (ADR-018). */
export interface EngineKeyStatus {
  /** proxied: the key stays in orbitd (key proxy); in_engine: Bedrock / Vertex credentials. */
  delivery: EngineKeyDelivery;
  /** Host engines run with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1; null = bubblewrap not checked. */
  subprocessScrub: boolean | null;
}

export interface AuthResolution {
  /** SDK driver only: where the engine's credential lives; null for other drivers. */
  engineKey: EngineKeyStatus | null;
  /** null when nothing usable is configured (onboarding) or the guard refused. */
  driver: DriverKind | null;
  authMethod: AuthMethod;
  /** Human-readable label for headers / status bars. */
  label: string;
  source: 'forced' | 'auto';
  apiCredential: ApiCredential | null;
  cli: CliStatus | null;
  guard: GuardResult;
  warnings: AuthWarning[];
  refusal: {
    code: 'compliance_refused' | 'driver_unavailable';
    message: string;
    hint: string;
  } | null;
  onboarding: { reason: string; steps: string[] } | null;
}

const truthy = (v: string | undefined): boolean =>
  v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

export function detectApiCredential(env: Env, config: OrbitConfig): ApiCredential | null {
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock';
  if (truthy(env.CLAUDE_CODE_USE_VERTEX)) return 'vertex';
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0) return 'api_key';
  if (config.sdk.apiKeyHelper) return 'api_key_helper';
  return null;
}

/** Map a CLI login to an Orbit auth method. */
export function cliAuthMethod(status: CliStatus): AuthMethod {
  if (!status.loggedIn) return 'none';
  const method = (status.authMethod ?? '').toLowerCase();
  const provider = (status.apiProvider ?? 'firstparty').toLowerCase();
  if (/api.?key|apikeyhelper/.test(method) || provider !== 'firstparty') return 'claude_cli_other';
  return 'subscription';
}

export function authLabel(method: AuthMethod, cli?: CliStatus | null): string {
  switch (method) {
    case 'api_key':
      return 'Anthropic API key (pay-as-you-go)';
    case 'api_key_helper':
      return 'API key helper (pay-as-you-go)';
    case 'bedrock':
      return 'Amazon Bedrock';
    case 'vertex':
      return 'Google Vertex AI';
    case 'subscription':
      return 'Claude subscription (your claude CLI login)';
    case 'claude_cli_other':
      return `claude CLI login (${cli?.authMethod ?? 'unknown method'})`;
    case 'mock':
      return 'Demo mode (recorded sessions, no credentials)';
    case 'none':
      return 'Not configured';
  }
}

export const ONBOARDING_STEPS: readonly string[] = [
  'Personal use with your Claude subscription: install Claude Code (https://code.claude.com), run `claude auth login`, then start Orbit again. Orbit only runs locally on 127.0.0.1 in this mode.',
  'API key (required for hosted, shared or networked use): export ANTHROPIC_API_KEY=… — or set CLAUDE_CODE_USE_BEDROCK=1 / CLAUDE_CODE_USE_VERTEX=1 with your cloud credentials.',
  'Just exploring? ORBIT_DRIVER=mock runs Orbit with recorded sessions and no credentials.',
];

function onboarding(reason: string): { reason: string; steps: string[] } {
  return { reason, steps: [...ONBOARDING_STEPS] };
}

async function probeCli(probes: AuthProbes): Promise<CliStatus | null> {
  const path = await probes.findClaude();
  if (!path) return null;
  try {
    return await probes.cliStatus(path);
  } catch (err) {
    return {
      path,
      version: null,
      loggedIn: false,
      authMethod: null,
      apiProvider: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Decide which AgentDriver to use (PLAN.md §2.2):
 *   d. ORBIT_DRIVER forces sdk|cli|mock (preconditions and guard still apply)
 *   a. API key / apiKeyHelper / Bedrock / Vertex → SdkDriver
 *   b. logged-in `claude` CLI → CliDriver (compliance guard applies)
 *   c. otherwise → onboarding
 */
export async function resolveAuth(input: {
  config: OrbitConfig;
  env: Env;
  probes: AuthProbes;
}): Promise<AuthResolution> {
  const { config, env, probes } = input;
  const forced = config.driver;
  const source = forced ? 'forced' : 'auto';
  const guard = checkCliDriverAllowed(config);
  const apiCredential = detectApiCredential(env, config);
  const warnings: AuthWarning[] = [];

  const base = { source, apiCredential, guard, warnings, engineKey: null } as const;

  if (forced === 'mock') {
    return {
      ...base,
      driver: 'mock',
      authMethod: 'mock',
      label: authLabel('mock'),
      cli: null,
      refusal: null,
      onboarding: null,
    };
  }

  // Always probe the CLI (except in forced mock mode): doctor shows its state and
  // the stray-key warning depends on it.
  const cli = await probeCli(probes);
  const cliMethod = cli ? cliAuthMethod(cli) : 'none';
  if (cli?.error) {
    warnings.push({
      code: 'cli_probe_failed',
      message: `Could not query \`claude auth status\`: ${cli.error}`,
    });
  }
  // Only meaningful when the SDK driver will actually use the key: CliDriver
  // strips ANTHROPIC_API_KEY from its child, so forced CLI mode bills the subscription.
  if (apiCredential === 'api_key' && cliMethod === 'subscription' && forced !== 'cli') {
    warnings.push({
      code: 'stray_api_key',
      message:
        'ANTHROPIC_API_KEY is set, so Orbit uses pay-as-you-go API billing even though your claude CLI is logged in with a subscription. Unset ANTHROPIC_API_KEY to use your subscription instead.',
    });
  }
  if (hasOAuthTokenEnv(env) && cliMethod === 'none') {
    warnings.push({
      code: 'oauth_token_env_not_forwarded',
      message:
        'CLAUDE_CODE_OAUTH_TOKEN is set, but Orbit never forwards OAuth credentials. Run `claude auth login` so the claude CLI can authenticate on its own.',
    });
  }

  if (env.ANTHROPIC_BASE_URL && !apiCredential && cliMethod !== 'none') {
    warnings.push({
      code: 'base_url_not_forwarded',
      message:
        'ANTHROPIC_BASE_URL is set but is not passed to the claude CLI in subscription mode, so your subscription traffic never goes to a third-party gateway.',
    });
  }

  const sdkResolution = (credential: ApiCredential): AuthResolution => {
    const platform = probes.platform ?? process.platform;
    const bwrap = probes.findBwrap ? probes.findBwrap() : undefined;
    const delivery = engineKeyDelivery(credential) ?? 'in_engine';
    // Only an engine that holds Bedrock / Vertex credentials needs the scrub
    // to start; an engine behind the key proxy holds no secret (ADR-018).
    const blocker =
      delivery === 'in_engine' && bwrap !== undefined ? engineScrubBlocker(platform, bwrap) : null;
    if (blocker) {
      warnings.push({
        code: 'sdk_needs_bubblewrap',
        message: `${blocker} Runs fail until it is installed. ${BUBBLEWRAP_HOWTO}`,
      });
    }
    return {
      ...base,
      engineKey: {
        delivery,
        subprocessScrub: bwrap === undefined ? null : subprocessScrub(platform, bwrap),
      },
      driver: 'sdk',
      authMethod: credential,
      label: authLabel(credential),
      cli,
      refusal: null,
      onboarding: null,
    };
  };

  const cliResolution = (): AuthResolution => {
    if (!guard.allowed) {
      return {
        ...base,
        driver: null,
        authMethod: cliMethod,
        label: authLabel(cliMethod, cli),
        cli,
        refusal: {
          code: 'compliance_refused',
          message: guard.message ?? 'CliDriver refused',
          hint: GUARD_API_KEY_HOWTO,
        },
        onboarding: onboarding('Subscription mode is limited to local, single-user use.'),
      };
    }
    return {
      ...base,
      driver: 'cli',
      authMethod: cliMethod,
      label: authLabel(cliMethod, cli),
      cli,
      refusal: null,
      onboarding: null,
    };
  };

  const unavailable = (message: string): AuthResolution => ({
    ...base,
    driver: null,
    authMethod: 'none',
    label: authLabel('none'),
    cli,
    refusal: { code: 'driver_unavailable', message, hint: ONBOARDING_STEPS.join('\n') },
    onboarding: onboarding(message),
  });

  if (forced === 'sdk') {
    return apiCredential
      ? sdkResolution(apiCredential)
      : unavailable(
          'ORBIT_DRIVER=sdk, but no API key, apiKeyHelper, Bedrock or Vertex configuration was found.',
        );
  }
  if (forced === 'cli') {
    if (!cli) return unavailable('ORBIT_DRIVER=cli, but the `claude` CLI was not found on PATH.');
    if (!cli.loggedIn)
      return unavailable('ORBIT_DRIVER=cli, but the `claude` CLI is not logged in.');
    return cliResolution();
  }

  if (apiCredential) return sdkResolution(apiCredential);
  if (cli?.loggedIn) return cliResolution();
  return {
    ...base,
    driver: null,
    authMethod: 'none',
    label: authLabel('none'),
    cli,
    refusal: null,
    onboarding: onboarding(
      cli
        ? 'The `claude` CLI is installed but not logged in, and no API key is configured.'
        : 'No API key is configured and the `claude` CLI was not found.',
    ),
  };
}
