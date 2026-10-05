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

const triggerBase = {
  /** Shown in schedules and recorded as the Run's trigger source. */
  name: z.string().trim().min(1).max(80).optional(),
  /** Task for Runs started by this trigger (default: the Bot's goal). */
  prompt: z.string().trim().min(1).max(4000).optional(),
  enabled: z.boolean().default(true),
};

/** Standard 5-field cron expression (6 with seconds), validated by the scheduler. */
export const CronTrigger = z.object({
  kind: z.literal('cron'),
  cron: z.string().trim().min(1).max(120),
  /** IANA time zone; default: the daemon's local zone. */
  timezone: z.string().trim().min(1).optional(),
  ...triggerBase,
});

/** Every N minutes, measured from the previous fire (or from when it was first seen). */
export const IntervalTrigger = z.object({
  kind: z.literal('interval'),
  everyMinutes: z
    .int()
    .min(1)
    .max(31 * 24 * 60),
  ...triggerBase,
});

/** Name in a webhook URL: /hooks/<bot>/<name>. */
export const WEBHOOK_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * An HMAC-signed POST to orbitd's loopback port (ADR-014). The signing key is
 * the vault secret `webhook_<bot id>_<name>`; the payload reaches the Run as
 * untrusted data and the Run starts tainted.
 */
export const WebhookTrigger = z.object({
  kind: z.literal('webhook'),
  ...triggerBase,
  name: z.string().regex(WEBHOOK_NAME, 'lowercase letters, digits and dashes'),
  /** orbit: X-Orbit-Timestamp + X-Orbit-Signature over "<ts>.<body>"; github: X-Hub-Signature-256. */
  style: z.enum(['orbit', 'github']).default('orbit'),
  /** GitHub style only: event names (X-GitHub-Event) that start a Run; empty = all. */
  events: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
});

/** Slack messages over Socket Mode (no public URL), using the Slack plugin's tokens. */
export const SlackTrigger = z.object({
  kind: z.literal('slack'),
  ...triggerBase,
  /** Channel ids (C…, G…, D…) to listen in. */
  channels: z
    .array(z.string().regex(/^[CGD][A-Z0-9]{2,20}$/, 'a Slack channel id such as C0123ABCD'))
    .min(1)
    .max(20),
  /** mention: only messages that mention the app; message: every new message. */
  on: z.enum(['mention', 'message']).default('mention'),
  /** Slack user ids (U…/W…) whose messages start Runs; empty = anyone in the channels. */
  users: z
    .array(z.string().regex(/^[UW][A-Z0-9]{2,20}$/, 'a Slack user id such as U0123ABCD'))
    .max(50)
    .default([]),
});

const absolutePath = z
  .string()
  .min(1)
  .max(1000)
  .refine((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'must be an absolute path');

/** Changes under files or folders (chokidar), debounced: a burst of changes is one Run. */
export const FileTrigger = z.object({
  kind: z.literal('file'),
  ...triggerBase,
  paths: z.array(absolutePath).min(1).max(10),
  events: z
    .array(z.enum(['add', 'change', 'unlink']))
    .min(1)
    .default(['add', 'change', 'unlink']),
  /** Glob patterns (relative names) to ignore, e.g. "*.tmp". Dot-files are always ignored. */
  ignore: z.array(z.string().min(1).max(200)).max(20).default([]),
  debounceSeconds: z.int().min(1).max(3600).default(5),
});

/** New commits on a branch of a local repository. */
export const GitTrigger = z.object({
  kind: z.literal('git'),
  ...triggerBase,
  repo: absolutePath,
  branch: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._/-]{1,200}$/)
    .refine((b) => !b.includes('..') && !b.startsWith('-'), 'not a branch name')
    .default('main'),
  debounceSeconds: z.int().min(1).max(3600).default(5),
});

export const TriggerSpec = z.discriminatedUnion('kind', [
  CronTrigger,
  IntervalTrigger,
  WebhookTrigger,
  SlackTrigger,
  FileTrigger,
  GitTrigger,
]);
export type WebhookTrigger = z.infer<typeof WebhookTrigger>;
export type SlackTrigger = z.infer<typeof SlackTrigger>;
export type FileTrigger = z.infer<typeof FileTrigger>;
export type GitTrigger = z.infer<typeof GitTrigger>;
/** Triggers that fire on a clock (Scheduler); the others are inbound (TriggerRouter). */
export type ScheduledTrigger = z.infer<typeof CronTrigger> | z.infer<typeof IntervalTrigger>;
export function isScheduledTrigger(t: TriggerSpec): t is ScheduledTrigger {
  return t.kind === 'cron' || t.kind === 'interval';
}
export type TriggerSpec = z.infer<typeof TriggerSpec>;

/**
 * A subagent the Bot may hand work to inside its own Run (the engine's
 * `agents` / `--agents`). Every tool call a subagent makes goes through the
 * same Orbit policy hook as the Bot's own calls.
 */
export const SubagentSpec = z.object({
  /** When the Bot should use it (shown to the model). */
  description: z.string().trim().min(1).max(1000),
  /** The subagent's system prompt. */
  prompt: z.string().trim().min(1).max(20_000),
  /** Tool subset; omitted = the Bot's tools. Must be a subset of the Bot's tools when those are set. */
  tools: z.array(z.string().min(1)).max(50).optional(),
  /** Model alias or ID (`haiku` = ORBIT_TRIAGE_MODEL is a good choice for routine work); omitted = the Bot's model. */
  model: z.string().trim().min(1).max(100).optional(),
  maxTurns: z.int().positive().max(200).optional(),
});
export type SubagentSpec = z.infer<typeof SubagentSpec>;

export const SUBAGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export const BotMemorySettings = z.object({
  /**
   * After each completed Run:
   * - off:    remember nothing
   * - result: keep the Run's final answer as its summary (no model call, free)
   * - triage: summarize the Run with ORBIT_TRIAGE_MODEL (one small, metered call;
   *           capped by `triage.maxCallsPerDay`)
   */
  summarize: z.enum(['off', 'result', 'triage']).default('result'),
  /** Offer trusted memories and recent feedback to new Runs. */
  inject: z.boolean().default(true),
  /** Upper bound of memory text added to a Run's context. */
  maxContextChars: z.int().min(0).max(20_000).default(4000),
  /** Give the Bot the Orbit memory tools (search, read, write). */
  tools: z.boolean().default(true),
  /**
   * Days this Bot's unpinned notes and run summaries are kept (null = keep);
   * omitted = the daemon's `memory.retentionDays`.
   */
  retentionDays: z.int().min(1).max(3650).nullable().optional(),
});
export type BotMemorySettings = z.infer<typeof BotMemorySettings>;

export const BotDelegation = z.object({
  /** Bots (ids or names) this Bot may hand tasks to with `delegate_to_bot`; empty = none. */
  allowedBots: z.array(z.string().trim().min(1)).max(20).default([]),
  /** Delegations one Run may start. */
  maxChildrenPerRun: z.int().min(1).max(10).default(3),
});
export type BotDelegation = z.infer<typeof BotDelegation>;

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
      /** Undecided approvals expire (count as denied) after this many hours. */
      expireAfterHours: z
        .number()
        .positive()
        .max(30 * 24)
        .default(72),
    })
    .prefault({}),
  /** Resume after a subscription usage limit resets (RateLimitManager). */
  autoResumeAfterUsageLimit: z.boolean().default(true),
  /** Scheduled triggers (cron, interval); manual Runs need no trigger. */
  triggers: z.array(TriggerSpec).max(20).default([]),
  /** Queue priority of this Bot's Runs (higher first). Manual Runs get +10. */
  priority: z.int().min(-10).max(10).default(0),
  /** Extra directories the Bot may read (never write). */
  readRoots: z.array(z.string().min(1)).default([]),
  /** Subagents by name (engine `agents`); their tool calls go through the same policy. */
  subagents: z
    .record(z.string().regex(SUBAGENT_NAME, 'lowercase letters, digits and dashes'), SubagentSpec)
    .refine((r) => Object.keys(r).length <= 10, 'at most 10 subagents')
    .default({}),
  /** Peer Bots this Bot may delegate to (each delegation is a child Run). */
  delegation: BotDelegation.prefault({}),
  memory: BotMemorySettings.prefault({}),
  /** Plugins (ids) whose tools this Bot may use once the owner enabled them (ADR-014). */
  plugins: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'a plugin id'))
    .max(20)
    .refine((l) => new Set(l).size === l.length, 'listed twice')
    .default([]),
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
