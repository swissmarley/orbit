import { z } from 'zod';
import { DriverKind, OrbitMode } from './enums';

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
  /** Memory bounds and retention (ADR-012). */
  memory: z
    .object({
      /** Memories kept per Bot; when full the oldest unpinned Bot note or summary goes first. */
      maxPerBot: z.int().min(10).max(10_000).default(1000),
      /**
       * Days an unpinned Bot note or run summary is kept; null = keep. Owner
       * facts, feedback and pinned memories never expire. A Bot's
       * `memory.retentionDays` overrides it.
       */
      retentionDays: z.int().min(1).max(3650).nullable().default(null),
    })
    .prefault({}),
  delegation: z
    .object({
      /** Longest chain of delegated Runs (A → B → C is depth 2). */
      maxDepth: z.int().min(1).max(5).default(3),
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
