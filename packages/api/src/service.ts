import { arch, platform } from 'node:os';
import {
  type Bot,
  type BotSpecInput,
  type OrbitConfig,
  OrbitError,
  Redactor,
  type RunState,
  type TriggerRef,
  type TriggerSpec,
  errorMessage,
  event,
  humanPrincipalCount,
} from '@orbit/core';
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
} from '@orbit/policy';
import {
  API_CREDENTIALS,
  type AuthProbes,
  type AuthResolution,
  type DriverHandle,
  type Env,
  type MockDriverOptions,
  Orchestrator,
  type QueryFn,
  type QueueJob,
  RateLimitManager,
  RunQueue,
  Scheduler,
  type ScheduleEntry,
  type WorkspaceProvider,
  buildChildEnv,
  createDriver,
  createSandboxManager,
  resolveAuth,
  sandboxWorkspaces,
  systemProbes,
  validateTriggers,
} from '@orbit/runtime';
import { defaultRunner, detectSandboxSupport } from '@orbit/sandbox';
import {
  BotRepo,
  Controls,
  EventStore,
  type OrbitDb,
  TriggerStateRepo,
  migrationAppliedAt,
} from '@orbit/store';
import type { z } from 'zod';
import type {
  ApproveBody,
  CreateRuleBody,
  DecisionResult,
  DenyBody,
  DoctorReport,
  QueueSnapshot,
} from './contract';

/** Who acts through the local API: the single local owner (OIDC principals arrive with hosted mode). */
export const OWNER = 'owner';

const IN_FLIGHT: readonly RunState['status'][] = [
  'queued',
  'running',
  'waiting_approval',
  'rate_limited',
];

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface ServiceOptions {
  config: OrbitConfig;
  /** The daemon's own environment: read for credentials, never spread into children. */
  env: Env;
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
  /** Where the vault key lives; default 'auto' (keychain, else a 0600 file). Tests use 'file'. */
  vaultKeySource?: 'auto' | 'keychain' | 'file';
  log?: Logger;
  now?: () => Date;
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
  readonly startedAt: string;
  readonly version: string;
  /** Base URL once orbitd listens (shown by doctor). */
  url = '';

  private engine: { resolution: AuthResolution; handle: DriverHandle } | null = null;
  private engineStarting: Promise<{ resolution: AuthResolution; handle: DriverHandle }> | null =
    null;
  private readonly resumeOptions = new Map<string, { prompt?: string; mockFixture?: string }>();
  private ticker: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly log: Logger;
  private readonly now: () => Date;

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
    this.audit = new AuditLog(db, this.redactor);
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
      workspaces:
        opts.workspaces ??
        sandboxWorkspaces(
          createSandboxManager(config.home, env, (bot) => this.m2WorkspaceName(bot)),
          env,
        ),
      ...(opts.killPollMs ? { killPollMs: opts.killPollMs } : {}),
      now: this.now,
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
    // Runs that were executing when the previous daemon died cannot continue.
    for (const run of this.store.listRuns({ status: ['running'], limit: 1000 })) {
      this.approvals.cancelForRun(run.runId, 'system', 'expired');
      this.store.append(run.runId, run.botId, [
        event('run.failed', {
          code: 'interrupted',
          message: 'orbitd stopped while this run was executing; start it again',
          retryable: true,
          sessionId: run.sessionId,
        }),
      ]);
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
    this.rateLimits.recover();
    this.ticker = setInterval(() => this.tick(), this.opts.tickMs ?? 1000);
    this.ticker.unref();
  }

  /** Housekeeping: scheduled triggers, approval expiry, usage-limit resumes. */
  tick(): void {
    try {
      for (const r of this.scheduler.tick()) {
        if (!r.outcome.fired) this.log('info', `trigger ${r.key} skipped: ${r.outcome.reason}`);
      }
      for (const runId of new Set(this.approvals.expireDue().map((a) => a.runId))) {
        this.maybeAutoResume(runId);
      }
      this.rateLimits.tick();
      this.queue.pump();
    } catch (err) {
      this.log('error', `housekeeping failed: ${errorMessage(err)}`);
    }
  }

  /** Graceful stop: no new dispatches, executing Runs end as interrupted. */
  async stop(): Promise<void> {
    clearInterval(this.ticker);
    this.unsubscribe?.();
    this.queue.freeze();
    this.orchestrator.shutdown();
    await this.orchestrator.drain(15_000);
    await this.engine?.handle.close();
    this.engine = null;
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
    if (this.bots.find(job.botId)?.pausedAt) return 'Bot is paused';
    return this.rateLimits.hold();
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
        return;
      }
      const options = this.resumeOptions.get(job.runId) ?? {};
      this.resumeOptions.delete(job.runId);
      await this.orchestrator.resume(job.runId, options);
    } catch (err) {
      // Review M1: a job that died before its segment ended must not leave the
      // Run looking queued or running (it would also block its trigger forever).
      this.closeOrphan(job.runId, err);
      throw err;
    }
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

  private checkSpec(spec: BotSpecInput): void {
    validateTriggers((spec.triggers ?? []) as TriggerSpec[]);
  }

  createBot(spec: BotSpecInput): Bot {
    this.checkSpec(spec);
    const bot = this.bots.create(spec);
    this.audit.append({
      actor: OWNER,
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
      actor: OWNER,
      action: 'bot.updated',
      subject: bot.id,
      data: { version: bot.version, spec: bot.spec },
    });
    return bot;
  }

  pauseBot(ref: string): Bot {
    const bot = this.orchestrator.pauseBot(ref, OWNER);
    // Nothing of a paused Bot may continue once it is resumed: queued, parked
    // and rate-limited Runs are closed too (review L2).
    this.closeWaiting(bot.id);
    return bot;
  }

  /** Cancel queued, parked and rate-limited Runs (of one Bot, or all). */
  private closeWaiting(botId?: string): void {
    const waiting = this.store.listRuns({
      ...(botId ? { botId } : {}),
      status: ['queued', 'waiting_approval', 'rate_limited'],
      limit: 10_000,
    });
    for (const run of waiting) {
      if (this.queue.isActive(run.runId) || this.orchestrator.isActive(run.runId)) continue;
      this.queue.remove(run.runId);
      try {
        this.orchestrator.stop(run.runId, OWNER);
      } catch (err) {
        if (!(err instanceof OrbitError && err.code === 'conflict')) throw err;
      }
    }
  }

  resumeBot(ref: string): Bot {
    const bot = this.orchestrator.resumeBot(ref, OWNER);
    this.queue.pump();
    return bot;
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
    if (run.status !== 'waiting_approval' && run.status !== 'rate_limited') {
      throw new OrbitError(
        run.status === 'running' || run.status === 'queued' ? 'conflict' : 'invalid_input',
        `Run ${runId} is ${run.status}; only parked or rate-limited runs can resume`,
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

  /** Resume a parked Run whose approvals are all decided, if its Bot auto-resumes. */
  private maybeAutoResume(runId: string, force?: boolean, fixture?: string): boolean {
    const run = this.store.getRun(runId);
    if (run?.status !== 'waiting_approval' || run.pendingApprovals.length > 0) return false;
    const bot = this.bots.find(run.botId);
    if (!(force ?? bot?.spec.approvals.autoResume ?? false)) return false;
    return this.pushResume(run, fixture ? { mockFixture: fixture } : {});
  }

  private cancelWaiting(runId: string): void {
    this.queue.remove(runId);
    try {
      this.orchestrator.cancelQueued(runId, OWNER);
    } catch (err) {
      if (!(err instanceof OrbitError && err.code === 'conflict')) throw err;
    }
  }

  stopRun(runId: string): RunState {
    this.requireRun(runId);
    this.queue.remove(runId);
    // orbitd is the single writer: a `running` Run that no job executes is an
    // orphan and is closed now instead of waiting for a poll that never comes.
    const orphaned = !this.queue.isActive(runId) && !this.orchestrator.isActive(runId);
    this.orchestrator.stop(runId, OWNER, { orphaned });
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
    const approval = this.approvals.decide(id, {
      approve: true,
      by: OWNER,
      editedInput: body.editedInput ?? null,
      always: body.always ?? null,
    });
    return this.decided(approval, body.resume, body.fixture);
  }

  deny(id: string, body: z.output<typeof DenyBody>): z.infer<typeof DecisionResult> {
    const approval = this.approvals.decide(id, {
      approve: false,
      by: OWNER,
      reason: body.reason ?? null,
    });
    return this.decided(approval, body.resume, body.fixture);
  }

  // ── policy, audit, secrets, kill switch ──────────────────────────────────

  createRule(body: z.output<typeof CreateRuleBody>): Rule {
    const tier = classifyTool(body.toolPattern, { shellContained: false })?.tier ?? null;
    const rule = this.rules.create(
      {
        botId: body.bot ? this.bots.get(body.bot).id : null,
        toolPattern: body.toolPattern,
        effect: body.effect,
        reason: body.reason ?? null,
        createdBy: OWNER,
        expiresAt: body.expiresAt,
      },
      tier,
    );
    this.audit.append({
      actor: OWNER,
      action: 'rule.created',
      subject: rule.id,
      data: { ...rule },
    });
    return rule;
  }

  revokeRule(id: string): Rule {
    const rule = this.rules.revoke(id);
    this.audit.append({ actor: OWNER, action: 'rule.revoked', subject: rule.id, data: {} });
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
    this.audit.append({ actor: OWNER, action: 'secret.set', subject: name, data: {} });
    return { name, keySource: this.vault.keySource };
  }

  removeSecret(name: string): void {
    if (!this.vault.remove(name)) throw new OrbitError('not_found', `Secret ${name} not found`);
    this.audit.append({ actor: OWNER, action: 'secret.removed', subject: name, data: {} });
  }

  killStatus(): { engaged: boolean; by: string | null } {
    const by = this.controls.globalKill();
    return { engaged: by !== null, by };
  }

  setKill(on: boolean): { engaged: boolean; by: string | null } {
    this.orchestrator.killAll(OWNER, on);
    if (on) {
      // "Stop everything": nothing waiting may continue after the release (review L2).
      this.closeWaiting();
    } else {
      this.queue.pump();
    }
    return this.killStatus();
  }

  // ── doctor ────────────────────────────────────────────────────────────────

  async doctor(): Promise<DoctorReport> {
    const env = this.opts.env;
    const [r, sandbox] = await Promise.all([
      this.resolve(),
      detectSandboxSupport(defaultRunner(buildChildEnv('tool', env)), { pathEnv: env.PATH ?? '' }),
    ]);
    const c = this.config;
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
      compliance: r.guard,
      warnings: r.warnings.map((w) => ({
        code: w.code,
        message: this.redactor.redactString(w.message),
      })),
      refusal: r.refusal,
      onboarding: r.onboarding,
      mode: c.mode,
      api: c.api,
      humanPrincipals: humanPrincipalCount(c),
      models: c.models,
      home: c.home,
      node: process.version,
      platform: `${platform()}-${arch()}`,
      sandbox,
      daemon: {
        pid: process.pid,
        startedAt: this.startedAt,
        url: this.url,
        concurrency: this.concurrency(),
      },
    };
  }
}
