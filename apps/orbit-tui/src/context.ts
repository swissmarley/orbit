import { join } from 'node:path';
import { type OrbitConfig, Redactor } from '@orbit/core';
import { ApprovalQueue, AuditLog, PolicyEngine, RuleStore, SecretVault } from '@orbit/policy';
import {
  API_CREDENTIALS,
  type AuthResolution,
  type DriverHandle,
  Orchestrator,
  createDriver,
  createSandboxManager,
  sandboxWorkspaces,
  loadConfig,
  resolveAuth,
  systemProbes,
} from '@orbit/runtime';
import { BotRepo, Controls, EventStore, type OrbitDb, openDatabase } from '@orbit/store';
import type { Io } from './io';

/** Lazily opened local state. In M3 the CLI becomes a client of orbitd instead. */
export class Context {
  readonly config: OrbitConfig;
  /** One redactor per process: API credentials, vault values and every per-run token. */
  readonly redactor: Redactor;
  private db: OrbitDb | undefined;
  private vaultInstance: SecretVault | undefined;
  private cache = new Map<string, unknown>();

  constructor(readonly io: Io) {
    this.config = loadConfig(io.env);
    this.redactor = new Redactor(API_CREDENTIALS.map((name) => io.env[name] ?? ''));
  }

  private open(): OrbitDb {
    this.db ??= openDatabase(join(this.config.home, 'orbit.db'));
    return this.db;
  }

  private once<T>(key: string, make: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key) as T;
  }

  get bots(): BotRepo {
    return this.once('bots', () => new BotRepo(this.open()));
  }

  get store(): EventStore {
    return this.once('store', () => new EventStore(this.open(), this.redactor));
  }

  get controls(): Controls {
    return this.once('controls', () => new Controls(this.open()));
  }

  get audit(): AuditLog {
    return this.once('audit', () => new AuditLog(this.open(), this.redactor));
  }

  get rules(): RuleStore {
    return this.once('rules', () => new RuleStore(this.open()));
  }

  get approvals(): ApprovalQueue {
    return this.once(
      'approvals',
      () => new ApprovalQueue(this.open(), { audit: this.audit, events: this.store }),
    );
  }

  /** Open the vault and teach the redactor every secret value. */
  vault(): SecretVault {
    if (!this.vaultInstance) {
      this.vaultInstance = new SecretVault({ db: this.open(), home: this.config.home });
      for (const v of this.vaultInstance.values()) this.redactor.addSecret(v);
    }
    return this.vaultInstance;
  }

  resolveAuth(): Promise<AuthResolution> {
    return resolveAuth({
      config: this.config,
      env: this.io.env,
      probes: systemProbes(this.config, this.io.env),
    });
  }

  createDriver(resolution: AuthResolution): Promise<DriverHandle> {
    return createDriver(resolution, this.config, this.io.env, {
      mock: { delayMs: this.config.driver === 'mock' ? 120 : 0 },
      secrets: this.redactor,
    });
  }

  /** Orchestrator for state-only operations (stop, pause, kill) — no engine needed. */
  orchestrator(handle?: DriverHandle): Orchestrator {
    // Vault values must be known to the redactor before any tool output flows.
    this.secretsLoaded();
    return new Orchestrator({
      config: this.config,
      store: this.store,
      bots: this.bots,
      controls: this.controls,
      approvals: this.approvals,
      policy: new PolicyEngine(this.approvals, this.rules),
      driver: handle?.driver ?? {
        kind: 'mock',
        authMethod: 'none',
        run: () => {
          throw new Error('No engine: this command does not run Bots');
        },
      },
      redactor: this.redactor,
      audit: this.audit,
      workspaces: sandboxWorkspaces(
        createSandboxManager(this.config.home, this.io.env),
        this.io.env,
      ),
    });
  }

  private secretsLoaded(): boolean {
    try {
      this.vault();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.cache.clear();
    this.vaultInstance = undefined;
  }
}
