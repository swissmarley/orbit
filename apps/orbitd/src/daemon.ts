import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
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
  /** Called when a client asks the daemon to stop (POST /v1/daemon/stop). */
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

/** One daemon per ORBIT_HOME: an exclusive lock file holding the owner's pid. */
function acquireLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        throw new OrbitError(
          'blocked',
          `orbitd is already running for this ORBIT_HOME (pid ${pid})`,
          {
            hint: 'Use it (`orbit daemon status`) or stop it first (`orbit daemon stop`).',
          },
        );
      }
      rmSync(path, { force: true }); // stale lock from a crashed daemon
    }
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
    const token = randomBytes(32).toString('hex');
    writePrivate(files.token, `${token}\n`);
    const db = openDatabase(join(config.home, 'orbit.db'));
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
      onStop: () => opts.onStopRequested?.(),
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
