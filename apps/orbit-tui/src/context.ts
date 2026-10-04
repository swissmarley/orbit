import { join } from 'node:path';
import { type OrbitConfig, defaultRedactor } from '@orbit/core';
import {
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
  private db: OrbitDb | undefined;

  constructor(readonly io: Io) {
    this.config = loadConfig(io.env);
  }

  private open(): OrbitDb {
    this.db ??= openDatabase(join(this.config.home, 'orbit.db'));
    return this.db;
  }

  get bots(): BotRepo {
    return new BotRepo(this.open());
  }

  get store(): EventStore {
    return new EventStore(this.open(), defaultRedactor);
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
    });
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
