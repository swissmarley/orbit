import { type Bot } from '@orbit/core';
import {
  type EngineCredential,
  type ProxyRefusal,
  SandboxManager,
  apiKeyHelper,
  defaultRunner,
  staticApiKey,
} from '@orbit/sandbox';
import { apiKeyFilePaths } from './auth/api-key-file';
import { type Env, buildChildEnv } from './env';
import type { WorkspaceProvider } from './orchestrator';

/**
 * Workspace provider backed by @orbit/sandbox: plain directories or git
 * worktrees confined by Claude Code's native sandbox, or a Docker container
 * per Bot (API-key mode only, ADR-004). A container engine never sees an API
 * credential: it reaches the API through orbitd's key-injecting proxy
 * (ADR-018).
 */
export function sandboxWorkspaces(manager: SandboxManager, env: Env): WorkspaceProvider {
  return async (bot, driver) => {
    const ws = await manager.prepare(bot, driver);
    // A container engine's env is built like any non-engine child: no API
    // credentials at all (the spawner adds the placeholder key and proxy URLs).
    const engineEnv = buildChildEnv('tool', env);
    return {
      path: ws.path,
      shellContained: ws.shellContained,
      engineSandbox: ws.engineSandboxSettings,
      ...(ws.git ? { git: ws.git } : {}),
      ...(ws.docker
        ? { spawnEngine: manager.engineSpawner(ws, engineEnv), apiKeyProxied: true }
        : {}),
      ...(ws.mounts ? { mounts: ws.mounts } : {}),
      ...(ws.release ? { release: ws.release } : {}),
    };
  };
}

/** orbitd's API base URL, which the key proxies forward to. */
export function apiUpstream(env: Env): string {
  const base = env.ANTHROPIC_BASE_URL?.trim();
  return base !== undefined && base !== '' ? base : 'https://api.anthropic.com';
}

const truthy = (v: string | undefined): boolean =>
  v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

/** Claude Code's apiKeyHelper refresh interval, if the owner set one. */
function helperTtl(env: Env): number | undefined {
  const ms = Number(env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Where orbitd's key proxies get the key (ADR-018) — the Docker sandbox's
 * and the host engine's: orbitd's ANTHROPIC_API_KEY, or the apiKeyHelper run
 * on the host with the env the SDK engine would have given it. Bedrock and
 * Vertex cannot use the proxies.
 */
export function keyProxyCredential(
  env: Env,
  apiKeyHelperCommand: string | null,
  onKey?: (key: string) => void,
): EngineCredential {
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) return { kind: 'unsupported', provider: 'bedrock' };
  if (truthy(env.CLAUDE_CODE_USE_VERTEX)) return { kind: 'unsupported', provider: 'vertex' };
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (key) return { kind: 'key', source: staticApiKey(key) };
  if (apiKeyHelperCommand) {
    const ttlMs = helperTtl(env);
    return {
      kind: 'key',
      source: apiKeyHelper({
        command: apiKeyHelperCommand,
        run: defaultRunner(buildChildEnv('sdk-engine', env)),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(onKey ? { onKey } : {}),
      }),
    };
  }
  return { kind: 'none' };
}

/** The docker CLI's own settings (no credentials), picked by name. */
function dockerClientVars(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
  ]) {
    const v = env[name];
    if (v !== undefined && v !== '') out[name] = v;
  }
  return out;
}

export interface SandboxManagerExtras {
  /** Name a Bot had when M2 created its workspace (see SandboxManagerOptions). */
  legacyName?: (bot: Bot) => string | null;
  /** ORBIT_API_KEY_HELPER (config.sdk.apiKeyHelper). */
  apiKeyHelper?: string | null;
  /** The key source shared with the host engine's key proxy (default: built from env). */
  credential?: EngineCredential;
  /** Told about refused API requests and egress tunnels of container Bots. */
  onProxyRefusal?: (botId: string, proxy: 'api' | 'egress', refusal: ProxyRefusal) => void;
}

/** Sandbox manager whose git/docker children never see API credentials. */
export function createSandboxManager(
  orbitHome: string,
  env: Env,
  extras: SandboxManagerExtras = {},
): SandboxManager {
  return new SandboxManager({
    orbitHome,
    ...(extras.legacyName ? { legacyName: extras.legacyName } : {}),
    // DOCKER_HOST / DOCKER_CONTEXT steer the docker CLI to the owner's daemon.
    run: defaultRunner({ ...buildChildEnv('tool', env), ...dockerClientVars(env) }),
    // A non-default Claude config dir holds the CLI's credentials too.
    // …and so does an API key file (M8 safety re-review).
    extraDenied: [
      ...(env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : []),
      ...apiKeyFilePaths(env),
    ],
    credential: extras.credential ?? keyProxyCredential(env, extras.apiKeyHelper ?? null),
    // The key proxy forwards to the API orbitd itself would use.
    apiUpstream: apiUpstream(env),
    ...(extras.onProxyRefusal ? { onProxyRefusal: extras.onProxyRefusal } : {}),
  });
}
