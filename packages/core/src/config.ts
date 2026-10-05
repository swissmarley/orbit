import { z } from 'zod';
import { DriverKind, OrbitMode } from './enums';

/**
 * What a principal may do through the API (ADR-015): `viewer` reads,
 * `operator` also starts, stops and resumes Runs, decides approvals and gives
 * feedback, `owner` does everything else too (Bots, rules, secrets, plugins,
 * kill switch, …). Local mode has one owner, so nothing is limited there.
 */
export const PrincipalRole = z.enum(['viewer', 'operator', 'owner']);
export type PrincipalRole = z.infer<typeof PrincipalRole>;

const ROLE_RANK: Record<PrincipalRole, number> = { viewer: 0, operator: 1, owner: 2 };

/** Does `role` include everything `needed` may do? */
export function roleAtLeast(role: PrincipalRole, needed: PrincipalRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[needed];
}

export const Principal = z.object({
  id: z.string().min(1),
  kind: z.enum(['human', 'service']),
  name: z.string().optional(),
  role: PrincipalRole.default('owner'),
  /**
   * Hosted mode (ADR-015): which OIDC identity signs in as this principal.
   * The ID token's `sub` is matched first; `email` counts only when the
   * issuer marks it verified (`email_verified: true`).
   */
  oidc: z
    .object({
      subject: z.string().min(1).max(255).optional(),
      email: z
        .email()
        .transform((e) => e.toLowerCase())
        .optional(),
    })
    .refine((m) => m.subject !== undefined || m.email !== undefined, {
      message: 'name a subject or an email',
    })
    .optional(),
});
export type Principal = z.infer<typeof Principal>;

function parseUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** `https://host[:port]` exactly: no path, query, fragment or credentials. */
function isHttpsOrigin(s: string): boolean {
  const u = parseUrl(s);
  return u !== null && u.protocol === 'https:' && u.origin === s.toLowerCase();
}

/**
 * orbitd's public address in hosted mode: an `https://` origin. Browsers
 * sign in there, cookies are `Secure`, and webhooks from other machines are
 * sent there.
 */
export const PublicUrl = z
  .string()
  .trim()
  .transform((s) => s.replace(/\/+$/, '').toLowerCase())
  .refine((s) => isHttpsOrigin(s), {
    message: 'must be an https:// origin without a path, e.g. https://orbit.example.com',
  });

/**
 * Is this an acceptable OpenID Connect issuer (or endpoint) URL? `https://`
 * (a path is fine, e.g. Keycloak realms), or `http://` on a loopback host
 * only (local test issuers); never credentials, a query or a fragment.
 */
export function isAllowedIssuer(s: string): boolean {
  const u = parseUrl(s);
  if (u === null || u.username || u.password || u.search || u.hash) return false;
  if (s.includes('?') || s.includes('#')) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopbackHost(u.hostname);
}

/** An OIDC issuer, kept exactly as written: ID tokens must name it exactly. */
export const OidcIssuer = z
  .string()
  .trim()
  .refine((s) => isAllowedIssuer(s), {
    message: 'must be an https:// URL (http:// only on a loopback host) without query or fragment',
  });

/** Hosted mode settings (ADR-015); ignored in local mode. */
export const HostedConfig = z
  .object({
    /** `ORBIT_PUBLIC_URL`. Required in hosted mode. */
    publicUrl: PublicUrl.nullable().default(null),
    /**
     * In-process TLS (`ORBIT_TLS_CERT`, `ORBIT_TLS_KEY`: PEM files). Required
     * for a non-loopback bind; without it orbitd stays on loopback behind a
     * TLS-terminating reverse proxy on the same machine.
     */
    tls: z
      .object({ certFile: z.string().min(1), keyFile: z.string().min(1) })
      .nullable()
      .default(null),
    /**
     * Browser sign-in (`ORBIT_OIDC_ISSUER`, `ORBIT_OIDC_CLIENT_ID`):
     * authorization code with PKCE. The optional client secret is the vault
     * entry `oidc_client_secret` or `ORBIT_OIDC_CLIENT_SECRET`, never config.
     */
    oidc: z
      .object({
        issuer: OidcIssuer,
        clientId: z.string().trim().min(1).max(512),
        scopes: z
          .array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, 'not a valid scope'))
          .min(1)
          .max(20)
          .default(['openid', 'email', 'profile'])
          .refine((s) => s.includes('openid'), { message: 'must include openid' }),
      })
      .nullable()
      .default(null),
  })
  .prefault({});
export type HostedConfig = z.infer<typeof HostedConfig>;

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
    .default([{ id: 'owner', kind: 'human', name: 'Local owner', role: 'owner' }])
    .refine((list) => new Set(list.map((p) => p.id)).size === list.length, {
      message: 'principal ids must be unique',
    })
    .refine(
      (list) => {
        const subjects = list.flatMap((p) => (p.oidc?.subject ? [p.oidc.subject] : []));
        const emails = list.flatMap((p) => (p.oidc?.email ? [p.oidc.email] : []));
        return new Set(subjects).size === subjects.length && new Set(emails).size === emails.length;
      },
      { message: 'an OIDC subject or email may sign in as one principal only' },
    ),
  /** Hosted mode (ADR-015): public URL, TLS and OIDC sign-in. */
  hosted: HostedConfig,
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

/** Configured principals per role (doctor). */
export function principalsByRole(
  config: Pick<OrbitConfig, 'principals'>,
): Record<PrincipalRole, number> {
  const out: Record<PrincipalRole, number> = { owner: 0, operator: 0, viewer: 0 };
  for (const p of config.principals) out[p.role] += 1;
  return out;
}
