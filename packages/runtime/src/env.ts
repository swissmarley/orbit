/**
 * Child-process environments (ADR-005). No Orbit child ever inherits
 * process.env wholesale: each kind of child gets an explicit allowlist, and a
 * deny list is enforced afterwards as a second line of defence.
 */
import { API_KEY_PLACEHOLDER, HOST_KEY_PROXY_ADDRESS } from '@orbit/sandbox';

export type ChildKind =
  /** The user's own `claude` CLI (CliDriver, subscription mode). */
  | 'cli-engine'
  /** The Agent SDK engine (SdkDriver, API-key/cloud mode). */
  | 'sdk-engine'
  /** Anything else: MCP servers, hooks we spawn, tools, sandboxes, probes. */
  | 'tool'
  /**
   * orbitd started by the CLI: Orbit itself, so it receives Orbit's settings
   * and the API credentials it hands to the SDK engine — never OAuth tokens.
   */
  | 'orbitd';

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

/**
 * Non-secret settings the user's CLI may legitimately depend on.
 * ANTHROPIC_BASE_URL is deliberately excluded: a gateway configured for API
 * keys must not receive subscription (OAuth) traffic.
 */
const CLI_ENGINE: readonly string[] = ['CLAUDE_CONFIG_DIR'];

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

/** Orbit's own configuration variables (ORBIT_HOME, ORBIT_DRIVER, …). */
const ORBITD_PREFIXES: readonly string[] = ['ORBIT_'];

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
  if (kind === 'cli-engine' || kind === 'orbitd') CLI_ENGINE.forEach((n) => names.add(n));
  if (kind === 'sdk-engine' || kind === 'orbitd') {
    SDK_ENGINE.forEach((n) => names.add(n));
    prefixes.push(...SDK_ENGINE_PREFIXES);
  }
  if (kind === 'orbitd') prefixes.push(...ORBITD_PREFIXES);
  return { names, prefixes };
}

function deniedFor(kind: ChildKind): Set<string> {
  const denied = new Set(ALWAYS_DENIED);
  if (kind !== 'sdk-engine' && kind !== 'orbitd') API_CREDENTIALS.forEach((n) => denied.add(n));
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

/** Hosts the engine must reach directly, never through the host's HTTPS_PROXY. */
const LOOPBACK_NO_PROXY: readonly string[] = [HOST_KEY_PROXY_ADDRESS, 'localhost'];

/**
 * The environment of an SDK engine on the host behind orbitd's key proxy
 * (ADR-018, amended): built like any non-engine child (`tool`: no API or
 * cloud credential, no provider switch, not the host's ANTHROPIC_BASE_URL),
 * plus the placeholder key and the proxy's loopback base URL with the
 * segment's token. `NO_PROXY` gains the loopback names so the engine talks
 * to the proxy directly.
 */
export function proxiedEngineEnv(
  source: Env,
  baseUrl: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env = buildChildEnv('tool', source, extra);
  const listed = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  const noProxy = [...new Set([...listed, ...LOOPBACK_NO_PROXY])].join(',');
  Object.assign(env, {
    ANTHROPIC_API_KEY: API_KEY_PLACEHOLDER,
    ANTHROPIC_BASE_URL: baseUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  });
  assertProxiedEngineEnv(env);
  return env;
}

/**
 * Throws unless `env` is a proxied engine's: nothing a `tool` child may not
 * have, the placeholder as its only key, and the API reached on loopback.
 */
export function assertProxiedEngineEnv(env: Env): void {
  for (const k of deniedFor('tool')) {
    if (k !== 'ANTHROPIC_API_KEY' && env[k] !== undefined) {
      throw new EnvPolicyError(`${k} leaked into a proxied engine`);
    }
  }
  if (env.ANTHROPIC_API_KEY !== API_KEY_PLACEHOLDER) {
    throw new EnvPolicyError('A proxied engine gets only the placeholder API key');
  }
  for (const k of [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]) {
    if (env[k] !== undefined) throw new EnvPolicyError(`${k} leaked into a proxied engine`);
  }
  let url: URL | null;
  try {
    url = new URL(env.ANTHROPIC_BASE_URL ?? '');
  } catch {
    url = null;
  }
  if (url?.protocol !== 'http:' || url.hostname !== HOST_KEY_PROXY_ADDRESS) {
    throw new EnvPolicyError(
      "A proxied engine reaches the API only through orbitd's loopback proxy",
    );
  }
}
