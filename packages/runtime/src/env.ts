/**
 * Child-process environments (ADR-005). No Orbit child ever inherits
 * process.env wholesale: each kind of child gets an explicit allowlist, and a
 * deny list is enforced afterwards as a second line of defence.
 */

export type ChildKind =
  /** The user's own `claude` CLI (CliDriver, subscription mode). */
  | 'cli-engine'
  /** The Agent SDK engine (SdkDriver, API-key/cloud mode). */
  | 'sdk-engine'
  /** Anything else: MCP servers, hooks we spawn, tools, sandboxes, probes. */
  | 'tool';

export type Env = Record<string, string | undefined>;

const BASE: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Windows essentials
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PROGRAMDATA',
  'HOMEDRIVE',
  'HOMEPATH',
];
const BASE_PREFIXES: readonly string[] = ['LC_', 'XDG_'];

const NETWORK: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/** Non-secret settings the user's CLI may legitimately depend on. */
const CLI_ENGINE: readonly string[] = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL'];

/** API / cloud-provider credentials, only ever given to the SDK engine. */
const SDK_ENGINE: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
];
const SDK_ENGINE_PREFIXES: readonly string[] = ['VERTEX_REGION_'];

/** Never present in any child environment Orbit builds. */
export const ALWAYS_DENIED: readonly string[] = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
];

/** API credentials that must never reach a child other than the SDK engine. */
export const API_CREDENTIALS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

function allowed(kind: ChildKind): { names: Set<string>; prefixes: readonly string[] } {
  const names = new Set<string>([...BASE, ...NETWORK]);
  const prefixes = [...BASE_PREFIXES];
  if (kind === 'cli-engine') CLI_ENGINE.forEach((n) => names.add(n));
  if (kind === 'sdk-engine') {
    SDK_ENGINE.forEach((n) => names.add(n));
    prefixes.push(...SDK_ENGINE_PREFIXES);
  }
  return { names, prefixes };
}

function deniedFor(kind: ChildKind): Set<string> {
  const denied = new Set(ALWAYS_DENIED);
  if (kind !== 'sdk-engine') API_CREDENTIALS.forEach((n) => denied.add(n));
  return denied;
}

export class EnvPolicyError extends Error {
  override name = 'EnvPolicyError';
}

/**
 * Build the environment for a child process.
 * @param source  usually process.env — only allowlisted names are copied
 * @param extra   Orbit-provided variables (e.g. hook bridge URL); may not
 *                contain denied names
 */
export function buildChildEnv(
  kind: ChildKind,
  source: Env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const { names, prefixes } = allowed(kind);
  const denied = deniedFor(kind);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (names.has(k) || prefixes.some((p) => k.startsWith(p))) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (denied.has(k)) throw new EnvPolicyError(`${k} may not be passed to a ${kind} child`);
    out[k] = v;
  }
  // Defence in depth: whatever happened above, denied names never survive.
  for (const k of denied) Reflect.deleteProperty(out, k);
  return out;
}

/** Throws if `env` contains any name that `kind` must never receive. */
export function assertChildEnvSafe(kind: ChildKind, env: Env): void {
  for (const k of deniedFor(kind)) {
    if (env[k] !== undefined) throw new EnvPolicyError(`${k} leaked into a ${kind} child`);
  }
}
