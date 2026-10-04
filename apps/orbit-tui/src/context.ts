import { join } from 'node:path';
import { type OrbitConfig, Redactor } from '@orbit/core';
import {
  API_CREDENTIALS,
  type AuthResolution,
  type DriverHandle,
  createDriver,
  loadConfig,
  resolveAuth,
  systemProbes,
} from '@orbit/runtime';
import { BotRepo, EventStore, type OrbitDb, openDatabase } from '@orbit/store';
import type { Io } from './io';

/** Lazily opened local state. In M3 the CLI becomes a client of orbitd instead. */
export class Context {
  readonly config: OrbitConfig;
  /** One redactor per process: knows the API credentials and every per-run token. */
  readonly redactor: Redactor;
  private db: OrbitDb | undefined;

  constructor(readonly io: Io) {
    this.config = loadConfig(io.env);
    this.redactor = new Redactor(API_CREDENTIALS.map((name) => io.env[name] ?? ''));
  }

  private open(): OrbitDb {
    this.db ??= openDatabase(join(this.config.home, 'orbit.db'));
    return this.db;
  }

  get bots(): BotRepo {
    return new BotRepo(this.open());
  }

  get store(): EventStore {
    return new EventStore(this.open(), this.redactor);
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

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
