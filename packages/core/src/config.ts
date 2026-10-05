import { z } from 'zod';
import { DriverKind, OrbitMode } from './enums';
import { PluginSandboxMode } from './plugin';

export const Principal = z.object({
  id: z.string().min(1),
  kind: z.enum(['human', 'service']),
  name: z.string().optional(),
});
export type Principal = z.infer<typeof Principal>;

/**
 * An extra browser origin allowed to call the API (ADR-011): a loopback dev
 * server (`http://localhost:5173`) or the desktop shell (`tauri://localhost`).
 * Never a remote site: the local API is plain HTTP with a bearer token.
 */
export const AppOrigin = z
  .string()
  .trim()
  .transform((s) => s.replace(/\/+$/, '').toLowerCase())
  .refine((s) => isAllowedAppOrigin(s), {
    message:
      'must be an http(s) origin on a loopback host (localhost, 127.x, [::1]) or tauri://localhost, without a path',
  });

export function isAllowedAppOrigin(origin: string): boolean {
  if (origin === 'tauri://localhost' || origin === 'http://tauri.localhost') return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password || u.search || u.hash) return false;
  if (u.pathname !== '/' || !origin.startsWith(`${u.protocol}//`)) return false;
  if (`${u.protocol}//${u.host}` !== origin) return false;
  return isLoopbackHost(u.hostname);
}

/** The catalog the repository publishes (`plugins/catalog.json` on the main branch). */
export const DEFAULT_PLUGIN_CATALOG_URL =
  'https://raw.githubusercontent.com/swissmarley/orbit/main/plugins/catalog.json';

/** An npm registry: https, or http on a loopback host (a local mirror or a test). */
export function isAllowedRegistryUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopbackHost(u.hostname);
}

/** A catalog: what a registry may be, or a local `file:` index. */
export function isAllowedCatalogUrl(url: string): boolean {
  if (isAllowedRegistryUrl(url)) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * Fully resolved orbitd / CLI configuration. Loaded from
 * `$ORBIT_HOME/config.json` with environment overrides (see
 * `@orbit/runtime` loadConfig). Model values are aliases or IDs supplied by the
 * user — never hardcoded IDs (ADR-006).
 */
export const OrbitConfig = z.object({
  home: z.string().min(1),
  mode: OrbitMode.default('local'),
  api: z
    .object({
      host: z.string().min(1).default('127.0.0.1'),
      port: z.int().min(0).max(65_535).default(7420),
      /**
       * Browser origins allowed besides orbitd's own (which serves the App).
       * `ORBIT_ALLOWED_ORIGINS` (comma-separated) overrides it.
       */
      allowedOrigins: z.array(AppOrigin).max(16).default([]),
    })
    .prefault({}),
  /** Human and service principals allowed to use this orbitd. */
  principals: z
    .array(Principal)
    .min(1)
    .default([{ id: 'owner', kind: 'human', name: 'Local owner' }]),
  /** Forced driver (`ORBIT_DRIVER`); null = AuthResolver decides. */
  driver: DriverKind.nullable().default(null),
  models: z
    .object({
      default: z.string().min(1).default('opus'),
      triage: z.string().min(1).default('haiku'),
    })
    .prefault({}),
  claudePath: z.string().min(1).nullable().default(null),
  sdk: z
    .object({
      /** Start the SDK engine with `--bare` so it can never read OAuth credentials. */
      bare: z.boolean().default(true),
      /** Command that prints an API key (Claude Code `apiKeyHelper`). */
      apiKeyHelper: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  /**
   * The triage path (ORBIT_TRIAGE_MODEL): post-run summaries and the Create
   * Bot proposal. Every call is metered and shown; this caps them so Orbit
   * never spends subscription usage the owner did not expect.
   */
  triage: z
    .object({
      /** Triage calls per local day, all Bots together (`ORBIT_TRIAGE_MAX_CALLS_PER_DAY`). 0 = off. */
      maxCallsPerDay: z.int().min(0).max(1000).default(20),
    })
    .prefault({}),
  delegation: z
    .object({
      /** Longest chain of delegated Runs (A → B → C is depth 2). */
      maxDepth: z.int().min(1).max(5).default(3),
    })
    .prefault({}),
  /** Plugins (ADR-014, ADR-019). */
  plugins: z
    .object({
      /**
       * OS sandbox for stdio plugin servers (`ORBIT_PLUGIN_SANDBOX`): `auto`
       * sandboxes when the host can, `required` refuses to start a plugin it
       * cannot sandbox, `off` never sandboxes (doctor warns).
       */
      sandbox: PluginSandboxMode.default('auto'),
      /** The catalog index (`ORBIT_PLUGIN_CATALOG_URL`): https, http on loopback, or file:. */
      catalogUrl: z
        .string()
        .refine(isAllowedCatalogUrl, 'must be https, http on a loopback host, or file:')
        .default(DEFAULT_PLUGIN_CATALOG_URL),
      /** npm registry for tarballs (`ORBIT_NPM_REGISTRY`): https, or http on loopback. */
      npmRegistry: z
        .string()
        .refine(isAllowedRegistryUrl, 'must be https, or http on a loopback host')
        .default('https://registry.npmjs.org'),
      /**
       * Where installed packages live (`ORBIT_PLUGIN_STORE`); null = the
       * platform's data folder (`$XDG_DATA_HOME/orbit/plugins`). Never inside
       * `$ORBIT_HOME`, where Bots can write.
       */
      storeDir: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  limits: z
    .object({
      maxConcurrentRuns: z
        .object({
          cli: z.int().positive().default(2),
          sdk: z.int().positive().default(4),
          mock: z.int().positive().default(8),
        })
        .prefault({}),
    })
    .prefault({}),
});
export type OrbitConfig = z.infer<typeof OrbitConfig>;
export type OrbitConfigInput = z.input<typeof OrbitConfig>;

export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^::ffff:127(\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

export function humanPrincipalCount(config: Pick<OrbitConfig, 'principals'>): number {
  return config.principals.filter((p) => p.kind === 'human').length;
}
