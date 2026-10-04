import { type Bot, OrbitError } from '@orbit/core';
import { SandboxManager, defaultRunner } from '@orbit/sandbox';
import { type Env, buildChildEnv } from './env';
import type { WorkspaceProvider } from './orchestrator';

/**
 * Workspace provider backed by @orbit/sandbox: plain directories or git
 * worktrees confined by Claude Code's native sandbox, or a Docker container
 * per Bot (API-key mode only, ADR-004).
 */
export function sandboxWorkspaces(manager: SandboxManager, env: Env): WorkspaceProvider {
  return async (bot, driver) => {
    // Docker mode is experimental until the API key stays out of the container
    // and the engine can reach the API without general egress (M8, review M3).
    if (bot.spec.sandbox.kind === 'docker' && env.ORBIT_EXPERIMENTAL_DOCKER !== '1') {
      throw new OrbitError(
        'invalid_config',
        `Bot "${bot.spec.name}" uses the Docker sandbox, which is still experimental`,
        {
          hint: 'Use sandbox.kind directory or worktree, or set ORBIT_EXPERIMENTAL_DOCKER=1 to try it (the API key is readable inside the container).',
        },
      );
    }
    const ws = await manager.prepare(bot, driver);
    // The engine inside a container gets exactly the SDK engine's allowlisted env.
    const engineEnv = buildChildEnv('sdk-engine', env, { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
    return {
      path: ws.path,
      shellContained: ws.shellContained,
      engineSandbox: ws.engineSandboxSettings,
      ...(ws.docker ? { spawnEngine: manager.engineSpawner(ws, engineEnv) } : {}),
    };
  };
}

/** Sandbox manager whose git/docker children never see API credentials. */
export function createSandboxManager(
  orbitHome: string,
  env: Env,
  /** Name a Bot had when M2 created its workspace (see SandboxManagerOptions). */
  legacyName?: (bot: Bot) => string | null,
): SandboxManager {
  return new SandboxManager({
    orbitHome,
    ...(legacyName ? { legacyName } : {}),
    run: defaultRunner(buildChildEnv('tool', env)),
    // A non-default Claude config dir holds the CLI's credentials too.
    extraDenied: env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : [],
  });
}
