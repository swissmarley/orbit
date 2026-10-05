import {
  AuthMethod,
  Bot,
  BotSpec,
  DriverKind,
  RunEvent,
  RunState,
  RunStatus,
  Tier,
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

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  api: z.literal(API_VERSION),
  pid: z.int(),
  startedAt: z.string(),
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
});

export const AuditVerify = z.union([
  z.object({ ok: z.literal(true), count: z.int() }),
  z.object({
    ok: z.literal(false),
    count: z.int(),
    firstBadSeq: z.int(),
    reason: z.string(),
  }),
]);

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

export const DoctorReport = z.object({
  ok: z.boolean(),
  driver: DriverKind.nullable(),
  driverSource: z.enum(['forced', 'auto']),
  authMethod: AuthMethod,
  authLabel: z.string(),
  cli: CliStatus.nullable(),
  apiCredential: z.enum(['api_key', 'api_key_helper', 'bedrock', 'vertex']).nullable(),
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
  }),
  daemon: z.object({
    pid: z.int(),
    startedAt: z.string(),
    url: z.string(),
    concurrency: z.int(),
  }),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

// ── request bodies and queries ─────────────────────────────────────────────

/** MockDriver scenario; only honoured when the daemon runs the mock driver. */
const fixture = z.string().trim().min(1).max(80).optional();

export const StartRunBody = z.object({
  prompt: z.string().trim().max(20_000).optional(),
  fixture,
  priority: z.int().min(-100).max(100).optional(),
});

export const ResumeRunBody = z.object({
  prompt: z.string().trim().max(20_000).optional(),
  fixture,
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

export const SessionInfo = z.object({
  /** How this request authenticated: the bearer token (CLI, TUI) or the App's cookie. */
  via: z.enum(['token', 'session']),
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
  /** false only for /v1/health and /openapi.json. */
  auth?: boolean;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Success status (default 200). */
  status?: 200 | 201 | 202;
  /** JSON response schema; omitted for streams (`stream` says which). */
  response?: z.ZodType;
  stream?: 'sse' | 'jsonl';
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
    summary: 'Gracefully stop orbitd (executing Runs end as interrupted)',
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
    path: '/v1/runs/{run}/stop',
    summary: 'Run kill switch (queued, executing, parked or rate-limited)',
    tag: 'controls',
    response: RunState,
  },
  resumeRun: {
    method: 'POST',
    path: '/v1/runs/{run}/resume',
    summary: 'Queue a resume of a parked (all decided) or rate-limited Run',
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
    path: '/v1/approvals/{approval}/approve',
    summary: 'Approve (optionally edited, optionally always)',
    tag: 'approvals',
    body: ApproveBody,
    response: DecisionResult,
  },
  deny: {
    method: 'POST',
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
    path: '/v1/audit/export',
    summary: 'The whole audit log as JSON Lines',
    tag: 'audit',
    stream: 'jsonl',
  },
  listSecrets: {
    method: 'GET',
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
