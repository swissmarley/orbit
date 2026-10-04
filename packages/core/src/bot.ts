import { z } from 'zod';

export const BotBudgets = z.object({
  /** Tool calls per Run (counted at permission time, so denied calls count). */
  maxToolCallsPerRun: z.int().positive().default(200),
  /** Wall-clock minutes per Run segment. */
  maxWallClockMinutes: z
    .number()
    .positive()
    .max(24 * 60)
    .default(60),
  /** Input + output tokens per Run (checked after every model turn). */
  maxTokensPerRun: z.int().positive().nullable().default(null),
  /** Engine-estimated USD per Run (API-key mode); also passed to the engine. */
  maxCostUsdPerRun: z.number().positive().nullable().default(null),
  /** Engine-estimated USD per UTC day across all Runs of the Bot. */
  maxCostUsdPerDay: z.number().positive().nullable().default(null),
  /** New Runs per UTC day (resumes do not count) — protects subscription limits. */
  maxRunsPerDay: z.int().positive().default(50),
});
export type BotBudgets = z.infer<typeof BotBudgets>;

export const BotSandbox = z.object({
  /**
   * directory: plain folder under $ORBIT_HOME/workspaces (default);
   * worktree:  a git worktree of `repo` on branch orbit/<bot>;
   * docker:    a container per Bot (API-key mode only, ADR-004).
   */
  kind: z.enum(['directory', 'worktree', 'docker']).default('directory'),
  /** Source repository for `worktree` (and mounted read-only for docker). */
  repo: z.string().min(1).optional(),
  /** Outbound network for shell commands: none, or an allowlist of domains. */
  network: z.enum(['none', 'allowlist']).default('none'),
  allowedDomains: z.array(z.string().min(1)).default([]),
  /** Docker image providing the engine; see docker/sandbox.Dockerfile. */
  image: z.string().min(1).default('orbit-sandbox:latest'),
  cpus: z.number().positive().max(64).default(2),
  memoryMb: z.int().min(128).max(65_536).default(2048),
  pidsLimit: z.int().min(16).max(32_768).default(512),
});
export type BotSandbox = z.infer<typeof BotSandbox>;

/**
 * User-authored Bot configuration. Later milestones extend it with triggers,
 * policy, budgets, plugins and memory settings; every field added must have a
 * safe default so older specs stay valid.
 */
export const BotSpec = z.object({
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(4000),
  instructions: z.string().max(20_000).default(''),
  /** Model alias or ID; falls back to ORBIT_DEFAULT_MODEL. */
  model: z.string().trim().min(1).optional(),
  /** Built-in engine tools exposed to the Bot; omitted = engine default set. */
  tools: z.array(z.string().min(1)).optional(),
  maxTurns: z.int().positive().max(500).optional(),
  /** MockDriver scenario used in demo mode and tests. */
  mock: z.object({ fixture: z.string().min(1) }).optional(),
  /** Runtime-enforced limits (never prompt-enforced). */
  budgets: BotBudgets.prefault({}),
  /** Where the Bot works ("its own computer"). */
  sandbox: BotSandbox.prefault({}),
  approvals: z
    .object({
      /** Seconds a tool call waits for a decision before the Run parks. */
      parkWindowSeconds: z.int().min(0).max(600).default(30),
      /** Resume the Run automatically once every pending approval is decided. */
      autoResume: z.boolean().default(true),
    })
    .prefault({}),
  /** Resume after a subscription usage limit resets (scheduler, M3). */
  autoResumeAfterUsageLimit: z.boolean().default(true),
  /** Extra directories the Bot may read (never write). */
  readRoots: z.array(z.string().min(1)).default([]),
});
export type BotSpec = z.infer<typeof BotSpec>;
export type BotSpecInput = z.input<typeof BotSpec>;

export const Bot = z.object({
  id: z.string(),
  version: z.int().positive(),
  spec: BotSpec,
  /** Bot kill switch: set when paused; no Runs start while paused. */
  pausedAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Bot = z.infer<typeof Bot>;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 48) || 'bot'
  );
}
