import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import {
  type Bot,
  type BotProposal,
  BotSandbox,
  BotSpec,
  type BotSpecInput,
  type Memory,
  type MemoryImportResult,
  type MemorySweepResult,
  type OrbitConfig,
  OrbitError,
  Redactor,
  type RunState,
  type PluginInstallPreview,
  type PluginStatus,
  type TriggerRef,
  type TriggerSpec,
  errorMessage,
  pluginSecretKey,
  event,
  humanPrincipalCount,
  principalsByRole,
  runLabel,
  slugify,
} from '@orbit/core';
import {
  MemoryStore,
  PROPOSAL_SYSTEM,
  SUMMARY_SYSTEM,
  TriageLedger,
  type TriageUsage,
  WorkspaceTaint,
  type TaintedPath,
  approvalFeedback,
  memoryExportHeader,
  memoryExportLine,
  parseMemoryImport,
  parseProposal,
  parseSummary,
  proposalPrompt,
  resultSummary,
  runTranscript,
  summaryPrompt,
  thumbsFeedback,
} from '@orbit/memory';
import {
  type Approval,
  ApprovalQueue,
  type AuditRecord,
  AuditLog,
  PolicyEngine,
  type Rule,
  RuleStore,
  SecretVault,
  classifyTool,
  loadAuditKey,
} from '@orbit/policy';
import {
  API_CREDENTIALS,
  type AuthProbes,
  type AuthResolution,
  type DriverHandle,
  type Env,
  type MockDriverOptions,
  ORBIT_TOOL_TIERS,
  Orchestrator,
  OrbitSessions,
  OrbitToolset,
  type OrbitRunSession,
  type QueryFn,
  type QueueJob,
  RateLimitManager,
  RunQueue,
  Scheduler,
  type ScheduleEntry,
  type WorkspaceProvider,
  type InboundContent,
  type InboundStatus,
  PluginInstaller,
  type PluginInstallRequest,
  PluginRegistry,
  PluginSegments,
  TriggerRouter,
  defaultStoreDir,
  buildChildEnv,
  gitRunner,
  triggerKey,
  triggerPrompt,
  verifyWebhook,
  webhookSecretName,
  signGithubWebhook,
  MAX_WEBHOOK_BYTES,
  WEBHOOK_KEEP_MS,
  createDriver,
  apiUpstream,
  createSandboxManager,
  driverTriage,
  keyProxyCredential,
  mockTriage,
  childBudget,
  remainingBudget,
  resolveAuth,
  TriagePath,
  sandboxWorkspaces,
  systemProbes,
  validateTriggers,
  type ApiKeyOrigin,
} from '@orbit/runtime';
import {
  type EngineCredential,
  type PluginSandboxSupport,
  SandboxManager,
  type TakeoverGit,
  defaultRunner,
  detectPluginSandbox,
  detectSandboxSupport,
  parseUpstream,
  prepareTakeoverGit,
} from '@orbit/sandbox';
import {
  BotRepo,
  Controls,
  EventStore,
  type OrbitDb,
  type Takeover,
  TriggerStateRepo,
  migrationAppliedAt,
} from '@orbit/store';
import type { z } from 'zod';
import type {
  ApproveBody,
  CreateRuleBody,
  DecisionResult,
  DenyBody,
  DockerSandboxStatus,
  DoctorReport,
  EngineKeyStatus,
  QueueSnapshot,
  SessionPrincipal,
  Takeover as TakeoverInfo,
} from './contract';

/**
 * The bearer token's principal id, and the actor recorded for API calls made
 * outside any request (local mode has only this one owner). Hosted requests
 * record their own principal (ADR-015).
 */
export const OWNER = 'owner';
const DAY_MS = 86_400_000;

const IN_FLIGHT: readonly RunState['status'][] = [
  'queued',
  'running',
  'waiting_approval',
  'delegating',
  'rate_limited',
  'paused',
];

const ENDED: readonly RunState['status'][] = ['completed', 'failed', 'cancelled'];

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;

/** Whether a local process still exists (a take-over's `orbit shell`). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ServiceOptions {
  config: OrbitConfig;
  /** The daemon's own environment: read for credentials, never spread into children. */
  env: Env;
  /** Where `env.ANTHROPIC_API_KEY` came from; `environment` makes doctor warn. */
  apiKeyOrigin?: ApiKeyOrigin | null;
  db: OrbitDb;
  version: string;
  /** Tests: fake `claude` probes, an injected SDK query(), mock pacing, plain directories. */
  probes?: AuthProbes;
  queryFn?: QueryFn;
  mock?: MockDriverOptions;
  workspaces?: WorkspaceProvider;
  /** Housekeeping interval: scheduler, approval expiry, usage-limit resumes. Default 1000 ms. */
  tickMs?: number;
  killPollMs?: number;
  /**
   * Where the vault and audit keys live; default 'auto' (keychain, else a
   * 0600 file under ORBIT_HOME). Tests use 'file'.
   */
  vaultKeySource?: 'auto' | 'keychain' | 'file';
  /** Markdown mirror of memories; default $ORBIT_HOME/memory, null = none (tests). */
  memoryDir?: string | null;
  /** Reference plugins directory; default the repository's plugins/, null = none (tests). */
  pluginsDir?: string | null;
  /** Tests: what this host's plugin sandbox can do (default: detected once, ADR-019). */
  pluginSandbox?: PluginSandboxSupport;
  /** Tests: fetch for the plugin catalog and registry. */
  pluginFetch?: typeof fetch;
  /** Tests: Slack Socket Mode doubles. */
  slack?: {
    fetch?: typeof fetch;
    connect?: ConstructorParameters<typeof TriggerRouter>[0]['slackConnect'];
  };
  log?: Logger;
  now?: () => Date;
  /** How orbitd listens (shown by doctor): in-process TLS, container bind. */
  listen?: { tls: boolean; container: boolean };
  /** Tests: whether a take-over's CLI process is still there. */
  processAlive?: (pid: number) => boolean;
}

/**
 * Everything orbitd does, behind the HTTP API. orbitd is the single writer:
 * all Runs execute here, through one orchestrator, one queue (global
 * concurrency), one scheduler and one approval queue.
 */
export class OrbitService {
  readonly config: OrbitConfig;
  readonly redactor: Redactor;
  readonly store: EventStore;
  readonly bots: BotRepo;
  readonly controls: Controls;
  readonly audit: AuditLog;
  readonly rules: RuleStore;
  readonly approvals: ApprovalQueue;
  readonly vault: SecretVault;
  readonly orchestrator: Orchestrator;
  readonly queue: RunQueue;
  readonly scheduler: Scheduler;
  readonly rateLimits: RateLimitManager;
  readonly memory: MemoryStore;
  readonly workspaceTaint: WorkspaceTaint;
  readonly orbitTools: OrbitToolset;
  readonly orbitSessions: OrbitSessions;
  readonly triage: TriagePath;
  readonly plugins: PluginRegistry;
  readonly pluginInstaller: PluginInstaller;
  readonly pluginSegments: PluginSegments;
  readonly triggers: TriggerRouter;
  private readonly triggerState: TriggerStateRepo;
  readonly startedAt: string;
  readonly version: string;
  /** Base URL once orbitd listens (shown by doctor). */
  url = '';
  private readonly pluginSandboxSupport: () => PluginSandboxSupport;

  private engine: { resolution: AuthResolution; handle: DriverHandle } | null = null;
  private engineStarting: Promise<{ resolution: AuthResolution; handle: DriverHandle }> | null =
    null;
  private readonly resumeOptions = new Map<string, { prompt?: string; mockFixture?: string }>();
  private ticker: NodeJS.Timeout | undefined;
  /** The global kill switch was seen engaged (and what waited was closed). */
  private killSeen = false;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeRuns: (() => void) | undefined;
  /** Post-run summaries run one at a time, after the Run's outcome is final. */
  private summaries: Promise<void> = Promise.resolve();
  /** Every line goes through the redactor. */
  readonly log: Logger;
  private readonly now: () => Date;
  /** The principal of the API request being served (set by the auth middleware). */
  private readonly requestPrincipal = new AsyncLocalStorage<SessionPrincipal>();
  /** Workspaces, containers and the Docker sandbox's host-side proxies (ADR-004, ADR-018). */
  private readonly sandbox: SandboxManager;
  /** Where orbitd's key proxies (host engines and Docker sandboxes) get the key. */
  private readonly keyCredential: EngineCredential;
  /** Set at start when the audit key predates a log without keyed records (doctor shows it). */
  private auditKeyWarning: string | null = null;
  /** When retention last swept memory (ms); orbitd sweeps at start and once a day. */
  private memorySweptAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: ServiceOptions) {
    const { config, env, db } = opts;
    this.config = config;
    this.now = opts.now ?? (() => new Date());
    this.startedAt = this.now().toISOString();
    this.version = opts.version;
    // One redactor for the process: API credentials, vault values, hook and API tokens.
    this.redactor = new Redactor(API_CREDENTIALS.map((name) => env[name] ?? ''));
    // Every log line goes through it (review L1): errors quote git, docker and engine output.
    const sink: Logger =
      opts.log ?? ((level, message) => process.stderr.write(`[orbitd] ${level}: ${message}\n`));
    this.log = (level, message) => sink(level, this.redactor.redactString(message));
    this.store = new EventStore(db, this.redactor);
    this.bots = new BotRepo(db, this.now, this.redactor);
    this.controls = new Controls(db, this.now);
    // The audit key (ADR-007, M8) lives where the vault key does, never in the database.
    const auditKey = loadAuditKey({
      home: config.home,
      ...(opts.vaultKeySource ? { keySource: opts.vaultKeySource } : {}),
    });
    this.audit = new AuditLog(db, this.redactor, this.now, auditKey.key);
    if (auditKey.created && this.audit.status().keyedSince) {
      this.log(
        'error',
        'a new audit key was created but the audit log has keyed records: `orbit audit verify` will report them; restore the original audit key',
      );
    }
    // A key from an earlier log but no keyed record in this one: the database
    // was reset — or replaced by a log written without the key (M8 review L3).
    if (!auditKey.created && !this.audit.status().keyedSince) {
      this.auditKeyWarning =
        'The audit key already existed, but the audit log had no keyed records when orbitd started: the database was reset or replaced. If you did not do that, treat the records before this start as unverified (`orbit audit verify` shows where keyed records begin).';
      this.log('warn', this.auditKeyWarning);
    }
    this.audit.ensureKeyed({ keySource: auditKey.source });
    this.rules = new RuleStore(db, this.now);
    this.approvals = new ApprovalQueue(
      db,
      { audit: this.audit, events: this.store, redactor: this.redactor },
      this.now,
    );
    // Fail closed: a vault that exists but cannot be decrypted stops the daemon.
    this.vault = new SecretVault({
      db,
      home: config.home,
      now: this.now,
      ...(opts.vaultKeySource ? { keySource: opts.vaultKeySource } : {}),
    });
    for (const v of this.vault.values()) this.redactor.addSecret(v);
    this.memory = new MemoryStore(db, {
      redactor: this.redactor,
      dir: opts.memoryDir === undefined ? join(config.home, 'memory') : opts.memoryDir,
      now: this.now,
      maxPerBot: config.memory.maxPerBot,
    });
    this.workspaceTaint = new WorkspaceTaint(db, this.now);
    this.orbitSessions = new OrbitSessions();
    // The plugin sandbox (ADR-019): detected once, on first use (a bwrap probe).
    let sandboxSupport: PluginSandboxSupport | undefined = opts.pluginSandbox;
    const pluginSandbox = () =>
      (sandboxSupport ??= detectPluginSandbox({
        pathEnv: env.PATH ?? '',
        env: buildChildEnv('tool', env),
      }));
    const storeDir = config.plugins.storeDir ?? defaultStoreDir(env);
    this.plugins = new PluginRegistry({
      db,
      vault: this.vault,
      env,
      home: config.home,
      ...(opts.pluginsDir !== undefined ? { builtInDir: opts.pluginsDir } : {}),
      bots: () => this.bots.list(),
      now: this.now,
      redact: (t) => this.redactor.redactString(t),
      audit: this.audit,
      sandbox: { mode: config.plugins.sandbox, support: pluginSandbox },
      storeDir,
    });
    // Installs refuse a store inside $ORBIT_HOME (Bots write there).
    this.pluginInstaller = new PluginInstaller({
      registry: this.plugins,
      storeDir,
      orbitHome: config.home,
      catalogUrl: config.plugins.catalogUrl,
      npmRegistry: config.plugins.npmRegistry,
      now: this.now,
      audit: this.audit,
      ...(opts.pluginFetch ? { fetch: opts.pluginFetch } : {}),
    });
    this.pluginSandboxSupport = pluginSandbox;
    this.pluginSegments = new PluginSegments();
    this.orbitTools = new OrbitToolset({
      memory: this.memory,
      store: this.store,
      delegate: (session, target, task) => this.delegate(session, target, task),
    });
    this.triage = new TriagePath({
      ledger: new TriageLedger(db, this.now),
      engine: async () => {
        const { resolution, handle } = await this.ensureEngine();
        return resolution.driver === 'mock'
          ? mockTriage
          : driverTriage(handle.driver, {
              model: config.models.triage,
              cwd: join(config.home, 'triage'),
            });
      },
      maxCallsPerDay: () => config.triage.maxCallsPerDay,
      hold: () => {
        const kill = this.controls.globalKill();
        if (kill) return `the global kill switch is engaged (by ${kill})`;
        return this.rateLimits.hold();
      },
    });

    // One key source for both key proxies (one apiKeyHelper cache, ADR-018).
    // apiKeyHelper output is redacted like the static key (M8 review L1).
    this.keyCredential = keyProxyCredential(env, config.sdk.apiKeyHelper, (k) =>
      this.redactor.addSecret(k),
    );
    this.sandbox = createSandboxManager(config.home, env, {
      legacyName: (bot) => this.m2WorkspaceName(bot),
      apiKeyHelper: config.sdk.apiKeyHelper,
      credential: this.keyCredential,
      // Refusals name a host:port or an API route, never a query string or a header.
      onProxyRefusal: (botId, proxy, r) =>
        this.log(
          'warn',
          `sandbox ${proxy} proxy refused ${r.target} for Bot ${botId}: ${r.reason}`,
        ),
    });

    this.orchestrator = new Orchestrator({
      config,
      store: this.store,
      bots: this.bots,
      controls: this.controls,
      approvals: this.approvals,
      policy: new PolicyEngine(this.approvals, this.rules),
      driver: {
        kind: 'mock',
        authMethod: 'none',
        run: () => {
          throw new OrbitError('auth_required', 'No engine resolved yet');
        },
      },
      redactor: this.redactor,
      audit: this.audit,
      workspaces: opts.workspaces ?? sandboxWorkspaces(this.sandbox, env),
      ...(opts.killPollMs ? { killPollMs: opts.killPollMs } : {}),
      now: this.now,
      memory: this.memory,
      workspaceTaint: this.workspaceTaint,
      orbitTools: this.orbitTools,
      orbitSessions: this.orbitSessions,
      mcpUrl: () => this.url || null,
      plugins: this.plugins,
      pluginSegments: this.pluginSegments,
    });

    this.rateLimits = new RateLimitManager({
      store: this.store,
      bots: this.bots,
      resume: (run) => this.pushResume(run),
      now: this.now,
    });

    this.queue = new RunQueue({
      concurrency: () => this.concurrency(),
      hold: (job) => this.hold(job),
      execute: (job) => this.execute(job),
      onError: (job, message) => this.log('warn', `${job.kind} ${job.runId}: ${message}`),
      now: this.now,
    });

    const triggerState = new TriggerStateRepo(db);
    this.triggerState = triggerState;
    this.scheduler = new Scheduler({
      bots: () => this.bots.list(),
      state: triggerState,
      fire: (bot, trigger, ref) => this.fireTrigger(bot, trigger, ref),
      inFlight: (runId) => {
        const s = this.store.getRun(runId);
        return s !== undefined && IN_FLIGHT.includes(s.status);
      },
      now: this.now,
    });

    this.triggers = new TriggerRouter({
      bots: () => this.bots.list(),
      fire: (bot, trigger, ref, content) => this.fireInbound(bot, trigger, ref, content),
      slack: {
        appToken: () => this.vault.get(pluginSecretKey('slack', 'SLACK_APP_TOKEN')),
        apiUrl: env.SLACK_API_URL ?? 'https://slack.com/api',
      },
      git: (repo) => gitRunner(repo, buildChildEnv('tool', env)),
      orbitHome: config.home,
      // Until the engine resolves, assume the subscription engine (the strictest).
      slackNeedsUsers: () =>
        (this.engine?.resolution.driver ?? this.config.driver ?? 'cli') === 'cli',
      hasWebhookSecret: (bot, name) => this.vault.has(webhookSecretName(bot.id, name)),
      log: (m) => this.log('info', m),
      ...(opts.slack?.fetch ? { slackFetch: opts.slack.fetch } : {}),
      ...(opts.slack?.connect ? { slackConnect: opts.slack.connect } : {}),
    });
  }

  /**
   * M2 kept workspaces under the Bot's name slug, and M2 could not rename
   * Bots: only Bots created before migration 3 have one, under their first
   * name (review L3).
   */
  private m2WorkspaceName(bot: Bot): string | null {
    const m3 = migrationAppliedAt(this.opts.db.sqlite, 3);
    if (!m3 || bot.createdAt >= m3) return null;
    return this.bots.versions(bot.id)[0]?.spec.name ?? null;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Rebuild the queue and usage-limit state from the log, then start housekeeping. */
  start(): void {
    this.unsubscribe = this.rateLimits.start();
    // Delegation and memory follow the log: a child that ends reports to its
    // parent; a parent that parks may already have all its answers; a Run
    // that completes gets its summary.
    this.unsubscribeRuns = this.store.subscribe((e) => {
      if (e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled') {
        queueMicrotask(() => this.onRunEnded(e.runId, e.type === 'run.completed'));
      } else if (e.type === 'run.parked' && e.data.delegations.length > 0) {
        queueMicrotask(() => this.maybeAutoResume(e.runId));
      }
    });
    // Runs that were executing when the previous daemon died (ADR-016): paused,
    // to be retried below when that is safe, or for the owner; failed as
    // `interrupted` when their Bot says so or a kill switch forbids continuing.
    for (const run of this.store.listRuns({ status: ['running'], limit: 1000 })) {
      this.store.append(
        run.runId,
        run.botId,
        this.orchestrator.interruption(run.runId, { allowResume: this.mayContinue(run) }),
      );
      // Its delegations have nobody to answer to any more (review M6 M1).
      this.orchestrator.stopDescendants(run.runId, 'system');
    }
    // Interrupted Runs judged safe (now, or by a graceful stop) resume through
    // the queue; under a kill switch or a paused Bot nothing continues.
    for (const run of this.store.listRuns({ status: ['paused'], limit: 1000 })) {
      if (run.pause?.reason !== 'interrupted' || !run.pause.autoResume) continue;
      if (this.mayContinue(run)) this.pushResume(run);
      else this.orchestrator.stop(run.runId, 'system');
    }
    for (const run of this.store.listRuns({ status: ['queued'], limit: 1000 }).reverse()) {
      this.queue.push({
        kind: 'start',
        runId: run.runId,
        botId: run.botId,
        priority: run.priority,
      });
    }
    for (const run of this.store.listRuns({ status: ['waiting_approval'], limit: 1000 })) {
      this.maybeAutoResume(run.runId);
    }
    // Children that ended while the daemon was down still report to their parents.
    for (const run of this.store.listRuns({ status: ['delegating'], limit: 1000 })) {
      for (const c of run.children) {
        const child = this.store.getRun(c.runId);
        if (child && ENDED.includes(child.status)) this.reportToParent(child);
      }
      this.maybeAutoResume(run.runId);
    }
    this.rateLimits.recover();
    this.syncTriggers();
    this.sweepMemoryDaily();
    this.ticker = setInterval(() => this.tick(), this.opts.tickMs ?? 1000);
    this.ticker.unref();
  }

  /** Housekeeping: scheduled triggers, approval expiry, usage-limit resumes. */
  tick(): void {
    try {
      // A global kill engaged from another process (the shared controls table)
      // reaches executing Runs through the orchestrator's poll; what waits
      // (queued, parked, rate limited) is closed here, as `setKill` does.
      const kill = this.controls.globalKill();
      if (kill && !this.killSeen) this.closeWaiting();
      this.killSeen = kill !== null;
      for (const r of this.scheduler.tick()) {
        if (!r.outcome.fired) this.log('info', `trigger ${r.key} skipped: ${r.outcome.reason}`);
      }
      for (const runId of new Set(this.approvals.expireDue().map((a) => a.runId))) {
        this.maybeAutoResume(runId);
      }
      this.rateLimits.tick();
      this.queue.pump();
      this.syncTriggers();
      this.sweepMemoryDaily();
    } catch (err) {
      this.log('error', `housekeeping failed: ${errorMessage(err)}`);
    }
  }

  /** Inbound listeners follow the Bots' specs (and the kill switch: nothing listens while it is on). */
  private syncTriggers(): void {
    if (this.controls.globalKill()) {
      void this.triggers.stop();
      return;
    }
    this.triggers.sync();
  }

  /** Graceful stop: no new dispatches, executing Runs close as interruptions (ADR-016). */
  async stop(): Promise<void> {
    clearInterval(this.ticker);
    this.unsubscribe?.();
    this.unsubscribeRuns?.();
    this.queue.freeze();
    await this.triggers.stop();
    this.orchestrator.shutdown();
    await this.orchestrator.drain(15_000);
    await this.engine?.handle.close();
    this.engine = null;
    await this.sandbox.close();
  }

  // ── engine ────────────────────────────────────────────────────────────────

  private resolve(): Promise<AuthResolution> {
    return resolveAuth({
      config: this.config,
      env: this.opts.env,
      probes: this.opts.probes ?? systemProbes(this.config, this.opts.env),
    });
  }

  /** Resolve auth and create the driver once; retried while nothing is configured. */
  async ensureEngine(): Promise<{ resolution: AuthResolution; handle: DriverHandle }> {
    if (this.engine) return this.engine;
    this.engineStarting ??= (async () => {
      const resolution = await this.resolve();
      if (!resolution.driver) {
        throw new OrbitError(
          resolution.refusal?.code ?? 'auth_required',
          resolution.refusal?.message ?? resolution.onboarding?.reason ?? 'No usable credentials',
          {
            hint:
              resolution.refusal?.hint ??
              resolution.onboarding?.steps.join('\n') ??
              'Run `orbit login-help`.',
          },
        );
      }
      const handle = await createDriver(resolution, this.config, this.opts.env, {
        ...(this.opts.queryFn ? { queryFn: this.opts.queryFn } : {}),
        mock: this.opts.mock ?? { delayMs: this.config.driver === 'mock' ? 120 : 0 },
        secrets: this.redactor,
        credential: this.keyCredential,
        // Refusals name an API route, never the segment token, a query string or a header.
        onKeyProxyRefusal: (r) => this.log('warn', `key proxy refused ${r.target}: ${r.reason}`),
      });
      for (const w of resolution.warnings) this.log('warn', w.message);
      this.orchestrator.setDriver(handle.driver);
      this.engine = { resolution, handle };
      this.queue.pump();
      return this.engine;
    })().finally(() => {
      this.engineStarting = null;
    });
    return this.engineStarting;
  }

  private concurrency(): number {
    // Until the engine resolves, assume the strictest limit unless a driver is forced.
    const kind = this.engine?.resolution.driver ?? this.config.driver ?? 'cli';
    return this.config.limits.maxConcurrentRuns[kind];
  }

  private hold(job: QueueJob): string | null {
    const kill = this.controls.globalKill();
    if (kill) return `global kill switch engaged by ${kill}`;
    if (this.bots.find(job.botId)?.pausedAt) {
      const t = this.controls.takeover(job.botId);
      return t ? `Bot is taken over (orbit shell, pid ${t.pid})` : 'Bot is paused';
    }
    return this.rateLimits.hold();
  }

  /** Nothing forbids continuing a Run of this Bot: no kill switch, Bot not paused. */
  private mayContinue(run: RunState): boolean {
    return this.controls.globalKill() === null && !this.bots.find(run.botId)?.pausedAt;
  }

  private async execute(job: QueueJob): Promise<void> {
    try {
      await this.ensureEngine();
    } catch (err) {
      if (job.kind === 'start') this.failQueued(job.runId, err);
      throw err;
    }
    try {
      if (job.kind === 'start') {
        await this.orchestrator.execute(job.runId);
      } else {
        const options = this.resumeOptions.get(job.runId) ?? {};
        this.resumeOptions.delete(job.runId);
        await this.orchestrator.resume(job.runId, options);
      }
    } catch (err) {
      // Review M1: a job that died before its segment ended must not leave the
      // Run looking queued or running (it would also block its trigger forever).
      this.closeOrphan(job.runId, err);
      throw err;
    }
    // A child that ended while this job was still finishing could not queue
    // the parent's resume (the queue holds one job per Run), and nobody else
    // would: look again once the queue has let go of the Run (M8 corpus).
    setImmediate(() => {
      try {
        if (this.store.getRun(job.runId)?.status === 'delegating') this.maybeAutoResume(job.runId);
      } catch (err) {
        this.log('warn', `after ${job.kind} ${job.runId}: ${errorMessage(err)}`);
      }
    });
  }

  /** Fail a Run that claims to be queued or running but executes nowhere. */
  private closeOrphan(runId: string, err: unknown): void {
    if (this.orchestrator.isActive(runId)) return;
    const run = this.store.getRun(runId);
    if (run?.status !== 'queued' && run?.status !== 'running') return;
    try {
      this.store.append(
        runId,
        run.botId,
        [
          event('run.failed', {
            code: err instanceof OrbitError ? err.code : 'internal',
            message: errorMessage(err),
            retryable: true,
            sessionId: run.sessionId,
          }),
        ],
        { expectSeq: run.lastSeq },
      );
      this.approvals.cancelForRun(runId, 'system', 'expired');
    } catch {
      // Someone else closed it first.
    }
  }

  private failQueued(runId: string, err: unknown): void {
    const run = this.store.getRun(runId);
    if (run?.status !== 'queued') return;
    const code = err instanceof OrbitError ? err.code : 'internal';
    try {
      this.store.append(
        runId,
        run.botId,
        [
          event('run.failed', {
            code,
            message: errorMessage(err),
            retryable: true,
            sessionId: null,
          }),
        ],
        { expectSeq: run.lastSeq },
      );
    } catch {
      // Someone else (a stop) closed it first.
    }
  }

  private fixture(fixture: string | undefined): string | undefined {
    if (fixture === undefined) return undefined;
    const driver = this.engine?.resolution.driver ?? this.config.driver;
    if (driver !== 'mock') {
      throw new OrbitError('invalid_input', 'fixture applies only to the mock driver (demo mode)');
    }
    return fixture;
  }

  // ── bots ──────────────────────────────────────────────────────────────────

  // ── principals (ADR-015) ──────────────────────────────────────────────────

  /**
   * The principal the bearer token acts as: the server operator's credential
   * (`daemon.token`, 0600) is always the owner.
   */
  tokenPrincipal(): SessionPrincipal {
    const configured = this.config.principals.find((p) => p.id === OWNER);
    return {
      id: OWNER,
      name: configured?.name ?? (this.config.mode === 'hosted' ? 'Server operator' : 'Local owner'),
      role: 'owner',
    };
  }

  /** Serve one API request as `principal`: audit records and decisions name it. */
  runAs<T>(principal: SessionPrincipal, fn: () => T): T {
    return this.requestPrincipal.run(principal, fn);
  }

  /** Who acts right now: the request's principal, or the local owner outside requests. */
  actor(): string {
    return this.requestPrincipal.getStore()?.id ?? OWNER;
  }

  /** Hosted mode: the public https origin (webhooks, sign-in); null locally. */
  publicUrl(): string | null {
    return this.config.mode === 'hosted' ? this.config.hosted.publicUrl : null;
  }

  private checkSpec(spec: BotSpecInput): void {
    validateTriggers((spec.triggers ?? []) as TriggerSpec[]);
    const parsed = BotSpec.parse(spec);
    // A subagent never gets a tool its Bot does not have.
    if (parsed.tools) {
      for (const [name, a] of Object.entries(parsed.subagents)) {
        const extra = (a.tools ?? []).filter((t) => !parsed.tools?.includes(t));
        if (extra.length > 0) {
          throw new OrbitError(
            'invalid_input',
            `Subagent "${name}" lists tools the Bot does not have: ${extra.join(', ')}`,
          );
        }
      }
    }
    const self = slugify(parsed.name);
    if (parsed.delegation.allowedBots.some((b) => slugify(b) === self)) {
      throw new OrbitError('invalid_input', 'A Bot cannot delegate to itself');
    }
  }

  createBot(spec: BotSpecInput): Bot {
    this.checkSpec(spec);
    const bot = this.bots.create(spec);
    this.audit.append({
      actor: this.actor(),
      action: 'bot.created',
      subject: bot.id,
      data: { spec: bot.spec },
    });
    return bot;
  }

  updateBot(ref: string, spec: BotSpecInput): Bot {
    this.checkSpec(spec);
    const bot = this.bots.update(ref, spec);
    this.audit.append({
      actor: this.actor(),
      action: 'bot.updated',
      subject: bot.id,
      data: { version: bot.version, spec: bot.spec },
    });
    return bot;
  }

  pauseBot(ref: string): Bot {
    const bot = this.orchestrator.pauseBot(ref, this.actor());
    // Paused on purpose during a take-over: it stays paused when the take-over ends.
    const t = this.controls.takeover(bot.id);
    if (t && !t.wasPaused) this.controls.setTakeover({ ...t, wasPaused: true });
    // Nothing of a paused Bot may continue once it is resumed: queued, parked
    // and rate-limited Runs are closed too (review L2).
    this.closeWaiting(bot.id);
    return bot;
  }

  /** Cancel queued, parked, paused and rate-limited Runs (of one Bot, or all). */
  private closeWaiting(botId?: string): void {
    const waiting = this.store.listRuns({
      ...(botId ? { botId } : {}),
      status: ['queued', 'waiting_approval', 'delegating', 'rate_limited', 'paused'],
      limit: 10_000,
    });
    for (const run of waiting) {
      if (this.queue.isActive(run.runId) || this.orchestrator.isActive(run.runId)) continue;
      this.queue.remove(run.runId);
      try {
        this.orchestrator.stop(run.runId, this.actor());
      } catch (err) {
        if (!(err instanceof OrbitError && err.code === 'conflict')) throw err;
      }
    }
  }

  resumeBot(ref: string): Bot {
    // Resuming a Bot is the owner's explicit choice: it also ends a take-over
    // (the way out of one whose CLI died and whose pid was reused).
    const held = this.bots.get(ref);
    const t = this.controls.takeover(held.id);
    if (t) this.finishTakeover(held, t, { stale: !this.alive(t.pid), via: 'bot_resume' });
    const bot = this.orchestrator.resumeBot(ref, this.actor());
    this.queue.pump();
    return bot;
  }

  // ── take-over (`orbit shell`, ADR-016) ────────────────────────────────────

  private alive(pid: number): boolean {
    return (this.opts.processAlive ?? processAlive)(pid);
  }

  /**
   * Hand a Bot's workspace to the owner's shell: no Run of the Bot may be
   * executing or waiting mid-tool-call on an approval, the Bot is held (the
   * Bot-pause hold) while it lasts, and both ends are audited. A take-over
   * whose CLI process is gone is stale and ends when a new one starts.
   */
  async startTakeover(botRef: string, pid: number): Promise<z.infer<typeof TakeoverInfo>> {
    const bot = this.bots.get(botRef);
    const name = slugify(bot.spec.name);
    if (bot.spec.sandbox.kind === 'docker') {
      throw new OrbitError(
        'invalid_input',
        `${bot.spec.name} works in a Docker container; orbit shell opens host workspaces only`,
        {
          hint: `Open a shell in its container: docker exec -it ${SandboxManager.containerName(bot)} sh`,
        },
      );
    }
    const existing = this.controls.takeover(bot.id);
    if (existing && this.alive(existing.pid)) {
      throw new OrbitError(
        'conflict',
        `${bot.spec.name} is already taken over (orbit shell, pid ${existing.pid}, since ${existing.startedAt})`,
        { hint: `Exit that shell first, or end it with \`orbit bot resume ${name}\`.` },
      );
    }
    const runs = this.store.listRuns({
      botId: bot.id,
      status: ['queued', 'running', 'waiting_approval', 'delegating', 'rate_limited', 'paused'],
      limit: 1000,
    });
    const busy = runs.find(
      (r) => r.status === 'running' || (r.status === 'queued' && this.queue.isActive(r.runId)),
    );
    if (busy) {
      throw new OrbitError(
        'conflict',
        `Run ${busy.runId} of ${bot.spec.name} is running; it would work in the same files as you`,
        {
          hint: `Pause it at its next tool call with \`orbit pause ${busy.runId}\` (or stop it with \`orbit stop ${busy.runId}\`), then run orbit shell again.`,
        },
      );
    }
    const parked = runs.find((r) => r.status === 'waiting_approval');
    if (parked) {
      throw new OrbitError(
        'conflict',
        `Run ${parked.runId} of ${bot.spec.name} is parked on an approval mid-tool-call; the call would run against the files you change`,
        {
          hint: `Decide it (\`orbit approvals\`) or stop it with \`orbit stop ${parked.runId}\`, then run orbit shell again.`,
        },
      );
    }
    if (existing) {
      // Stale: its CLI is gone. The hold continues under the new take-over.
      this.audit.append({
        actor: this.actor(),
        action: 'takeover.ended',
        subject: bot.id,
        data: { pid: existing.pid, stale: true, via: 'orbit_shell', released: false },
      });
    }
    const wasPaused = existing ? existing.wasPaused : bot.pausedAt !== null;
    // The Bot-pause hold: no Run of the Bot starts or resumes while it lasts.
    if (!bot.pausedAt) this.bots.setPaused(bot.id, true);
    let workspace: string;
    let git: TakeoverGit | null;
    try {
      const ws = await this.orchestrator.hostWorkspace(bot);
      workspace = ws.path;
      // The workspace's .git must be Orbit's (worktree Bots) or absent
      // (directory Bots) before the owner's git-aware shell opens there.
      git = prepareTakeoverGit({
        kind: bot.spec.sandbox.kind === 'worktree' ? 'worktree' : 'directory',
        workspace,
        repo: ws.git?.repo,
      });
    } catch (err) {
      if (!wasPaused) this.bots.setPaused(bot.id, false);
      if (existing) this.controls.clearTakeover(bot.id);
      this.queue.pump();
      throw err;
    }
    const t: Takeover = {
      botId: bot.id,
      pid,
      startedAt: this.now().toISOString(),
      wasPaused,
      by: this.actor(),
    };
    this.controls.setTakeover(t);
    if (git?.restored) {
      this.audit.append({
        actor: this.actor(),
        action: 'takeover.git_restored',
        subject: bot.id,
        data: { workspace, was: git.restored.was, movedTo: git.restored.movedTo },
      });
    }
    this.audit.append({
      actor: this.actor(),
      action: 'takeover.started',
      subject: bot.id,
      data: { pid, workspace, wasPaused, replacedStale: existing?.pid ?? null },
    });
    return {
      botId: bot.id,
      botName: bot.spec.name,
      workspace,
      git: git
        ? { dir: git.gitDir, workTree: git.workTree, restored: git.restored !== null }
        : null,
      pid,
      startedAt: t.startedAt,
      wasPaused,
      replacedStale: existing?.pid ?? null,
      waiting: runs.map((r) => r.runId),
    };
  }

  /** End the open take-over of a Bot (the CLI's shell exited). */
  endTakeover(botRef: string): Bot {
    const bot = this.bots.get(botRef);
    const t = this.controls.takeover(bot.id);
    if (!t) throw new OrbitError('not_found', `No take-over of ${bot.spec.name} is open`);
    this.finishTakeover(bot, t, { stale: false, via: 'orbit_shell' });
    return this.bots.get(bot.id);
  }

  private finishTakeover(
    bot: Bot,
    t: Takeover,
    how: { stale: boolean; via: 'orbit_shell' | 'bot_resume' },
  ): void {
    this.controls.clearTakeover(bot.id);
    if (!t.wasPaused) this.bots.setPaused(bot.id, false);
    this.audit.append({
      actor: this.actor(),
      action: 'takeover.ended',
      subject: bot.id,
      data: { pid: t.pid, stale: how.stale, via: how.via, released: !t.wasPaused },
    });
    this.queue.pump();
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  async startRun(
    ref: string,
    body: {
      prompt?: string | undefined;
      fixture?: string | undefined;
      priority?: number | undefined;
    },
  ): Promise<RunState> {
    const bot = this.bots.get(ref);
    const t = this.controls.takeover(bot.id);
    if (t) {
      throw new OrbitError(
        'blocked',
        `${bot.spec.name} is taken over (orbit shell, pid ${t.pid}): no Run starts until that shell exits`,
        {
          hint: `Exit the shell, or end the take-over with \`orbit bot resume ${slugify(bot.spec.name)}\`.`,
        },
      );
    }
    // Fail fast with the onboarding / compliance message instead of queueing a doomed Run.
    await this.ensureEngine();
    const mockFixture = this.fixture(body.fixture);
    const run = this.orchestrator.enqueue(bot, {
      ...(body.prompt ? { prompt: body.prompt } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(mockFixture ? { mockFixture } : {}),
    });
    this.queue.push({ kind: 'start', runId: run.runId, botId: bot.id, priority: run.priority });
    return this.requireRun(run.runId);
  }

  private fireTrigger(bot: Bot, trigger: TriggerSpec, ref: TriggerRef) {
    const run = this.orchestrator.enqueue(bot, {
      trigger: ref,
      ...(trigger.prompt ? { prompt: trigger.prompt } : {}),
    });
    this.queue.push({ kind: 'start', runId: run.runId, botId: bot.id, priority: run.priority });
    return { fired: true as const, runId: run.runId };
  }

  /**
   * An inbound trigger delivered something (ADR-014): start a Run whose task
   * carries it as untrusted data, tainted from the start. Never while the
   * trigger's previous Run is still in flight.
   */
  fireInbound(
    bot: Bot,
    trigger: TriggerSpec,
    ref: TriggerRef,
    content: InboundContent,
  ): { fired: true; runId: string } | { fired: false; reason: string } {
    const key = triggerKey(bot.id, trigger);
    const previous = this.triggerState.get(key);
    if (bot.pausedAt) return { fired: false, reason: 'Bot is paused' };
    const kill = this.controls.globalKill();
    if (kill) return { fired: false, reason: `the global kill switch is engaged (by ${kill})` };
    if (previous?.lastRunId) {
      const prev = this.store.getRun(previous.lastRunId);
      if (prev && IN_FLIGHT.includes(prev.status)) {
        return { fired: false, reason: `previous run ${previous.lastRunId} still in flight` };
      }
    }
    const task = trigger.prompt ?? bot.spec.goal;
    const run = this.orchestrator.enqueue(bot, {
      trigger: ref,
      prompt: triggerPrompt(
        content.context ? `${task}\n\n${content.context}` : task,
        content.source,
        content.text,
      ),
      inheritedTaint: [content.source],
    });
    this.triggerState.record({
      key,
      botId: bot.id,
      lastFiredAt: this.now().toISOString(),
      lastRunId: run.runId,
    });
    this.audit.append({
      actor: `trigger:${trigger.kind}`,
      action: 'trigger.fired',
      subject: run.runId,
      data: { botId: bot.id, kind: trigger.kind, source: content.source },
    });
    this.queue.push({ kind: 'start', runId: run.runId, botId: bot.id, priority: run.priority });
    return { fired: true, runId: run.runId };
  }

  /** Inbound triggers; in hosted mode webhooks show the public address senders use. */
  inboundTriggers(): (InboundStatus & { url: string | null })[] {
    const base = this.publicUrl();
    return this.triggers
      .status()
      .map((t) => ({ ...t, url: base !== null && t.path !== null ? base + t.path : null }));
  }

  /**
   * A webhook delivery (`POST /hooks/<bot>/<trigger>`). The signature is
   * verified in constant time before the body is parsed or anything is
   * stored; every failure is the same 401 (no hint whether the Bot or trigger
   * exists).
   */
  receiveWebhook(
    botId: string,
    name: string,
    headers: Readonly<Record<string, string | undefined>>,
    body: Buffer,
  ): { accepted: true; runId: string | null } {
    const refused = () => new OrbitError('unauthorized', 'Invalid webhook signature');
    const bot = /^bot_[0-9A-Za-z]+$/.test(botId) ? this.bots.find(botId) : undefined;
    const trigger = bot?.spec.triggers.find(
      (t): t is Extract<TriggerSpec, { kind: 'webhook' }> =>
        t.kind === 'webhook' && t.name === name,
    );
    const secret = bot && trigger ? this.vault.get(webhookSecretName(bot.id, name)) : undefined;
    if (!bot || !trigger || !secret) {
      // Same work as a real check, so timing does not tell which part is unknown (review L7).
      signGithubWebhook(randomBytes(32).toString('hex'), body.subarray(0, MAX_WEBHOOK_BYTES));
      throw refused();
    }
    const verdict = verifyWebhook({
      style: trigger.style,
      secret,
      headers,
      body,
      nowMs: this.now().getTime(),
      // Keyed per Bot and trigger: the same body sent to two hooks is two deliveries.
      seen: (key) => {
        const r = this.opts.db.sqlite
          .prepare(
            'INSERT OR IGNORE INTO webhook_deliveries (key, bot_id, received_at) VALUES (?, ?, ?)',
          )
          .run(`${key}@${bot.id}/${name}`, bot.id, this.now().toISOString());
        return r.changes === 0;
      },
    });
    if (!verdict.ok) throw refused();
    // Verified: only now is the body read as text (and only as data).
    const nowMs = this.now().getTime();
    this.opts.db.sqlite
      .prepare(
        "DELETE FROM webhook_deliveries WHERE (received_at < ? AND key NOT LIKE 'ghbody:%') OR (key LIKE 'orbit:%' AND received_at < ?)",
      )
      .run(
        new Date(nowMs - WEBHOOK_KEEP_MS.github).toISOString(),
        new Date(nowMs - WEBHOOK_KEEP_MS.orbit).toISOString(),
      );
    if (!trigger.enabled) return { accepted: true, runId: null };
    if (trigger.style === 'github' && trigger.events.length > 0) {
      if (!verdict.event || !trigger.events.includes(verdict.event)) {
        return { accepted: true, runId: null };
      }
    }
    let text = body.toString('utf8');
    try {
      text = JSON.stringify(JSON.parse(text) as unknown, null, 1);
    } catch {
      // Not JSON: passed on as text.
    }
    const outcome = this.fireInbound(
      bot,
      trigger,
      { kind: 'webhook', source: trigger.name },
      {
        source: `webhook:${trigger.name}`,
        text: verdict.event ? `GitHub event: ${verdict.event}\n${text}` : text,
      },
    );
    if (!outcome.fired)
      this.log('info', `webhook ${name} of ${bot.spec.name} skipped: ${outcome.reason}`);
    return { accepted: true, runId: outcome.fired ? outcome.runId : null };
  }

  /** Mint (or rotate) a webhook trigger's signing secret; returned once. */
  webhookSecret(botRef: string, name: string) {
    const bot = this.bots.get(botRef);
    const trigger = bot.spec.triggers.find(
      (t): t is Extract<TriggerSpec, { kind: 'webhook' }> =>
        t.kind === 'webhook' && t.name === name,
    );
    if (!trigger) {
      throw new OrbitError('not_found', `${bot.spec.name} has no webhook trigger named "${name}"`, {
        hint: 'Add one to the Bot first: {"kind": "webhook", "name": "…"}',
      });
    }
    const secret = randomBytes(32).toString('base64url');
    this.vault.set(webhookSecretName(bot.id, name), secret);
    this.redactor.addSecret(secret);
    this.audit.append({
      actor: this.actor(),
      action: 'webhook.secret_set',
      subject: bot.id,
      data: { trigger: name },
    });
    const path = `/hooks/${bot.id}/${name}`;
    const base = this.publicUrl();
    return {
      secret,
      path,
      url: base === null ? null : base + path,
      style: trigger.style,
      headers:
        trigger.style === 'github'
          ? ['X-Hub-Signature-256', 'X-GitHub-Delivery', 'X-GitHub-Event']
          : ['X-Orbit-Timestamp', 'X-Orbit-Signature'],
    };
  }

  // ── plugins (owner actions) ───────────────────────────────────────────────

  listPlugins(): PluginStatus[] {
    return this.plugins.list();
  }

  setPluginSecret(id: string, name: string, value: string): PluginStatus {
    this.plugins.setSecret(id, name, value, this.actor());
    this.redactor.addSecret(value);
    if (id === 'slack') this.triggers.restartSlack();
    return this.plugins.get(id);
  }

  removePluginSecret(id: string, name: string): PluginStatus {
    this.plugins.removeSecret(id, name, this.actor());
    if (id === 'slack') this.triggers.restartSlack();
    return this.plugins.get(id);
  }

  /** Install from the catalog or npm (ADR-019): verified, stored, off until enabled. */
  installPlugin(
    req: PluginInstallRequest,
    dryRun: boolean,
  ): Promise<{ preview: PluginInstallPreview; plugin: PluginStatus | null }> {
    return this.pluginInstaller.install(req, this.actor(), { dryRun });
  }

  requireRun(runId: string): RunState {
    const run = this.store.getRun(runId);
    if (!run) throw new OrbitError('not_found', `Run ${runId} not found`);
    return run;
  }

  async resumeRun(
    runId: string,
    body: { prompt?: string | undefined; fixture?: string | undefined },
  ): Promise<RunState> {
    const run = this.requireRun(runId);
    if (run.status === 'delegating') {
      throw new OrbitError(
        'invalid_input',
        `Run ${runId} waits for the Bots it delegated to; it resumes when they answer`,
      );
    }
    if (
      run.status !== 'waiting_approval' &&
      run.status !== 'rate_limited' &&
      run.status !== 'paused'
    ) {
      throw new OrbitError(
        run.status === 'running' || run.status === 'queued' ? 'conflict' : 'invalid_input',
        `Run ${runId} is ${run.status}; only parked, paused or rate-limited runs can resume`,
      );
    }
    if (run.pendingApprovals.length > 0) {
      throw new OrbitError(
        'invalid_input',
        `Run ${runId} still waits on ${run.pendingApprovals.join(', ')}`,
        { hint: 'Decide them first: orbit approvals' },
      );
    }
    await this.ensureEngine();
    const mockFixture = this.fixture(body.fixture);
    this.pushResume(run, {
      ...(body.prompt ? { prompt: body.prompt } : {}),
      ...(mockFixture ? { mockFixture } : {}),
    });
    return this.requireRun(runId);
  }

  private pushResume(
    run: RunState,
    options: { prompt?: string; mockFixture?: string } = {},
  ): boolean {
    if (this.queue.has(run.runId)) return false;
    if (Object.keys(options).length > 0) this.resumeOptions.set(run.runId, options);
    return this.queue.push({
      kind: 'resume',
      runId: run.runId,
      botId: run.botId,
      priority: run.priority,
    });
  }

  /**
   * Resume a parked Run whose approvals are all decided (if its Bot
   * auto-resumes) or whose delegated Runs have all answered (always).
   */
  private maybeAutoResume(runId: string, force?: boolean, fixture?: string): boolean {
    const run = this.store.getRun(runId);
    if (!run || run.pendingApprovals.length > 0 || run.pendingDelegations.length > 0) return false;
    // Under a kill switch nothing is lined up to continue after the release.
    if (this.controls.globalKill() || this.bots.find(run.botId)?.pausedAt) return false;
    if (run.status === 'delegating') return this.pushResume(run);
    if (run.status !== 'waiting_approval') return false;
    const bot = this.bots.find(run.botId);
    if (!(force ?? bot?.spec.approvals.autoResume ?? false)) return false;
    return this.pushResume(run, fixture ? { mockFixture: fixture } : {});
  }

  // ── delegation ────────────────────────────────────────────────────────────

  /** `delegate_to_bot`: start a child Run of a peer Bot the parent may delegate to. */
  private delegate(
    session: OrbitRunSession,
    target: string,
    task: string,
  ): { childRunId: string; botName: string } {
    const parent = this.requireRun(session.runId);
    const parentBot = this.bots.get(session.botId);
    const child = this.bots.find(target) ?? this.bots.find(slugify(target));
    const allowed = parentBot.spec.delegation.allowedBots;
    if (!child) {
      throw new OrbitError(
        'not_found',
        `No Bot named "${target}". You may delegate to: ${allowed.join(', ')}`,
      );
    }
    const permitted = allowed.some(
      (a) => a === child.id || slugify(a) === slugify(child.spec.name),
    );
    if (!permitted || child.id === parentBot.id) {
      throw new OrbitError(
        'forbidden',
        `Your owner has not allowed delegating to "${child.spec.name}". You may delegate to: ${allowed.join(', ') || 'nobody'}`,
      );
    }
    // No cycles: a Bot already in the chain above cannot be asked again.
    for (let id: string | null = parent.runId, i = 0; id && i < 10; i++) {
      const r = this.store.getRun(id);
      if (!r) break;
      if (r.botId === child.id) {
        throw new OrbitError('forbidden', `"${child.spec.name}" is already working on this chain`);
      }
      id = r.parentRunId;
    }
    const depth = parent.depth + 1;
    if (depth > this.config.delegation.maxDepth) {
      throw new OrbitError(
        'blocked',
        `Delegation depth limit reached (${this.config.delegation.maxDepth})`,
      );
    }
    if (parent.children.length >= parentBot.spec.delegation.maxChildrenPerRun) {
      throw new OrbitError(
        'blocked',
        `This Run already delegated ${parent.children.length} tasks (limit ${parentBot.spec.delegation.maxChildrenPerRun})`,
      );
    }
    // The parent Bot's daily budgets count its delegations too (M6 review L5).
    const daily = this.orchestrator.checkDailyBudgets(parentBot, true, 1);
    if (daily) {
      throw new OrbitError(
        'blocked',
        `${parentBot.spec.name}'s daily ${daily.budget === 'runsPerDay' ? 'Run' : 'cost'} budget does not allow another delegation (${daily.actual} of ${daily.limit})`,
      );
    }
    // Unfinished children keep their whole ceiling reserved (review M6 H1).
    const reserved = parent.children
      .filter((c) => c.status === 'running')
      .flatMap((c) => this.store.getRun(c.runId)?.budgetCap ?? []);
    const cap = childBudget(remainingBudget(parentBot, parent, reserved));
    if (cap.toolCalls < 1 || cap.tokens === 0 || cap.costUsd === 0 || cap.wallClockMinutes <= 0) {
      throw new OrbitError('blocked', 'Not enough budget left in this Run to delegate');
    }
    // The child is enqueued with this Run's taint and what is left of its budget.
    const run = this.orchestrator.enqueue(child, {
      prompt: task,
      trigger: { kind: 'delegation', source: parent.runId },
      priority: parent.priority + 1,
      parentRunId: parent.runId,
      depth,
      inheritedTaint: [...session.taint()],
      budgetCap: cap,
    });
    this.store.append(parent.runId, parent.botId, [
      event('delegation.started', {
        childRunId: run.runId,
        childBotId: child.id,
        childBotName: child.spec.name,
        task,
      }),
    ]);
    this.audit.append({
      actor: `bot:${parentBot.id}`,
      action: 'delegation.started',
      subject: parent.runId,
      data: { childRunId: run.runId, childBotId: child.id, depth, budgetCap: cap },
    });
    this.queue.push({ kind: 'start', runId: run.runId, botId: child.id, priority: run.priority });
    return { childRunId: run.runId, botName: child.spec.name };
  }

  /** A child Run ended: record its answer and spend on the parent (once) and taint the parent. */
  private reportToParent(child: RunState): void {
    if (!child.parentRunId) return;
    const parent = this.store.getRun(child.parentRunId);
    const entry = parent?.children.find((c) => c.runId === child.runId);
    if (!parent || entry?.status !== 'running') return;
    const status = child.status as 'completed' | 'failed' | 'cancelled';
    const result =
      status === 'completed'
        ? (child.resultText ?? '')
        : `(${status}) ${child.error?.message ?? 'stopped before it finished'}`;
    const source = `delegate:${entry.botName}`;
    this.store.append(parent.runId, parent.botId, [
      event('delegation.finished', {
        childRunId: child.runId,
        childBotId: child.botId,
        status,
        result: result.slice(0, 8000),
        totals: {
          tokens: child.totals.tokens + child.delegated.tokens,
          costUsd: child.totals.costUsd + child.delegated.costUsd,
          toolCalls: child.counts.toolCalls + child.delegated.toolCalls,
        },
      }),
      // Delegated output is untrusted for the parent, whatever the child did.
      ...(parent.taintSources.includes(source)
        ? []
        : [event('run.tainted', { source, toolUseId: null })]),
    ]);
    if (!parent.taintSources.includes(source)) {
      this.audit.append({
        actor: `bot:${parent.botId}`,
        action: 'run.tainted',
        subject: parent.runId,
        data: { sources: [source], childRunId: child.runId },
      });
    }
    this.maybeAutoResume(parent.runId);
  }

  private onRunEnded(runId: string, completed: boolean): void {
    try {
      const run = this.store.getRun(runId);
      if (!run || !ENDED.includes(run.status)) return;
      this.reportToParent(run);
      if (completed) this.queueSummary(run.runId);
    } catch (err) {
      this.log('warn', `after run ${runId}: ${errorMessage(err)}`);
    }
  }

  /** The delegation tree a Run belongs to: from its top-level ancestor down. */
  runTree(runId: string): { root: string; runs: RunState[] } {
    let top = this.requireRun(runId);
    for (let i = 0; top.parentRunId && i < 10; i++) {
      const p = this.store.getRun(top.parentRunId);
      if (!p) break;
      top = p;
    }
    const runs: RunState[] = [];
    const walk = (r: RunState, depth: number) => {
      runs.push(r);
      if (depth > 10) return;
      for (const c of r.children) {
        const child = this.store.getRun(c.runId);
        if (child) walk(child, depth + 1);
      }
    };
    walk(top, 0);
    return { root: top.runId, runs };
  }

  // ── memory and feedback ───────────────────────────────────────────────────

  listMemory(
    botRef: string | undefined,
    q: {
      query?: string | undefined;
      kind?: Memory['kind'] | undefined;
      limit?: number | undefined;
    },
  ) {
    return this.memory.list({
      ...(botRef ? { botId: this.bots.get(botRef).id } : {}),
      ...(q.query ? { query: q.query } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      limit: q.limit ?? 200,
    });
  }

  createMemory(
    botRef: string,
    body: { title: string; body: string; kind: 'note' | 'fact'; pinned: boolean },
  ): Memory {
    const bot = this.bots.get(botRef);
    const m = this.memory.create({
      botId: bot.id,
      kind: body.kind,
      source: 'owner',
      title: body.title,
      body: body.body,
      pinned: body.pinned,
      createdBy: this.actor(),
    });
    // Audit ids and kinds only: memory text must be deletable, the audit log is not.
    this.audit.append({
      actor: this.actor(),
      action: 'memory.created',
      subject: m.id,
      data: { botId: bot.id, kind: m.kind, pinned: m.pinned },
    });
    return m;
  }

  updateMemory(
    id: string,
    patch: {
      title?: string | undefined;
      body?: string | undefined;
      pinned?: boolean | undefined;
      trusted?: true | undefined;
    },
  ): Memory {
    const before = this.memory.get(id);
    const m = this.memory.update(id, patch);
    this.audit.append({
      actor: this.actor(),
      action: patch.trusted && before.taint.length > 0 ? 'memory.trusted' : 'memory.updated',
      subject: m.id,
      data: {
        botId: m.botId,
        fields: Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined),
        ...(patch.trusted && before.taint.length > 0 ? { clearedTaint: before.taint } : {}),
      },
    });
    return m;
  }

  deleteMemory(id: string): void {
    const m = this.memory.delete(id);
    this.audit.append({
      actor: this.actor(),
      action: 'memory.deleted',
      subject: m.id,
      data: { botId: m.botId, kind: m.kind, source: m.source },
    });
  }

  /**
   * A Bot's memories (or every Bot's) as JSON Lines with provenance: a
   * versioned header line, then one memory per line. Audited (count only).
   */
  exportMemory(botRef: string | undefined): string {
    const bot = botRef ? this.bots.get(botRef) : undefined;
    const bots = bot ? [bot] : this.bots.list();
    const lines = [...this.memory.each(bot?.id)].map(memoryExportLine);
    this.audit.append({
      actor: this.actor(),
      action: 'memory.exported',
      subject: bot?.id ?? null,
      data: { count: lines.length },
    });
    const header = memoryExportHeader(
      bots.map((b) => ({ id: b.id, name: b.spec.name })),
      lines.length,
      this.now(),
    );
    return `${[header, ...lines].join('\n')}\n`;
  }

  /**
   * Import an export into a Bot (owner only, ADR-012 M8). Every line is
   * validated; nothing is written unless all are valid. Provenance is kept:
   * an untrusted memory stays untrusted, `untrusted` marks every one
   * untrusted, and a trusted line (even one claiming `source: owner`) is
   * accepted as trusted only because the owner chose to import the file.
   * The audit log records counts and ids, never memory text.
   */
  importMemory(
    botRef: string,
    body: { jsonl: string; untrusted: boolean; dryRun: boolean },
  ): MemoryImportResult {
    const bot = this.bots.get(botRef);
    const parsed = parseMemoryImport(body.jsonl, this.now());
    const items = parsed.memories;
    const trusted = body.untrusted ? [] : items.filter((m) => m.taint.length === 0);
    const bySource: MemoryImportResult['bySource'] = {
      owner: 0,
      bot: 0,
      summarizer: 0,
      feedback: 0,
    };
    for (const m of items) bySource[m.source] += 1;
    const plan = this.memory.importPlan(bot.id, items.length);
    const result: MemoryImportResult = {
      dryRun: body.dryRun,
      botId: bot.id,
      total: items.length,
      trusted: trusted.length,
      untrusted: items.length - trusted.length,
      claimsOwner: trusted.filter((m) => m.source === 'owner').length,
      bySource,
      pinned: trusted.filter((m) => m.pinned).length,
      evicts: plan.evicts,
      imported: [],
      errors: parsed.errors,
    };
    if (body.dryRun) return result;
    if (parsed.errors.length > 0) {
      const [first] = parsed.errors;
      throw new OrbitError(
        'invalid_input',
        `The import has invalid lines: line ${first?.line}: ${first?.message}${parsed.errors.length > 1 ? ` (and ${parsed.errors.length - 1} more)` : ''}`,
        { hint: 'Nothing was imported. Preview it (dry run) to see every problem.' },
      );
    }
    if (items.length === 0) {
      throw new OrbitError('invalid_input', 'The file holds no memories');
    }
    const { imported, evicted } = this.memory.importMany(bot.id, items, {
      createdBy: this.actor(),
      ...(body.untrusted ? { forceTaint: 'import' } : {}),
    });
    this.audit.append({
      actor: this.actor(),
      action: 'memory.imported',
      subject: bot.id,
      data: {
        count: imported.length,
        trusted: result.trusted,
        untrusted: result.untrusted,
        forcedUntrusted: body.untrusted,
        ids: imported.map((m) => m.id),
        ...(evicted.length > 0 ? { evicted: evicted.map((m) => m.id) } : {}),
      },
    });
    return { ...result, imported: imported.map((m) => m.id), evicts: evicted.length };
  }

  /**
   * Retention (ADR-012 M8): delete unpinned Bot notes and run summaries older
   * than the Bot's `memory.retentionDays` (else the daemon's), and trim every
   * Bot to `memory.maxPerBot`. Owner facts, feedback and pinned memories are
   * never expired. Audited per Bot (ids only).
   */
  sweepMemory(actor: string): MemorySweepResult {
    const now = this.now();
    this.memorySweptAt = now.getTime();
    const out: MemorySweepResult = {
      expired: 0,
      trimmed: 0,
      bots: [],
      maxPerBot: this.memory.maxPerBot,
      retentionDays: this.config.memory.retentionDays,
    };
    const known = new Map(this.bots.list().map((b) => [b.id, b]));
    for (const botId of this.memory.botIds()) {
      const bot = known.get(botId);
      const own = bot?.spec.memory.retentionDays;
      const days = own === undefined ? this.config.memory.retentionDays : own;
      const expired =
        days === null
          ? []
          : this.memory.expire(botId, new Date(now.getTime() - days * DAY_MS).toISOString());
      const trimmed = this.memory.trim(botId);
      if (expired.length === 0 && trimmed.length === 0) continue;
      out.expired += expired.length;
      out.trimmed += trimmed.length;
      out.bots.push({ botId, expired: expired.length, trimmed: trimmed.length });
      this.audit.append({
        actor,
        action: 'memory.expired',
        subject: botId,
        data: {
          retentionDays: days,
          maxPerBot: this.memory.maxPerBot,
          ...(expired.length > 0 ? { expired: expired.map((m) => m.id) } : {}),
          ...(trimmed.length > 0 ? { trimmed: trimmed.map((m) => m.id) } : {}),
        },
      });
    }
    return out;
  }

  private sweepMemoryDaily(): void {
    if (this.now().getTime() - this.memorySweptAt < DAY_MS) return;
    try {
      this.sweepMemory('system');
    } catch (err) {
      this.log('error', `memory retention sweep failed: ${errorMessage(err)}`);
    }
  }

  /** Thumbs up/down on a finished Run: a feedback memory future Runs may see. */
  feedback(runId: string, body: { rating: 'up' | 'down'; comment?: string | undefined }): Memory {
    const run = this.requireRun(runId);
    if (!ENDED.includes(run.status)) {
      throw new OrbitError('invalid_input', `Run ${runId} is ${run.status}; rate it when it ends`);
    }
    const comment = body.comment?.trim() ?? '';
    const text = thumbsFeedback(run, body.rating, comment === '' ? null : comment);
    const signal = body.rating === 'up' ? 'thumbs_up' : 'thumbs_down';
    const m = this.memory.create({
      botId: run.botId,
      kind: 'feedback',
      source: 'feedback',
      ...text,
      runId,
      signal,
      createdBy: this.actor(),
    });
    this.store.append(runId, run.botId, [
      event('feedback.recorded', { signal, memoryId: m.id, approvalId: null, by: this.actor() }),
    ]);
    this.audit.append({
      actor: this.actor(),
      action: 'feedback.recorded',
      subject: runId,
      data: { signal, memoryId: m.id },
    });
    return m;
  }

  /** Approvals, edits and denials become feedback memories (composed by Orbit). */
  private recordDecisionFeedback(approval: Approval, always: boolean): void {
    if (approval.status !== 'approved' && approval.status !== 'denied') return;
    try {
      const run = this.store.getRun(approval.runId);
      const text = approvalFeedback({
        toolName: approval.toolName,
        run: run ? runLabel(run) : 'a Run',
        status: approval.status,
        reason: approval.decision?.reason ?? null,
        input: approval.input,
        editedInput: approval.decision?.editedInput ?? null,
        always,
      });
      const m = this.memory.create({
        botId: approval.botId,
        kind: 'feedback',
        source: 'feedback',
        title: text.title,
        body: text.body,
        runId: approval.runId,
        approvalId: approval.id,
        signal: text.signal,
        // Edited values may still carry text the model wrote in a tainted Run (review M6 L2).
        taint:
          text.signal === 'edited' ? (this.store.getRun(approval.runId)?.taintSources ?? []) : [],
        createdBy: this.actor(),
      });
      this.store.append(approval.runId, approval.botId, [
        event('feedback.recorded', {
          signal: text.signal,
          memoryId: m.id,
          approvalId: approval.id,
          by: this.actor(),
        }),
      ]);
    } catch (err) {
      this.log('warn', `feedback for ${approval.id}: ${errorMessage(err)}`);
    }
  }

  taintedFiles(botRef: string): TaintedPath[] {
    return this.workspaceTaint.list(this.bots.get(botRef).id);
  }

  clearTaintedFiles(botRef: string): number {
    const bot = this.bots.get(botRef);
    const n = this.workspaceTaint.clearAll(bot.id);
    this.audit.append({
      actor: this.actor(),
      action: 'workspace.taint_cleared',
      subject: bot.id,
      data: { files: n },
    });
    return n;
  }

  // ── triage path: summaries and proposals ──────────────────────────────────

  triageUsage(): TriageUsage {
    return this.triage.usage();
  }

  private queueSummary(runId: string): void {
    this.summaries = this.summaries
      .then(() => this.summarize(runId))
      .catch((err: unknown) => {
        this.log('warn', `summary of ${runId}: ${errorMessage(err)}`);
      });
  }

  /** Wait for queued summaries (tests, graceful stop). */
  async summariesIdle(): Promise<void> {
    await this.summaries;
  }

  private async summarize(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    const bot = run ? this.bots.find(run.botId) : undefined;
    if (run?.status !== 'completed' || !bot) return;
    const mode = bot.spec.memory.summarize;
    if (mode === 'off') return;
    if (this.memory.forRun(runId).some((m) => m.kind === 'summary')) return;
    const base = {
      botId: bot.id,
      kind: 'summary' as const,
      source: 'summarizer' as const,
      runId,
      // A summary of a tainted Run is as untrusted as the Run.
      taint: run.taintSources,
      createdBy: 'orbit',
    };
    if (mode === 'result') {
      if (!run.resultText?.trim()) return;
      const m = this.memory.create({ ...base, ...resultSummary(run) });
      this.store.append(runId, run.botId, [
        event('memory.written', {
          memoryId: m.id,
          kind: m.kind,
          source: m.source,

          tainted: m.taint.length > 0,
        }),
        event('memory.summarized', {
          memoryId: m.id,
          mode: 'result',
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          error: null,
        }),
      ]);
      return;
    }
    try {
      const r = await this.triage.call({
        purpose: 'summary',
        botId: bot.id,
        runId,
        system: SUMMARY_SYSTEM,
        prompt: summaryPrompt(runTranscript(run, this.store.listRunEvents(runId))),
      });
      const parsed = parseSummary(r.text) ?? resultSummary(run);
      const m = this.memory.create({ ...base, ...parsed });
      this.store.append(runId, run.botId, [
        event('memory.written', {
          memoryId: m.id,
          kind: m.kind,
          source: m.source,

          tainted: m.taint.length > 0,
        }),
        event('memory.summarized', {
          memoryId: m.id,
          mode: 'triage',
          model: r.model,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costUsd: r.costUsd,
          error: null,
        }),
      ]);
    } catch (err) {
      this.store.append(runId, run.botId, [
        event('memory.summarized', {
          memoryId: null,
          mode: 'triage',
          model: this.config.models.triage,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          error: errorMessage(err).slice(0, 500),
        }),
      ]);
    }
  }

  /** The Create Bot wizard's "Ask Claude": one metered triage call; the owner reviews the result. */
  async proposeBot(goal: string): Promise<{
    proposal: BotProposal;
    usage: TriageUsage;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }> {
    const r = await this.triage.call({
      purpose: 'bot_proposal',
      botId: null,
      runId: null,
      system: PROPOSAL_SYSTEM,
      prompt: proposalPrompt(goal),
    });
    const proposal = parseProposal(r.text);
    if (!proposal) {
      throw new OrbitError('engine_error', 'Claude did not return a usable proposal', {
        hint: 'Try again, or fill in the wizard yourself.',
      });
    }
    return {
      proposal,
      usage: this.triage.usage(),
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
    };
  }

  private cancelWaiting(runId: string): void {
    this.queue.remove(runId);
    try {
      this.orchestrator.cancelQueued(runId, this.actor());
    } catch (err) {
      if (!(err instanceof OrbitError && err.code === 'conflict')) throw err;
    }
  }

  /** Pause a running Run at its next tool call, or now (ADR-016). */
  pauseRun(runId: string, body: { now?: boolean | undefined }): RunState {
    this.requireRun(runId);
    return this.orchestrator.pause(runId, this.actor(), { now: body.now === true });
  }

  stopRun(runId: string): RunState {
    this.requireRun(runId);
    this.queue.remove(runId);
    // orbitd is the single writer: a `running` Run that no job executes is an
    // orphan and is closed now instead of waiting for a poll that never comes.
    const orphaned = !this.queue.isActive(runId) && !this.orchestrator.isActive(runId);
    this.orchestrator.stop(runId, this.actor(), { orphaned });
    return this.requireRun(runId);
  }

  queueSnapshot(): z.infer<typeof QueueSnapshot> {
    return { ...this.queue.snapshot(), pausedUntil: this.rateLimits.pausedUntilIso() };
  }

  schedules(botRef?: string): ScheduleEntry[] {
    return this.scheduler.upcoming(botRef ? this.bots.get(botRef).id : undefined);
  }

  // ── approvals ─────────────────────────────────────────────────────────────

  private decided(
    approval: Approval,
    resume: boolean | undefined,
    fixture: string | undefined,
  ): z.infer<typeof DecisionResult> {
    const mockFixture = this.fixture(fixture);
    const resumed = this.maybeAutoResume(approval.runId, resume, mockFixture);
    return { approval, resumed, run: this.store.getRun(approval.runId) ?? null };
  }

  approve(id: string, body: z.output<typeof ApproveBody>): z.infer<typeof DecisionResult> {
    // Cards show (and edits start from) the redacted input: approving an edit
    // that still holds a marker would run the tool with the marker instead of
    // the value (review M5 LOW-4). Say so instead of doing something surprising.
    if (body.editedInput && /\[REDACTED:[^\]]*\]/.test(JSON.stringify(body.editedInput))) {
      throw new OrbitError(
        'invalid_input',
        'The edited arguments still contain a [REDACTED:…] placeholder',
        { hint: 'Replace the placeholder with the real value, or approve without editing.' },
      );
    }
    const approval = this.approvals.decide(id, {
      approve: true,
      by: this.actor(),
      editedInput: body.editedInput ?? null,
      always: body.always ?? null,
    });
    this.recordDecisionFeedback(approval, Boolean(body.always));
    return this.decided(approval, body.resume, body.fixture);
  }

  deny(id: string, body: z.output<typeof DenyBody>): z.infer<typeof DecisionResult> {
    const approval = this.approvals.decide(id, {
      approve: false,
      by: this.actor(),
      reason: body.reason ?? null,
    });
    this.recordDecisionFeedback(approval, false);
    return this.decided(approval, body.resume, body.fixture);
  }

  // ── policy, audit, secrets, kill switch ──────────────────────────────────

  createRule(body: z.output<typeof CreateRuleBody>): Rule {
    // Plugins' declared tiers count: no allow rule may cover a FINANCIAL plugin tool.
    const tier =
      classifyTool(body.toolPattern, {
        shellContained: false,
        overrides: [...ORBIT_TOOL_TIERS, ...this.plugins.toolTiers()],
      })?.tier ?? null;
    const rule = this.rules.create(
      {
        botId: body.bot ? this.bots.get(body.bot).id : null,
        toolPattern: body.toolPattern,
        inputMatch: body.inputMatch ?? null,
        effect: body.effect,
        reason: body.reason ?? null,
        createdBy: this.actor(),
        expiresAt: body.expiresAt,
      },
      tier,
    );
    this.audit.append({
      actor: this.actor(),
      action: 'rule.created',
      subject: rule.id,
      data: { ...rule },
    });
    return rule;
  }

  revokeRule(id: string): Rule {
    const rule = this.rules.revoke(id);
    this.audit.append({ actor: this.actor(), action: 'rule.revoked', subject: rule.id, data: {} });
    return rule;
  }

  /** The latest `limit` records (oldest first), optionally of one action. */
  auditTail(action: string | undefined, limit: number): AuditRecord[] {
    let records: AuditRecord[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = this.audit.list({ ...(action ? { action } : {}), afterSeq, limit: 1000 });
      if (page.length === 0) break;
      records = [...records, ...page].slice(-limit);
      afterSeq = page.at(-1)?.seq ?? afterSeq;
    }
    return records;
  }

  setSecret(name: string, value: string): { name: string; keySource: 'keychain' | 'file' } {
    this.vault.set(name, value);
    this.redactor.addSecret(value);
    this.audit.append({ actor: this.actor(), action: 'secret.set', subject: name, data: {} });
    return { name, keySource: this.vault.keySource };
  }

  removeSecret(name: string): void {
    if (!this.vault.remove(name)) throw new OrbitError('not_found', `Secret ${name} not found`);
    this.audit.append({ actor: this.actor(), action: 'secret.removed', subject: name, data: {} });
  }

  killStatus(): { engaged: boolean; by: string | null } {
    const by = this.controls.globalKill();
    return { engaged: by !== null, by };
  }

  setKill(on: boolean): { engaged: boolean; by: string | null } {
    this.orchestrator.killAll(this.actor(), on);
    this.killSeen = on;
    if (on) {
      // "Stop everything": nothing waiting may continue after the release (review L2).
      this.closeWaiting();
    } else {
      this.queue.pump();
    }
    return this.killStatus();
  }

  // ── doctor ────────────────────────────────────────────────────────────────

  /** Whether Docker Bots can run, and what their host-side proxies did (ADR-018). */
  private async dockerSandboxStatus(
    r: AuthResolution,
    dockerAvailable: boolean,
  ): Promise<DockerSandboxStatus> {
    const keyProxy: DockerSandboxStatus['keyProxy'] =
      r.driver === 'cli'
        ? 'subscription'
        : r.apiCredential === 'bedrock' || r.apiCredential === 'vertex'
          ? 'unsupported_provider'
          : r.apiCredential === null
            ? 'no_api_key'
            : 'ready';
    const used = this.bots
      .list()
      .filter((b) => b.spec.sandbox.kind === 'docker')
      .map((b) => b.spec.sandbox.image);
    const images = await this.sandbox.imageStatus(
      used.length > 0 ? used : [BotSandbox.parse({}).image],
    );
    const missing = images.filter((i) => !i.present).map((i) => i.image);
    const noSocat = images.filter((i) => i.present && i.socat !== true).map((i) => i.image);
    const detail = !dockerAvailable
      ? 'Docker is not available.'
      : keyProxy === 'subscription'
        ? 'Subscription (CLI) mode never runs Bots in containers; use an API key for Docker sandboxes.'
        : keyProxy === 'unsupported_provider'
          ? 'Bedrock and Vertex credentials cannot go through the key proxy; use worktree or directory sandboxes.'
          : keyProxy === 'no_api_key'
            ? 'Set ANTHROPIC_API_KEY or ORBIT_API_KEY_HELPER for orbitd.'
            : missing.length > 0
              ? `Build the sandbox image: docker build -f docker/sandbox.Dockerfile -t ${missing[0] ?? ''} .`
              : noSocat.length > 0
                ? `The image ${noSocat[0] ?? ''} has no socat; rebuild it from docker/sandbox.Dockerfile.`
                : 'Ready: the API key stays on the host; containers reach the API through the key proxy.';
    return {
      ready:
        dockerAvailable && keyProxy === 'ready' && missing.length === 0 && noSocat.length === 0,
      keyProxy,
      detail,
      images,
      proxies: this.sandbox.proxyStatus(),
    };
  }

  /** The plugin sandbox for doctor (ADR-019): the mode, the host, plugins that run without it. */
  private pluginSandboxDoctor(): {
    report: DoctorReport['sandbox']['plugins'];
    warnings: { code: string; message: string }[];
  } {
    const mode = this.config.plugins.sandbox;
    const support = this.pluginSandboxSupport();
    const enabled = this.plugins.list().filter((p) => p.enabled);
    const notSandboxed = enabled
      .filter((p) => p.sandbox.state !== 'sandboxed' && p.sandbox.state !== 'remote')
      .map((p) => ({ id: p.id, state: p.sandbox.state, reason: p.sandbox.reason }));
    const warnings: { code: string; message: string }[] = [];
    if (mode === 'off') {
      warnings.push({
        code: 'plugin_sandbox_off',
        message:
          'plugins.sandbox is off: plugin servers run as your user without an OS sandbox (Orbit still decides every call). Set it to auto or required.',
      });
    } else {
      for (const p of notSandboxed) {
        warnings.push({
          code: p.state === 'refused' ? 'plugin_sandbox_refused' : 'plugin_unsandboxed',
          message:
            p.state === 'refused'
              ? `Plugin ${p.id} does not start: it cannot be sandboxed here (${p.reason ?? 'unknown'}) and plugins.sandbox is required.`
              : `Plugin ${p.id} runs without an OS sandbox: ${p.reason ?? 'unknown'}.`,
        });
      }
    }
    return {
      report: {
        mode,
        available: support.available,
        engine: support.engine,
        reason: support.reason,
        notSandboxed,
      },
      warnings,
    };
  }

  /** How the SDK engine gets its API credential (ADR-018); null for other drivers. */
  private engineKeyStatus(r: AuthResolution): EngineKeyStatus | null {
    const k = r.engineKey;
    if (r.driver !== 'sdk' || k === null) return null;
    const proxy = this.engine?.handle.keyProxy?.status() ?? null;
    const detail =
      k.delivery === 'proxied'
        ? "The API key stays in orbitd: engines on the host reach the API through orbitd's loopback key proxy with a token per Run segment, Docker Bots through their own socket." +
          (k.subprocessScrub === false
            ? ' Without bubblewrap Claude Code runs shell commands without subprocess isolation; their environment holds no secret.'
            : k.subprocessScrub === true
              ? ' Claude Code also isolates its shell commands and tools (subprocess scrub).'
              : '')
        : "Bedrock and Vertex credentials cannot go through the key proxy: they are in the engine's environment, and Claude Code scrubs them from its shell commands and tools" +
          (k.subprocessScrub === false ? ' once bubblewrap is installed.' : '.');
    return {
      delivery: k.delivery,
      subprocessScrub: k.subprocessScrub,
      detail,
      proxy: proxy
        ? { port: proxy.port, activeSegments: proxy.activeSegments, api: proxy.api }
        : null,
    };
  }

  /** Why the key proxy cannot forward to orbitd's ANTHROPIC_BASE_URL, or null. */
  private keyProxyUpstreamProblem(r: AuthResolution): string | null {
    if (r.driver !== 'sdk' || r.engineKey?.delivery !== 'proxied') return null;
    try {
      parseUpstream(apiUpstream(this.opts.env));
      return null;
    } catch (err) {
      return err instanceof OrbitError ? `${err.message}. ${err.hint ?? ''}`.trim() : null;
    }
  }

  async doctor(): Promise<DoctorReport> {
    const env = this.opts.env;
    const [r, sandbox] = await Promise.all([
      this.resolve(),
      detectSandboxSupport(defaultRunner(buildChildEnv('tool', env)), { pathEnv: env.PATH ?? '' }),
    ]);
    const dockerSandbox = await this.dockerSandboxStatus(r, sandbox.docker.available);
    const upstreamProblem = this.keyProxyUpstreamProblem(r);
    const c = this.config;
    const listen = this.opts.listen ?? { tls: false, container: false };
    const pluginSandbox = this.pluginSandboxDoctor();
    return {
      ok: r.driver !== null,
      driver: r.driver,
      driverSource: r.source,
      authMethod: r.authMethod,
      authLabel: r.label,
      cli: r.cli
        ? { ...r.cli, error: r.cli.error ? this.redactor.redactString(r.cli.error) : null }
        : null,
      apiCredential: r.apiCredential,
      engineKey: this.engineKeyStatus(r),
      compliance: r.guard,
      warnings: [
        ...r.warnings.map((w) => ({
          code: w.code,
          message: this.redactor.redactString(w.message),
        })),
        ...(this.auditKeyWarning
          ? [{ code: 'audit_key_without_keyed_log', message: this.auditKeyWarning }]
          : []),
        // The key stayed in orbitd's own environment, readable by every
        // process of the same user (/proc/<pid>/environ, ps eww).
        ...(this.opts.apiKeyOrigin === 'environment' && r.apiCredential === 'api_key'
          ? [
              {
                code: 'api_key_in_environment',
                message:
                  "The API key is in orbitd's process environment, where any process of the same user can read it — including Bash and plugins on a host without an OS sandbox. Put it in a file only you can read and set ORBIT_API_KEY_FILE (chmod 600), or let the orbit CLI start orbitd (it hands the key over on a pipe).",
              },
            ]
          : []),
        ...(upstreamProblem
          ? [
              {
                code: 'key_proxy_upstream',
                message: `SDK Runs cannot start: ${this.redactor.redactString(upstreamProblem)}`,
              },
            ]
          : []),
        // A dev origin is trusted with credentialed CORS: whatever else runs on
        // that port later is trusted too (review M5 MEDIUM-2).
        ...(c.api.allowedOrigins.length > 0
          ? [
              {
                code: 'app_extra_origins',
                message: `Browser origins besides orbitd's own are allowed (${c.api.allowedOrigins.join(', ')}). Keep this for App development only: any page served on those ports can call the API. Unset ORBIT_ALLOWED_ORIGINS / api.allowedOrigins when you are done.`,
              },
            ]
          : []),
        // The container listens on every interface inside its own network
        // namespace; only the host's loopback may reach the published port.
        ...(listen.container
          ? [
              {
                code: 'container_bind',
                message: `orbitd listens on ${c.api.host} inside a container. Publish its port to the host's loopback only (\`127.0.0.1:${c.api.port}:${c.api.port}\`): the local API is plain HTTP.`,
              },
            ]
          : []),
        ...(c.mode === 'local' &&
        (c.hosted.publicUrl !== null || c.hosted.tls !== null || c.hosted.oidc !== null)
          ? [
              {
                code: 'hosted_settings_ignored',
                message:
                  'Hosted settings (public URL, TLS, OIDC) are ignored in local mode. Set ORBIT_MODE=hosted to use them.',
              },
            ]
          : []),
        ...(c.mode === 'hosted' && !c.principals.some((p) => p.oidc !== undefined)
          ? [
              {
                code: 'no_oidc_principals',
                message:
                  'No principal names an OIDC subject or email, so nobody can sign in to the App. Add "oidc": {"subject": "…"} to the principals in config.json.',
              },
            ]
          : []),
        ...pluginSandbox.warnings,
      ],
      refusal: r.refusal,
      onboarding: r.onboarding,
      mode: c.mode,
      api: c.api,
      humanPrincipals: humanPrincipalCount(c),
      principals: principalsByRole(c),
      hosted:
        c.mode === 'hosted'
          ? {
              publicUrl: c.hosted.publicUrl,
              issuer: c.hosted.oidc?.issuer ?? null,
              tls: c.hosted.tls !== null,
            }
          : null,
      listen: { tls: listen.tls, container: listen.container },
      models: c.models,
      home: c.home,
      node: process.version,
      platform: `${platform()}-${arch()}`,
      sandbox: { ...sandbox, dockerSandbox, plugins: pluginSandbox.report },
      daemon: {
        pid: process.pid,
        startedAt: this.startedAt,
        url: this.url,
        concurrency: this.concurrency(),
      },
    };
  }
}
