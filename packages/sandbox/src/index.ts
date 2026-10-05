/**
 * @orbit/sandbox — per-Bot workspaces: Docker containers (API-key mode) and
 * plain directories / git worktrees confined by Claude Code's native sandbox
 * (subscription mode and development). See ADR-004.
 */
export type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  IsolationLevel,
  SandboxSupport,
  SpawnedProcess,
  SpawnOptions,
  Workspace,
} from './types';
export { defaultRunner } from './runner';
export {
  DARWIN_SANDBOX_EXEC,
  detectSandboxSupport,
  LINUX_SANDBOX_TOOLS,
  type DetectOptions,
} from './support';
export {
  DENIED_ABSOLUTE_PATHS,
  DENIED_HOME_PATHS,
  engineSandboxSettings,
  pluginDeniedPaths,
  isWithin,
  type EngineSandboxOptions,
} from './engine-sandbox';
export {
  BOT_LABEL,
  CONTAINER_HOME,
  CONTAINER_PREFIX,
  CONTAINER_WORKDIR,
  SandboxManager,
  type EngineSpawnerOptions,
  type SandboxManagerOptions,
} from './manager';
