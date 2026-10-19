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
  PathMount,
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
  bwrapArgs,
  detectPluginSandbox,
  LINUX_SYSTEM_PATHS,
  pluginSandboxSpec,
  sbplString,
  seatbeltProfile,
  wrapPluginCommand,
  type DetectPluginSandboxOptions,
  type GitBind,
  type HostPath,
  type PluginSandboxEngine,
  type PluginSandboxInput,
  type PluginSandboxSpec,
  type PluginSandboxSupport,
  type SandboxBind,
  type SystemPath,
  type WrappedCommand,
} from './plugin-sandbox';
export {
  API_KEY_PLACEHOLDER,
  BOT_LABEL,
  CONFIG_LABEL,
  CONTAINER_API_PORT,
  CONTAINER_EGRESS_PORT,
  CONTAINER_HOME,
  CONTAINER_PREFIX,
  CONTAINER_SOCKET_DIR,
  CONTAINER_WORKDIR,
  SandboxManager,
  containerEngineEnv,
  containerEntryScript,
  dockerShellContained,
  type EngineCredential,
  type EngineSpawnerOptions,
  type SandboxImageStatus,
  type SandboxManagerOptions,
} from './manager';
export {
  type AllowRule,
  type ParsedAllowlist,
  blockedAddressReason,
  parseAllowlist,
} from './proxy/addresses';
export { API_ROUTES, apiRouteAllowed, bodyRefusal, parseUpstream } from './proxy/api-proxy';
export {
  HOST_KEY_PROXY_ADDRESS,
  HostKeyProxy,
  type HostKeyLease,
  type HostKeyProxyOptions,
  type HostKeyProxyStatus,
} from './proxy/host-key-proxy';
export { type Lookup, decideEgress } from './proxy/egress-proxy';
export { type BotProxyStatus, ProxyHost } from './proxy/host';
export {
  API_KEY_HELPER_TTL_MS,
  type ApiKeySource,
  apiKeyHelper,
  staticApiKey,
} from './proxy/key-source';
export type { ProxyCounters, ProxyRefusal } from './proxy/stats';
export {
  type DotGitState,
  type TakeoverGit,
  gitCommonDir,
  prepareTakeoverGit,
  worktreeAdminDir,
} from './git-dirs';
export {
  HIDDEN_WORKSPACE_NAMES,
  WORKSPACE_LIST_LIMIT,
  WORKSPACE_PREVIEW_BYTES,
  type WorkspaceEntry,
  type WorkspaceListing,
  type WorkspacePreview,
  listWorkspace,
  readWorkspaceFile,
  workspacePathSegments,
} from './workspace-files';
