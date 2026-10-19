import {
  AuthMethod,
  Bot,
  BotProposal,
  BotSpec,
  CreateMemoryBody,
  ImportMemoryBody,
  MEMORY_LIMITS,
  DriverKind,
  FeedbackBody,
  Memory,
  MemoryHit,
  MemoryImportResult,
  MemoryKind,
  MemorySweepResult,
  ExactVersion,
  NpmPackageName,
  PluginCatalogListing,
  PluginInstallPreview,
  PluginSandboxMode,
  PluginSandboxState,
  PluginStatus,
  PrincipalRole,
  RunEvent,
  Sha512Integrity,
  RunState,
  RunStatus,
  Tier,
  TriageUsage,
  UpdateMemoryBody,
} from '@orbit/core/browser';
import { z } from 'zod';

/**
 * The orbitd API contract: every route with its zod schemas. This one table
 * drives the Hono server (validation), the OpenAPI document and the typed
 * client in @orbit/sdk-client, so they cannot drift apart. Import it from
 * `@orbit/api/contract`; it depends on @orbit/core and zod only.
 */

export const API_VERSION = '1';

/**
 * Header every cookie-authenticated (App) request carries (ADR-011): the
 * session's CSRF secret from POST /v1/session. A page on another origin can
 * neither read it nor send the header without orbitd's CORS consent.
 */
export const CSRF_HEADER = 'x-orbit-csrf';

// ── shared schemas ─────────────────────────────────────────────────────────

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().nullable(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Browser sign-in through the issuer (hosted mode, ADR-015); not part of the client contract. */
export const OIDC_LOGIN_PATH = '/v1/auth/oidc/login';
export const OIDC_CALLBACK_PATH = '/v1/auth/oidc/callback';

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  api: z.literal(API_VERSION),
  pid: z.int(),
  startedAt: z.string(),
  /**
   * How a browser signs in: `ticket` (a one-time link from `orbit app`) or
   * `oidc` (hosted mode: the issuer, starting at OIDC_LOGIN_PATH).
   */
  signIn: z.enum(['ticket', 'oidc']).default('ticket'),
  /** Hosted mode: orbitd's public https origin; null locally. */
  publicUrl: z.string().nullable().default(null),
});

export const ApprovalCard = z.object({
  what: z.string(),
  why: z.string(),
  toolName: z.string(),
  tier: Tier,
  payload: z.record(z.string(), z.unknown()),
  diff: z.string().nullable(),
  botId: z.string(),
  botName: z.string(),
  runId: z.string(),
  untrusted: z.array(z.string()),
  risk: z.string(),
  /** Delegation chain when another Bot delegated the Run (M6); null otherwise. */
  delegatedBy: z.string().nullable().default(null),
});

export const ApprovalStatus = z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']);

export const Approval = z.object({
  id: z.string(),
  runId: z.string(),
  botId: z.string(),
  toolUseId: z.string().nullable(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  inputHash: z.string(),
  tier: Tier,
  card: ApprovalCard,
  status: ApprovalStatus,
  decision: z
    .object({
      decision: z.enum(['approved', 'denied', 'expired', 'cancelled']),
      by: z.string(),
      reason: z.string().nullable(),
      editedInput: z.record(z.string(), z.unknown()).nullable(),
      ruleId: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const Rule = z.object({
  id: z.string(),
  botId: z.string().nullable(),
  toolPattern: z.string(),
  inputMatch: z.record(z.string(), z.string()).nullable(),
  effect: z.enum(['allow', 'deny']),
  reason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export const AuditRecord = z.object({
  seq: z.int(),
  id: z.string(),
  ts: z.string(),
  actor: z.string(),
  action: z.string(),
  subject: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  prevHash: z.string(),
  hash: z.string(),
  /** HMAC-SHA256 of `hash` under the audit key; null for records written before the key existed. */
  mac: z.string().nullable(),
});

/** Which part of the chain is keyed (ADR-007, M8). */
const AuditKeying = {
  /** Records written before the audit key existed (not tampering). */
  unkeyed: z.int(),
  lastUnkeyedSeq: z.int().nullable(),
  keyedSince: z.object({ seq: z.int(), ts: z.string() }).nullable(),
};

export const AuditVerify = z.union([
  z.object({ ok: z.literal(true), count: z.int(), ...AuditKeying }),
  z.object({
    ok: z.literal(false),
    count: z.int(),
    firstBadSeq: z.int(),
    reason: z.string(),
    ...AuditKeying,
  }),
]);

export const AuditStatus = z.object({
  /** An audit key is loaded, so new records are keyed. */
  keyed: z.boolean(),
  count: z.int(),
  head: z.object({ seq: z.int(), hash: z.string(), ts: z.string() }).nullable(),
  ...AuditKeying,
});

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'a 64-character hex string');

/** A signed head of the audit chain, for the owner to keep outside ORBIT_HOME. */
export const AuditCheckpoint = z.object({
  kind: z.literal('orbit-audit-checkpoint'),
  v: z.literal(1),
  seq: z.int().min(1),
  hash: hex64,
  ts: z.string().max(64),
  count: z.int().min(1),
  mac: hex64,
});

export const AuditCheckpointVerify = z.object({
  /** The chain verifies and still contains the checkpoint, signed by this audit key. */
  ok: z.boolean(),
  reason: z.string().nullable(),
  chain: AuditVerify,
  /** Records appended after the checkpoint. */
  since: z.int(),
});

export const SecretMeta = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const QueueJob = z.object({
  kind: z.enum(['start', 'resume']),
  runId: z.string(),
  botId: z.string(),
  priority: z.int(),
});

export const QueueSnapshot = z.object({
  limit: z.int(),
  /** Set while a usage limit holds every start. */
  pausedUntil: z.string().nullable(),
  active: z.array(QueueJob),
  queued: z.array(
    QueueJob.extend({
      order: z.int(),
      enqueuedAt: z.string(),
      heldBy: z.string().nullable(),
    }),
  ),
});

export const ScheduleEntry = z.object({
  botId: z.string(),
  key: z.string(),
  kind: z.enum(['cron', 'interval']),
  description: z.string(),
  enabled: z.boolean(),
  nextAt: z.string().nullable(),
  lastFiredAt: z.string().nullable(),
  lastRunId: z.string().nullable(),
});

export const KillStatus = z.object({ engaged: z.boolean(), by: z.string().nullable() });

const CliStatus = z.object({
  path: z.string(),
  version: z.string().nullable(),
  loggedIn: z.boolean(),
  authMethod: z.string().nullable(),
  apiProvider: z.string().nullable(),
  error: z.string().nullable(),
});

const ProxyCounters = z.object({
  forwarded: z.int(),
  refused: z.int(),
  failed: z.int(),
  /** Latest refusals: a tunnel's host:port or an API route, never a query string or header. */
  recent: z.array(z.object({ at: z.string(), target: z.string(), reason: z.string() })),
});

/** Docker sandboxes (ADR-018): key proxy, images, and per-Bot proxy counters. */
export const DockerSandboxStatus = z.object({
  /** Docker Bots can run now: daemon reachable, key proxy usable, images present with socat. */
  ready: z.boolean(),
  /**
   * ready: orbitd has an API key (or apiKeyHelper) for the key proxy;
   * subscription: the CLI driver never runs containers; unsupported_provider:
   * Bedrock / Vertex cannot use the key proxy; no_api_key: nothing to inject.
   */
  keyProxy: z.enum(['ready', 'no_api_key', 'unsupported_provider', 'subscription']),
  detail: z.string(),
  images: z.array(
    z.object({ image: z.string(), present: z.boolean(), socat: z.boolean().nullable() }),
  ),
  proxies: z.array(
    z.object({
      botId: z.string(),
      network: z.enum(['none', 'allowlist']),
      activeRuns: z.int(),
      api: ProxyCounters,
      egress: ProxyCounters.nullable(),
      invalidAllowlistEntries: z.array(z.string()),
    }),
  ),
});
export type DockerSandboxStatus = z.infer<typeof DockerSandboxStatus>;

/** How the SDK engine gets its API credential (ADR-018). */
export const EngineKeyStatus = z.object({
  /**
   * proxied: an API key or apiKeyHelper output stays in orbitd and engines
   * reach the API through orbitd's key proxy (a loopback port with a token
   * per Run segment on the host, a Unix socket for Docker Bots); in_engine:
   * Bedrock / Vertex credentials, which cannot be proxied, are in the engine's env.
   */
  delivery: z.enum(['proxied', 'in_engine']),
  /**
   * Host engines run with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 (Claude Code
   * isolates its children; on Linux this needs bubblewrap); null = not checked.
   */
  subprocessScrub: z.boolean().nullable(),
  detail: z.string(),
  /** The host key proxy once the engine started: loopback port, live segments, counters. */
  proxy: z
    .object({ port: z.int().nullable(), activeSegments: z.int(), api: ProxyCounters })
    .nullable(),
});
export type EngineKeyStatus = z.infer<typeof EngineKeyStatus>;

export const DoctorReport = z.object({
  ok: z.boolean(),
  driver: DriverKind.nullable(),
  driverSource: z.enum(['forced', 'auto']),
  authMethod: AuthMethod,
  authLabel: z.string(),
  cli: CliStatus.nullable(),
  apiCredential: z.enum(['api_key', 'api_key_helper', 'bedrock', 'vertex']).nullable(),
  /** SDK driver: how the engine gets its API credential; null for other drivers. */
  engineKey: EngineKeyStatus.nullable(),
  compliance: z.object({
    allowed: z.boolean(),
    violations: z.array(z.string()),
    message: z.string().nullable(),
  }),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  refusal: z
    .object({
      code: z.enum(['compliance_refused', 'driver_unavailable']),
      message: z.string(),
      hint: z.string(),
    })
    .nullable(),
  onboarding: z.object({ reason: z.string(), steps: z.array(z.string()) }).nullable(),
  mode: z.string(),
  api: z.object({ host: z.string(), port: z.int() }),
  humanPrincipals: z.int(),
  /** Configured principals per role (ADR-015). */
  principals: z.object({ owner: z.int(), operator: z.int(), viewer: z.int() }),
  /** Hosted mode: where browsers and webhooks reach orbitd, and who signs them in; null locally. */
  hosted: z
    .object({
      publicUrl: z.string().nullable(),
      issuer: z.string().nullable(),
      tls: z.boolean(),
    })
    .nullable(),
  /** How orbitd listens: in-process TLS, and a container bind (0.0.0.0 inside a container). */
  listen: z.object({ tls: z.boolean(), container: z.boolean() }),
  models: z.object({ default: z.string(), triage: z.string() }),
  home: z.string(),
  node: z.string(),
  platform: z.string(),
  sandbox: z.object({
    docker: z.object({
      available: z.boolean(),
      version: z.string().nullable(),
      error: z.string().nullable(),
    }),
    engineSandbox: z.object({
      available: z.boolean(),
      missing: z.array(z.string()),
      platform: z.string(),
    }),
    dockerSandbox: DockerSandboxStatus,
    /** The OS sandbox for plugin servers (ADR-019). */
    plugins: z.object({
      mode: PluginSandboxMode,
      available: z.boolean(),
      engine: z.enum(['bwrap', 'sandbox-exec']).nullable(),
      /** Why the host cannot sandbox plugins (null when it can). */
      reason: z.string().nullable(),
      /** Enabled plugins that run without it (or do not start), and why. */
      notSandboxed: z.array(
        z.object({ id: z.string(), state: PluginSandboxState, reason: z.string().nullable() }),
      ),
    }),
  }),
  daemon: z.object({
    pid: z.int(),
    startedAt: z.string(),
    url: z.string(),
    concurrency: z.int(),
  }),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

export const RunTree = z.object({
  /** The top-level Run of the delegation tree. */
  root: z.string(),
  /** Every Run in the tree, parents before their children. */
  runs: z.array(RunState),
});

export const TaintedFile = z.object({
  path: z.string(),
  sources: z.array(z.string()),
  runId: z.string(),
  updatedAt: z.string(),
});

// ── the Bot's computer (ADR-020) ───────────────────────────────────────────

/** What a Bot's computer is doing, most pressing first (one per Bot). */
export const ComputerState = z.enum([
  /** The global kill switch is engaged. */
  'stopped',
  /** The owner's `orbit shell` holds the workspace (ADR-016). */
  'taken_over',
  /** The Bot is paused: nothing starts or resumes. */
  'paused',
  'working',
  /** A Run waits for an approval or was paused for the owner. */
  'needs_you',
  /** A Run is queued, waits for Bots it delegated to, or for a usage limit. */
  'waiting',
  'idle',
]);

export const ComputerStatus = z.object({
  botId: z.string(),
  state: ComputerState,
  /** The Run behind the state (working, needs you, waiting); null otherwise. */
  runId: z.string().nullable(),
  workspace: z.object({
    kind: z.enum(['directory', 'worktree', 'docker']),
    /** Host path of the workspace (Docker Bots: the folder mounted into the container). */
    path: z.string(),
    /** False until the Bot's first Run creates it. */
    exists: z.boolean(),
    /** Outbound network for shell commands. */
    network: z.enum(['none', 'allowlist']),
    allowedDomains: z.array(z.string()),
    /** Worktree Bots: the owner's repository. */
    repo: z.string().nullable(),
  }),
  takeover: z.object({ pid: z.int(), startedAt: z.string(), by: z.string() }).nullable(),
  /** How the Bot reaches the web. */
  web: z.object({
    /** The Browser plugin: listed and enabled (`ready`), listed but off, or not listed. */
    browser: z.enum(['ready', 'off', 'not_added']),
    /** WebFetch / WebSearch among the Bot's tools. */
    fetch: z.boolean(),
  }),
  /** What the owner types to take this computer over in a terminal; null for Docker Bots. */
  shellCommand: z.string().nullable(),
});

export const ComputerPathQuery = z.object({ path: z.string().max(1024).default('') });

export const ComputerEntry = z.object({
  name: z.string(),
  /** Relative to the workspace, `/`-separated. */
  path: z.string(),
  kind: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.int().nullable(),
  modifiedAt: z.string().nullable(),
  /** Written while untrusted content was in a Run (a directory: something in it). */
  tainted: z.boolean(),
});

export const ComputerListing = z.object({
  path: z.string(),
  exists: z.boolean(),
  entries: z.array(ComputerEntry),
  truncated: z.boolean(),
});

export const ComputerFile = z.object({
  path: z.string(),
  size: z.int(),
  modifiedAt: z.string(),
  /** binary files are not shown. */
  kind: z.enum(['text', 'binary']),
  text: z.string().nullable(),
  /** Only the start of the file is shown. */
  truncated: z.boolean(),
  /** A credential or vault secret in the text was masked. */
  redacted: z.boolean(),
  tainted: z.boolean(),
});

export const ComputerActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** One tool call of the Bot, with the decision and the (redacted, shortened) result. */
export const ComputerAction = z.object({
  runId: z.string(),
  conversationId: z.string(),
  toolUseId: z.string(),
  name: z.string(),
  input: z.unknown(),
  /** A subagent's call: the Task call that spawned the subagent. */
  parentToolUseId: z.string().nullable(),
  at: z.string(),
  decision: z
    .object({
      behavior: z.enum(['allow', 'deny']),
      tier: Tier.nullable(),
      reason: z.string(),
      approvalId: z.string().nullable(),
    })
    .nullable(),
  result: z
    .object({ isError: z.boolean(), content: z.string(), truncated: z.boolean() })
    .nullable(),
});

export const ProposeBotBody = z.object({ goal: z.string().trim().min(3).max(4000) });
export const BotProposalResult = z.object({
  proposal: BotProposal,
  model: z.string(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  costUsd: z.number().nullable(),
  usage: TriageUsage,
});

// ── request bodies and queries ─────────────────────────────────────────────

/** MockDriver scenario; only honoured when the daemon runs the mock driver. */
const fixture = z.string().trim().min(1).max(80).optional();

export const StartRunBody = z.object({
  prompt: z.string().trim().max(20_000).optional(),
  fixture,
  priority: z.int().min(-100).max(100).optional(),
  /**
   * A reply (ADR-020): the Run id of the conversation's latest turn, which
   * must have ended. The new Run resumes that conversation's engine session
   * and starts with its taint.
   */
  continues: z.string().trim().min(1).max(100).optional(),
});

export const ResumeRunBody = z.object({
  prompt: z.string().trim().max(20_000).optional(),
  fixture,
});

export const PauseRunBody = z.object({
  /** Stop the engine now (mid-turn) instead of at the Run's next tool call. */
  now: z.boolean().optional(),
});

export const StartTakeoverBody = z.object({
  /** The `orbit shell` process: a take-over whose process is gone is stale (ADR-016). */
  pid: z.int().positive(),
});

/** An open take-over of a Bot's workspace (`orbit shell`, ADR-016). */
export const Takeover = z.object({
  botId: z.string(),
  botName: z.string(),
  /** Where the shell starts: the Bot's workspace. */
  workspace: z.string(),
  /**
   * Worktree Bots: the shell's GIT_DIR (the worktree entry Orbit created in
   * the owner's repository) and GIT_WORK_TREE, so git never consults the
   * workspace's `.git`; `restored` when that `.git` had been changed and
   * Orbit put its own back. Null for directory Bots (no repository).
   */
  git: z
    .object({
      dir: z.string(),
      workTree: z.string(),
      restored: z.boolean(),
    })
    .nullable(),
  pid: z.int(),
  startedAt: z.string(),
  /** The Bot was paused before: it stays paused when the take-over ends. */
  wasPaused: z.boolean(),
  /** The pid of a stale take-over (its process gone) this one replaced; null otherwise. */
  replacedStale: z.int().nullable(),
  /** Runs of the Bot that wait (queued, parked, paused) until the take-over ends. */
  waiting: z.array(z.string()),
});

export const ApproveBody = z.object({
  editedInput: z.record(z.string(), z.unknown()).nullable().optional(),
  always: z
    .object({
      scope: z.enum(['bot', 'global']),
      expiresAt: z.iso.datetime().nullable(),
    })
    .nullable()
    .optional(),
  /** Resume the parked Run once nothing else is pending (default: the Bot's autoResume). */
  resume: z.boolean().optional(),
  fixture,
});

export const DenyBody = z.object({
  reason: z.string().trim().max(2000).nullable().optional(),
  resume: z.boolean().optional(),
  fixture,
});

export const DecisionResult = z.object({
  approval: Approval,
  /** The Run was queued to resume. */
  resumed: z.boolean(),
  run: RunState.nullable(),
});

export const CreateRuleBody = z.object({
  toolPattern: z.string().trim().min(1).max(200),
  effect: z.enum(['allow', 'deny']),
  /** Top-level arguments that must match (one value per `*`), e.g. {"to": "*@example.com"}. */
  inputMatch: z.record(z.string(), z.string()).nullable().optional(),
  bot: z.string().min(1).nullable().optional(),
  expiresAt: z.iso.datetime().nullable(),
  reason: z.string().max(2000).nullable().optional(),
});

export const SetSecretBody = z.object({
  value: z
    .string()
    .min(1)
    .max(64 * 1024),
});
export const KillBody = z.object({ on: z.boolean() });

export const AddPluginBody = z.object({
  /** Absolute path of a directory with an orbit-plugin.json. */
  dir: z.string().trim().min(1).max(1000),
});
export const SetPluginSettingBody = z.object({ value: z.string().max(2000).nullable() });

/** Install a plugin from the catalog (by id) or npm (exact version and SRI), ADR-019. */
export const InstallPluginBody = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('catalog'),
    id: z.string().min(1).max(64),
    /** Download and verify only: report what it would install, keep nothing. */
    dryRun: z.boolean().default(false),
  }),
  z.object({
    source: z.literal('npm'),
    package: NpmPackageName,
    version: ExactVersion,
    integrity: Sha512Integrity,
    dryRun: z.boolean().default(false),
  }),
]);
export const InstallPluginResult = z.object({
  preview: PluginInstallPreview,
  /** The installed plugin (off until you enable it); null for a dry run. */
  plugin: PluginStatus.nullable(),
});

export const InboundTrigger = z.object({
  botId: z.string(),
  botName: z.string(),
  key: z.string(),
  kind: z.enum(['webhook', 'slack', 'file', 'git']),
  description: z.string(),
  enabled: z.boolean(),
  state: z.enum(['listening', 'connecting', 'needs_setup', 'error', 'off']),
  detail: z.string().nullable(),
  /** Webhooks: the path to POST to on orbitd's loopback port. */
  path: z.string().nullable(),
  /** Webhooks in hosted mode: the public address senders on other machines use. */
  url: z.string().nullable().default(null),
});

export const WebhookSecret = z.object({
  /** Shown once; Orbit keeps it in the vault. */
  secret: z.string(),
  path: z.string(),
  /** Hosted mode: the public address to give the sender; null locally (use a tunnel). */
  url: z.string().nullable().default(null),
  style: z.enum(['orbit', 'github']),
  /** What a sender must add. */
  headers: z.array(z.string()),
});

export const WebhookAccepted = z.object({
  accepted: z.literal(true),
  runId: z.string().nullable(),
});

/** Who is calling: the bearer token acts as the owner; a browser session as its principal. */
export const SessionPrincipal = z.object({
  id: z.string(),
  name: z.string(),
  role: PrincipalRole,
});
export type SessionPrincipal = z.infer<typeof SessionPrincipal>;

export const SessionInfo = z.object({
  /** How this request authenticated: the bearer token (CLI, TUI) or the App's cookie. */
  via: z.enum(['token', 'session']),
  principal: SessionPrincipal,
});
export const LoginTicket = z.object({ ticket: z.string(), expiresAt: z.string() });
export const CreateSessionBody = z.object({ ticket: z.string().min(16).max(128) });
/**
 * The session's CSRF secret: the App keeps it in its own origin's storage and
 * sends it as X-Orbit-CSRF. The HttpOnly cookie alone is not a credential.
 */
export const SessionCreated = z.object({ ok: z.literal(true), csrf: z.string() });

const boolQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();
const limitQuery = (max: number) => z.coerce.number().int().min(1).max(max).optional();

export const ListRunsQuery = z.object({
  bot: z.string().optional(),
  /** Only the turns of one conversation: its first Run's id (ADR-020). */
  conversation: z.string().optional(),
  status: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(RunStatus))
    .optional(),
  limit: limitQuery(500),
});
export const RunEventsQuery = z.object({ afterSeq: z.coerce.number().int().min(0).optional() });
export const ListApprovalsQuery = z.object({
  status: ApprovalStatus.optional(),
  all: boolQuery,
  run: z.string().optional(),
});
export const ListRulesQuery = z.object({ all: boolQuery });
export const ListAuditQuery = z.object({
  action: z.string().optional(),
  limit: limitQuery(10_000),
});
export const SchedulesQuery = z.object({ bot: z.string().optional() });
export const ListMemoryQuery = z.object({
  bot: z.string().optional(),
  /** Full-text search over titles and bodies. */
  q: z.string().trim().max(200).optional(),
  kind: MemoryKind.optional(),
  limit: limitQuery(500),
});
export const ExportMemoryQuery = z.object({ bot: z.string().optional() });
export const EventsQuery = z.object({
  run: z.string().optional(),
  bot: z.string().optional(),
  /** Start after this event id (same as the Last-Event-ID header). Default: only new events, or the whole Run when `run` is set. */
  after: z.coerce.number().int().min(0).optional(),
});

// ── the route table ────────────────────────────────────────────────────────

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** OpenAPI-style path with `{param}` segments. */
  path: string;
  summary: string;
  tag: string;
  /** false only for /v1/health, /openapi.json and redeeming a sign-in ticket. */
  auth?: boolean;
  /**
   * The least role that may call this route (ADR-015); default `viewer` for
   * GET and `owner` for everything else (see routeRole).
   */
  role?: PrincipalRole;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Success status (default 200). */
  status?: 200 | 201 | 202;
  /** JSON response schema; omitted for streams (`stream` says which). */
  response?: z.ZodType;
  stream?: 'sse' | 'jsonl';
  /** Request body limit when it must exceed the default 1 MiB (imports). */
  maxBodyBytes?: number;
}

const ok = z.object({ ok: z.literal(true) });

export const routes = {
  health: {
    method: 'GET',
    path: '/v1/health',
    summary: 'Liveness probe (no token needed)',
    tag: 'daemon',
    auth: false,
    response: Health,
  },
  doctor: {
    method: 'GET',
    path: '/v1/doctor',
    summary: 'Driver, auth method, compliance, models and sandbox support',
    tag: 'daemon',
    response: DoctorReport,
  },
  stopDaemon: {
    method: 'POST',
    path: '/v1/daemon/stop',
    summary:
      'Gracefully stop orbitd (executing Runs are interrupted; safe ones resume at the next start)',
    tag: 'daemon',
    status: 202,
    response: ok,
  },
  getSession: {
    method: 'GET',
    path: '/v1/session',
    summary: 'How the caller is signed in (token or App session)',
    tag: 'session',
    response: SessionInfo,
  },
  createLoginTicket: {
    method: 'POST',
    path: '/v1/session/tickets',
    summary: 'One-time App login ticket (bearer token only; `orbit app` opens it)',
    tag: 'session',
    status: 201,
    response: LoginTicket,
  },
  createSession: {
    method: 'POST',
    role: 'viewer',
    path: '/v1/session',
    summary: 'Redeem a login ticket for an HttpOnly App session cookie',
    tag: 'session',
    auth: false,
    body: CreateSessionBody,
    status: 201,
    response: SessionCreated,
  },
  deleteSession: {
    method: 'DELETE',
    role: 'viewer',
    path: '/v1/session',
    summary: 'Sign this App session out',
    tag: 'session',
    response: ok,
  },
  listBots: {
    method: 'GET',
    path: '/v1/bots',
    summary: 'List Bots',
    tag: 'bots',
    response: z.array(Bot),
  },
  createBot: {
    method: 'POST',
    path: '/v1/bots',
    summary: 'Create a Bot',
    tag: 'bots',
    body: BotSpec,
    status: 201,
    response: Bot,
  },
  getBot: {
    method: 'GET',
    path: '/v1/bots/{bot}',
    summary: 'Get a Bot by id or name',
    tag: 'bots',
    response: Bot,
  },
  updateBot: {
    method: 'PUT',
    path: '/v1/bots/{bot}',
    summary: 'Replace a Bot spec (creates a new version)',
    tag: 'bots',
    body: BotSpec,
    response: Bot,
  },
  botVersions: {
    method: 'GET',
    path: '/v1/bots/{bot}/versions',
    summary: 'Version history of a Bot spec',
    tag: 'bots',
    response: z.array(z.object({ version: z.int(), spec: BotSpec, createdAt: z.string() })),
  },
  pauseBot: {
    method: 'POST',
    path: '/v1/bots/{bot}/pause',
    summary: 'Bot kill switch: stop its Runs and block new ones',
    tag: 'controls',
    response: Bot,
  },
  resumeBot: {
    method: 'POST',
    path: '/v1/bots/{bot}/resume',
    summary: 'Allow a paused Bot to run again',
    tag: 'controls',
    response: Bot,
  },
  startRun: {
    method: 'POST',
    role: 'operator',
    path: '/v1/bots/{bot}/runs',
    summary: 'Queue a Run of this Bot (manual trigger)',
    tag: 'runs',
    body: StartRunBody,
    status: 202,
    response: RunState,
  },
  listRuns: {
    method: 'GET',
    path: '/v1/runs',
    summary: 'Recent Runs, newest first',
    tag: 'runs',
    query: ListRunsQuery,
    response: z.array(RunState),
  },
  getRun: {
    method: 'GET',
    path: '/v1/runs/{run}',
    summary: 'One Run (projection of its event log)',
    tag: 'runs',
    response: RunState,
  },
  runEvents: {
    method: 'GET',
    path: '/v1/runs/{run}/events',
    summary: "A Run's events in order (replay)",
    tag: 'runs',
    query: RunEventsQuery,
    response: z.array(RunEvent),
  },
  stopRun: {
    method: 'POST',
    role: 'operator',
    path: '/v1/runs/{run}/stop',
    summary: 'Run kill switch (queued, executing, parked or rate-limited)',
    tag: 'controls',
    response: RunState,
  },
  pauseRun: {
    method: 'POST',
    role: 'operator',
    path: '/v1/runs/{run}/pause',
    summary: 'Pause a running Run at its next tool call (or now); resume it later',
    tag: 'controls',
    body: PauseRunBody,
    response: RunState,
  },
  startTakeover: {
    method: 'POST',
    path: '/v1/bots/{bot}/takeover',
    summary: "Hold a Bot and hand its workspace to the owner's shell (bearer token only)",
    tag: 'controls',
    body: StartTakeoverBody,
    status: 201,
    response: Takeover,
  },
  endTakeover: {
    method: 'DELETE',
    path: '/v1/bots/{bot}/takeover',
    summary: 'End a take-over; the Bot runs again unless it was paused before (bearer token only)',
    tag: 'controls',
    response: Bot,
  },
  resumeRun: {
    method: 'POST',
    role: 'operator',
    path: '/v1/runs/{run}/resume',
    summary: 'Queue a resume of a parked (all decided), paused or rate-limited Run',
    tag: 'runs',
    body: ResumeRunBody,
    status: 202,
    response: RunState,
  },
  listApprovals: {
    method: 'GET',
    path: '/v1/approvals',
    summary: 'Approval cards (pending by default)',
    tag: 'approvals',
    query: ListApprovalsQuery,
    response: z.array(Approval),
  },
  getApproval: {
    method: 'GET',
    path: '/v1/approvals/{approval}',
    summary: 'One approval card',
    tag: 'approvals',
    response: Approval,
  },
  approve: {
    method: 'POST',
    role: 'operator',
    path: '/v1/approvals/{approval}/approve',
    summary: 'Approve (optionally edited, optionally always)',
    tag: 'approvals',
    body: ApproveBody,
    response: DecisionResult,
  },
  deny: {
    method: 'POST',
    role: 'operator',
    path: '/v1/approvals/{approval}/deny',
    summary: 'Deny with a reason the Bot will see',
    tag: 'approvals',
    body: DenyBody,
    response: DecisionResult,
  },
  listRules: {
    method: 'GET',
    path: '/v1/rules',
    summary: 'Standing allow/deny rules',
    tag: 'policy',
    query: ListRulesQuery,
    response: z.array(Rule),
  },
  createRule: {
    method: 'POST',
    path: '/v1/rules',
    summary: 'Create a standing rule (user-authored only)',
    tag: 'policy',
    body: CreateRuleBody,
    status: 201,
    response: Rule,
  },
  revokeRule: {
    method: 'POST',
    path: '/v1/rules/{rule}/revoke',
    summary: 'Revoke a standing rule',
    tag: 'policy',
    response: Rule,
  },
  listAudit: {
    method: 'GET',
    role: 'owner',
    path: '/v1/audit',
    summary: 'Latest audit records (oldest first)',
    tag: 'audit',
    query: ListAuditQuery,
    response: z.array(AuditRecord),
  },
  verifyAudit: {
    method: 'GET',
    path: '/v1/audit/verify',
    summary: 'Check the audit hash chain',
    tag: 'audit',
    response: AuditVerify,
  },
  exportAudit: {
    method: 'GET',
    role: 'owner',
    path: '/v1/audit/export',
    summary: 'The whole audit log as JSON Lines',
    tag: 'audit',
    stream: 'jsonl',
  },
  auditStatus: {
    method: 'GET',
    role: 'owner',
    path: '/v1/audit/status',
    summary: 'Whether the audit chain is keyed, since when, and its head (no hashing)',
    tag: 'audit',
    response: AuditStatus,
  },
  auditCheckpoint: {
    method: 'POST',
    path: '/v1/audit/checkpoint',
    summary: 'Append a checkpoint record and return it signed with the audit key',
    tag: 'audit',
    response: AuditCheckpoint,
  },
  verifyAuditCheckpoint: {
    method: 'POST',
    path: '/v1/audit/checkpoint/verify',
    summary: 'Check that the audit chain still contains a checkpoint you kept',
    tag: 'audit',
    body: AuditCheckpoint,
    response: AuditCheckpointVerify,
  },
  listSecrets: {
    method: 'GET',
    role: 'owner',
    path: '/v1/secrets',
    summary: 'Secret names (values are never returned)',
    tag: 'secrets',
    response: z.array(SecretMeta),
  },
  setSecret: {
    method: 'PUT',
    path: '/v1/secrets/{name}',
    summary: 'Store a secret in the encrypted vault',
    tag: 'secrets',
    body: SetSecretBody,
    response: z.object({ name: z.string(), keySource: z.enum(['keychain', 'file']) }),
  },
  removeSecret: {
    method: 'DELETE',
    path: '/v1/secrets/{name}',
    summary: 'Remove a secret',
    tag: 'secrets',
    response: ok,
  },
  killStatus: {
    method: 'GET',
    path: '/v1/kill',
    summary: 'Is the global kill switch engaged?',
    tag: 'controls',
    response: KillStatus,
  },
  setKill: {
    method: 'POST',
    path: '/v1/kill',
    summary: 'Engage (stop everything, refuse new Runs) or release the global kill switch',
    tag: 'controls',
    body: KillBody,
    response: KillStatus,
  },
  queue: {
    method: 'GET',
    path: '/v1/queue',
    summary: 'Run queue: active, waiting, limit and usage-limit hold',
    tag: 'runs',
    response: QueueSnapshot,
  },
  schedules: {
    method: 'GET',
    path: '/v1/schedules',
    summary: 'Scheduled triggers and their next fire',
    tag: 'runs',
    query: SchedulesQuery,
    response: z.array(ScheduleEntry),
  },
  listMemory: {
    method: 'GET',
    path: '/v1/memory',
    summary: 'Memories (of one Bot, or all), newest first; `q` searches the full text',
    tag: 'memory',
    query: ListMemoryQuery,
    response: z.array(MemoryHit),
  },
  createMemory: {
    method: 'POST',
    path: '/v1/bots/{bot}/memory',
    summary: 'Write a memory for a Bot (trusted: written by you)',
    tag: 'memory',
    body: CreateMemoryBody,
    status: 201,
    response: Memory,
  },
  // Before getMemory: `/v1/memory/{memory}` would match `export` too.
  exportMemory: {
    method: 'GET',
    role: 'owner',
    path: '/v1/memory/export',
    summary:
      "A Bot's memories (or every Bot's) as JSON Lines with provenance (versioned header first)",
    tag: 'memory',
    query: ExportMemoryQuery,
    stream: 'jsonl',
  },
  importMemory: {
    method: 'POST',
    path: '/v1/bots/{bot}/memory/import',
    summary:
      'Import an export into a Bot (validated, redacted, bounded; provenance kept; `dryRun` previews counts and trust)',
    tag: 'memory',
    body: ImportMemoryBody,
    maxBodyBytes: MEMORY_LIMITS.importBytes,
    response: MemoryImportResult,
  },
  sweepMemory: {
    method: 'POST',
    path: '/v1/memory/sweep',
    summary:
      'Apply memory retention now (orbitd also does it daily): expire old unpinned Bot notes and summaries, trim to the bound',
    tag: 'memory',
    response: MemorySweepResult,
  },
  getMemory: {
    method: 'GET',
    path: '/v1/memory/{memory}',
    summary: 'One memory with its provenance',
    tag: 'memory',
    response: Memory,
  },
  updateMemory: {
    method: 'PUT',
    path: '/v1/memory/{memory}',
    summary: 'Edit a memory (title, body, pin); `trusted: true` clears its taint after your review',
    tag: 'memory',
    body: UpdateMemoryBody,
    response: Memory,
  },
  deleteMemory: {
    method: 'DELETE',
    path: '/v1/memory/{memory}',
    summary: 'Delete a memory (and its markdown file)',
    tag: 'memory',
    response: ok,
  },
  runMemory: {
    method: 'GET',
    path: '/v1/runs/{run}/memory',
    summary: 'Memories a Run wrote (notes, its summary, feedback about it)',
    tag: 'memory',
    response: z.array(Memory),
  },
  runFeedback: {
    method: 'POST',
    role: 'operator',
    path: '/v1/runs/{run}/feedback',
    summary: 'Thumbs up or down on a finished Run (becomes feedback memory)',
    tag: 'memory',
    body: FeedbackBody,
    status: 201,
    response: Memory,
  },
  runTree: {
    method: 'GET',
    path: '/v1/runs/{run}/tree',
    summary: 'The delegation tree a Run belongs to (top-level Run and every child Run)',
    tag: 'runs',
    response: RunTree,
  },
  botTaint: {
    method: 'GET',
    path: '/v1/bots/{bot}/taint',
    summary: 'Workspace files written while untrusted content was in a Run',
    tag: 'memory',
    response: z.array(TaintedFile),
  },
  clearBotTaint: {
    method: 'DELETE',
    path: '/v1/bots/{bot}/taint',
    summary: 'Forget workspace taint after you reviewed the files',
    tag: 'memory',
    response: z.object({ cleared: z.int() }),
  },
  getComputer: {
    method: 'GET',
    path: '/v1/bots/{bot}/computer',
    summary: "The Bot's computer: what it is doing, its workspace, take-over and web access",
    tag: 'computer',
    response: ComputerStatus,
  },
  // Files are the operator's (review ADR-020 F2): an operator can have the Bot
  // read any of them anyway; a viewer would see more than Run events show
  // (a worktree Bot's whole repository).
  computerFiles: {
    method: 'GET',
    role: 'operator',
    path: '/v1/bots/{bot}/computer/files',
    summary: "List a directory of the Bot's workspace (links are never followed; .git is hidden)",
    tag: 'computer',
    query: ComputerPathQuery,
    response: ComputerListing,
  },
  computerFile: {
    method: 'GET',
    role: 'operator',
    path: '/v1/bots/{bot}/computer/file',
    summary: "Preview a file of the Bot's workspace (text only, capped, redacted)",
    tag: 'computer',
    query: ComputerPathQuery,
    response: ComputerFile,
  },
  computerActivity: {
    method: 'GET',
    path: '/v1/bots/{bot}/computer/activity',
    summary:
      "The Bot's latest tool calls across its Runs, with decisions and results, newest first",
    tag: 'computer',
    query: ComputerActivityQuery,
    response: z.array(ComputerAction),
  },
  triageUsage: {
    method: 'GET',
    path: '/v1/triage',
    summary: 'Triage-model calls today (summaries, proposals) against the daily limit',
    tag: 'memory',
    response: TriageUsage,
  },
  proposeBot: {
    method: 'POST',
    path: '/v1/triage/bot-proposal',
    summary: 'Ask the triage model to propose a Bot config from a goal (one metered call)',
    tag: 'bots',
    body: ProposeBotBody,
    response: BotProposalResult,
  },
  listPlugins: {
    method: 'GET',
    path: '/v1/plugins',
    summary:
      'Plugins Orbit knows (reference plugins and ones you added) with their state, tools and tiers',
    tag: 'plugins',
    response: z.array(PluginStatus),
  },
  addPlugin: {
    method: 'POST',
    path: '/v1/plugins',
    summary:
      'Add a plugin from a directory with an orbit-plugin.json (disabled until you enable it)',
    tag: 'plugins',
    body: AddPluginBody,
    status: 201,
    response: PluginStatus,
  },
  pluginCatalog: {
    method: 'GET',
    path: '/v1/plugin-catalog',
    summary: 'Plugins the configured catalog lists (plugins.catalogUrl), with what is installed',
    tag: 'plugins',
    response: PluginCatalogListing,
  },
  installPlugin: {
    method: 'POST',
    path: '/v1/plugin-installs',
    summary:
      'Install a plugin from the catalog or npm: SRI-verified, unpacked without running anything, off until you enable it (dryRun reports what it would install)',
    tag: 'plugins',
    body: InstallPluginBody,
    response: InstallPluginResult,
  },
  getPlugin: {
    method: 'GET',
    path: '/v1/plugins/{plugin}',
    summary: 'One plugin: manifest, state, tools with tiers, secrets (set or not), settings',
    tag: 'plugins',
    response: PluginStatus,
  },
  removePlugin: {
    method: 'DELETE',
    path: '/v1/plugins/{plugin}',
    summary: 'Forget a plugin you added (and its secrets); reference plugins can only be disabled',
    tag: 'plugins',
    response: ok,
  },
  enablePlugin: {
    method: 'POST',
    path: '/v1/plugins/{plugin}/enable',
    summary: 'Check the plugin (start it, list its tools) and offer it to the Bots that list it',
    tag: 'plugins',
    response: PluginStatus,
  },
  disablePlugin: {
    method: 'POST',
    path: '/v1/plugins/{plugin}/disable',
    summary: 'Stop offering the plugin to Bots',
    tag: 'plugins',
    response: PluginStatus,
  },
  checkPlugin: {
    method: 'POST',
    path: '/v1/plugins/{plugin}/check',
    summary: 'Start the plugin once and list its tools (does not enable it)',
    tag: 'plugins',
    response: PluginStatus,
  },
  setPluginSecret: {
    method: 'PUT',
    path: '/v1/plugins/{plugin}/secrets/{name}',
    summary:
      "Store one of the plugin's declared secrets in the vault (only that plugin receives it)",
    tag: 'plugins',
    body: SetSecretBody,
    response: PluginStatus,
  },
  removePluginSecret: {
    method: 'DELETE',
    path: '/v1/plugins/{plugin}/secrets/{name}',
    summary: "Remove one of the plugin's secrets",
    tag: 'plugins',
    response: PluginStatus,
  },
  setPluginSetting: {
    method: 'PUT',
    path: '/v1/plugins/{plugin}/settings/{name}',
    summary: 'Set (or clear with null) a non-secret plugin setting',
    tag: 'plugins',
    body: SetPluginSettingBody,
    response: PluginStatus,
  },
  listTriggers: {
    method: 'GET',
    path: '/v1/triggers',
    summary: 'Inbound triggers (webhooks, Slack, files, git) and whether they are listening',
    tag: 'plugins',
    response: z.array(InboundTrigger),
  },
  webhookSecret: {
    method: 'POST',
    path: '/v1/bots/{bot}/webhooks/{trigger}/secret',
    summary: "Mint (or rotate) a webhook trigger's signing secret; shown once",
    tag: 'plugins',
    response: WebhookSecret,
  },
  events: {
    method: 'GET',
    path: '/v1/events',
    summary:
      'Server-Sent Events feed of RunEvents (id = event id; resume with Last-Event-ID; heartbeat comments every 15 s)',
    tag: 'runs',
    query: EventsQuery,
    stream: 'sse',
  },
} as const satisfies Record<string, RouteDef>;

export type Routes = typeof routes;

/** The least role that may call a route (ADR-015): reads are for viewers, writes for owners unless the table says otherwise. */
export function routeRole(def: RouteDef): PrincipalRole {
  return def.role ?? (def.method === 'GET' ? 'viewer' : 'owner');
}
export type RouteName = keyof Routes;

type Field<R, K extends string> = R extends Record<K, infer S> ? S : never;
export type RouteResponse<N extends RouteName> =
  Field<Routes[N], 'response'> extends z.ZodType ? z.output<Field<Routes[N], 'response'>> : never;
export type RouteBody<N extends RouteName> =
  Field<Routes[N], 'body'> extends z.ZodType ? z.input<Field<Routes[N], 'body'>> : never;
export type RouteQuery<N extends RouteName> =
  Field<Routes[N], 'query'> extends z.ZodType ? z.input<Field<Routes[N], 'query'>> : never;

/** `{bot}` → `{ bot: string }` for the path parameters of a route. */
export type RouteParams<N extends RouteName> = Record<PathParams<Routes[N]['path']>, string>;
type PathParams<P extends string> = P extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PathParams<Rest>
  : never;

/** Fill `{param}` segments (URL-encoded). */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(v);
  });
}

/** OpenAPI path → Hono path (`{bot}` → `:bot`). */
export function honoPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

/** HTTP status for each Orbit error code (the body is always ErrorBody). */
export const STATUS_FOR_CODE: Record<string, number> = {
  invalid_input: 400,
  invalid_config: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  blocked: 409,
  payload_too_large: 413,
  internal: 500,
  engine_error: 502,
  auth_required: 503,
  compliance_refused: 503,
  driver_unavailable: 503,
  daemon_unavailable: 503,
};
