import { z } from 'zod';
import { DriverKind, OrbitMode } from './enums';

export const Principal = z.object({
  id: z.string().min(1),
  kind: z.enum(['human', 'service']),
  name: z.string().optional(),
});
export type Principal = z.infer<typeof Principal>;

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
