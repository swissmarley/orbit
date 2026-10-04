import { randomBytes } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { type Logger, OrbitService, type ServiceOptions, createApp } from '@orbit/api';
import { type OrbitConfig, OrbitError, isLoopbackHost } from '@orbit/core';
import { type Env, loadConfig } from '@orbit/runtime';
import { type DaemonInfo, daemonFiles } from '@orbit/sdk-client';
import { openDatabase } from '@orbit/store';

export const ORBITD_VERSION = '0.1.0';

export interface DaemonOptions {
  env: Env;
  /** Override the configured port (0 = any free port; tests). */
  port?: number;
  log?: Logger;
  /** Called when a client asks the daemon to stop (POST /v1/daemon/stop); default: stop(). */
  onStopRequested?: () => void;
  /** Test seams passed to the service (mock pacing, probes, workspaces, …). */
  service?: Partial<ServiceOptions>;
}

export interface Daemon {
  url: string;
  config: OrbitConfig;
  service: OrbitService;
  stop(): Promise<void>;
}

/** Write a 0600 file atomically (never readable by others, even briefly). */
function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const alreadyRunning = (pid: number) =>
  new OrbitError('blocked', `orbitd is already running for this ORBIT_HOME (pid ${pid})`, {
    hint: 'Use it (`orbit daemon status`) or stop it first (`orbit daemon stop`).',
  });

/**
 * One daemon per ORBIT_HOME: an exclusive lock file holding the owner's pid.
 * Creation is atomic with its content (hard link of a complete temp file),
 * and a stale lock is moved aside with rename, so of two starters racing over
 * a crashed daemon's lock exactly one wins (review L5).
 */
function acquireLock(path: string): () => void {
  const unique = () => `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = unique();
    writeFileSync(tmp, String(process.pid), { mode: 0o600 });
    try {
      linkSync(tmp, path);
      return () => {
        if (readPid(path) === process.pid) rmSync(path, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      rmSync(tmp, { force: true });
    }
    const holder = readPid(path);
    if (holder !== null && pidAlive(holder)) throw alreadyRunning(holder);
    const aside = unique();
    try {
      renameSync(path, aside);
    } catch {
      continue; // someone else moved it first
    }
    const moved = readPid(aside);
    if (moved !== null && moved !== holder && pidAlive(moved)) {
      // We grabbed a fresh lock another starter just took: give it back.
      try {
        linkSync(aside, path);
      } catch {
        // it re-created one meanwhile
      }
      rmSync(aside, { force: true });
      throw alreadyRunning(moved);
    }
    rmSync(aside, { force: true });
  }
  throw new OrbitError('internal', `Cannot acquire ${path}`);
}

/**
 * The orbitd composition root: config → policy checks → database → service
 * → HTTP server on loopback with a fresh bearer token. orbitd is the single
 * writer of the Orbit database while it runs.
 */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const config = loadConfig(opts.env);
  if (config.mode === 'hosted') {
    throw new OrbitError('invalid_config', 'Hosted mode is not available yet', {
      hint: 'Hosted mode needs OIDC sign-in and TLS (planned for M8). Run orbitd locally with ORBIT_MODE=local.',
    });
  }
  if (!isLoopbackHost(config.api.host)) {
    throw new OrbitError(
      'invalid_config',
      `orbitd only listens on loopback for now (got ORBIT_HOST=${config.api.host})`,
      {
        hint: 'The local API uses a bearer token over plain HTTP; remote access needs TLS and OIDC (M8). Use 127.0.0.1.',
      },
    );
  }
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  const files = daemonFiles(config.home);
  const releaseLock = acquireLock(files.lock);
  let cleanup = releaseLock;
  try {
    // Written only once we listen: a daemon that fails to start must not
    // replace the token of the one already running (review L5).
    const token = randomBytes(32).toString('hex');
    const db = openDatabase(join(config.home, 'orbit.db'));
    cleanup = () => {
      db.close();
      releaseLock();
    };
    const service = new OrbitService({
      config,
      env: opts.env,
      db,
      version: ORBITD_VERSION,
      ...(opts.log ? { log: opts.log } : {}),
      ...opts.service,
    });
    service.redactor.addSecret(token);

    let port = opts.port ?? config.api.port;
    const hosts = () => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    let stopping: Promise<void> | null = null;
    const app = createApp({
      service,
      token,
      allowedHosts: hosts,
      // The bin exits the process; embedded daemons (tests) just stop.
      onStop: () => (opts.onStopRequested ? opts.onStopRequested() : void stop()),
    });
    const server = await new Promise<Server>((resolve, reject) => {
      const s = serve(
        { fetch: app.fetch, hostname: config.api.host, port },
        (info: AddressInfo) => {
          port = info.port;
          resolve(s);
        },
      ) as Server;
      s.once('error', (err: NodeJS.ErrnoException) =>
        reject(
          err.code === 'EADDRINUSE'
            ? new OrbitError('invalid_config', `Port ${port} on ${config.api.host} is in use`, {
                hint: 'Set ORBIT_PORT to a free port.',
              })
            : err,
        ),
      );
    });
    writePrivate(files.token, `${token}\n`);
    const host = config.api.host.includes(':') ? `[${config.api.host}]` : config.api.host;
    const url = `http://${host}:${port}`;
    service.url = url;
    const info: DaemonInfo = {
      pid: process.pid,
      url,
      startedAt: service.startedAt,
      version: ORBITD_VERSION,
    };
    writePrivate(files.info, `${JSON.stringify(info, null, 2)}\n`);
    service.start();

    cleanup = () => {
      rmSync(files.info, { force: true });
      rmSync(files.token, { force: true });
      releaseLock();
    };
    const stop = () =>
      (stopping ??= (async () => {
        server.close();
        // SSE clients hold connections open; the daemon is going away anyway.
        server.closeAllConnections();
        await service.stop();
        db.close();
        cleanup();
      })());
    return { url, config, service, stop };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Is a daemon for this home answering on its published address? */
export function daemonInfoExists(home: string): boolean {
  return existsSync(daemonFiles(home).info);
}
