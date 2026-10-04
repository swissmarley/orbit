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
export function createSandboxManager(orbitHome: string, env: Env): SandboxManager {
  return new SandboxManager({ orbitHome, run: defaultRunner(buildChildEnv('tool', env)) });
}
