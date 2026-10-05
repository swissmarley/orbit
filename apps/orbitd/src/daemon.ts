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
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import {
  type Logger,
  OIDC_CALLBACK_PATH,
  OidcSignIn,
  OrbitService,
  type ServiceOptions,
  SessionStore,
  createApp,
} from '@orbit/api';
import { type OrbitConfig, OrbitError, isLoopbackHost } from '@orbit/core';
import { type Env, GUARD_API_KEY_HOWTO, loadConfig } from '@orbit/runtime';
import { type DaemonInfo, daemonFiles } from '@orbit/sdk-client';
import { openDatabase } from '@orbit/store';

export const ORBITD_VERSION = '0.1.0';

/** Vault entry holding the OIDC client secret (confidential clients; ADR-015). */
export const OIDC_CLIENT_SECRET = 'oidc_client_secret';

export interface DaemonOptions {
  env: Env;
  /** Override the configured port (0 = any free port; tests). */
  port?: number;
  log?: Logger;
  /** Called when a client asks the daemon to stop (POST /v1/daemon/stop); default: stop(). */
  onStopRequested?: () => void;
  /** Test seams passed to the service (mock pacing, probes, workspaces, …). */
  service?: Partial<ServiceOptions>;
  /** Is this process inside a container? Default: `/.dockerenv` or `/run/.containerenv` exists. */
  inContainer?: () => boolean;
}

function containerMarkerExists(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/** Every interface: allowed only inside a container (local mode) or with TLS (hosted). */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/** How orbitd listens, decided before anything is opened (ADR-010, ADR-015). */
export interface ListenPlan {
  /** In-process TLS: the PEM certificate chain and key. */
  tls: { cert: Buffer; key: Buffer } | null;
  /** Local mode inside a container, bound to every interface of its own network namespace. */
  container: boolean;
  /** The host clients on this machine (CLI, sign-in links) use; `127.0.0.1` for a container bind. */
  publishedHost: string;
  /** Hosted mode: the public https origin. */
  publicUrl: string | null;
}

const refuse = (message: string, hint: string) =>
  new OrbitError('invalid_config', message, { hint });

function readPem(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw refuse(
      `Cannot read the TLS ${what} ${path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      'ORBIT_TLS_CERT and ORBIT_TLS_KEY name PEM files orbitd can read.',
    );
  }
}

/**
 * The startup rules (ADR-015). Local mode listens on loopback, or on every
 * interface of a container (ORBIT_CONTAINER=1 and a container marker; the
 * port must then be published to the host's loopback only). Hosted mode needs
 * a public https URL and OIDC, never uses the CliDriver, and listens off
 * loopback only with in-process TLS; on loopback without TLS it sits behind
 * a TLS-terminating reverse proxy on the same machine.
 */
export function planListen(
  config: OrbitConfig,
  env: Env,
  inContainer: () => boolean = containerMarkerExists,
): ListenPlan {
  const host = config.api.host;
  const loopback = isLoopbackHost(host);
  if (config.mode === 'hosted') {
    const { publicUrl, oidc, tls } = config.hosted;
    if (publicUrl === null) {
      throw refuse(
        'Hosted mode needs its public https URL',
        'Set ORBIT_PUBLIC_URL=https://orbit.example.com (the address browsers and webhook senders use), or hosted.publicUrl in config.json.',
      );
    }
    if (oidc === null) {
      throw refuse(
        'Hosted mode needs OIDC sign-in',
        'Set ORBIT_OIDC_ISSUER and ORBIT_OIDC_CLIENT_ID (register the callback URL ' +
          `${publicUrl}${OIDC_CALLBACK_PATH} with your identity provider).`,
      );
    }
    if (config.driver === 'cli') {
      throw new OrbitError(
        'compliance_refused',
        'Hosted mode never uses your Claude subscription (ORBIT_DRIVER=cli)',
        { hint: GUARD_API_KEY_HOWTO },
      );
    }
    if (!loopback && tls === null) {
      throw refuse(
        `orbitd listens on ${host} only with TLS`,
        'Set ORBIT_TLS_CERT and ORBIT_TLS_KEY, or keep ORBIT_HOST=127.0.0.1 behind a TLS-terminating reverse proxy on this machine.',
      );
    }
    return {
      tls: tls
        ? { cert: readPem(tls.certFile, 'certificate'), key: readPem(tls.keyFile, 'key') }
        : null,
      container: false,
      publishedHost: loopback ? host : '127.0.0.1',
      publicUrl,
    };
  }
  if (loopback) return { tls: null, container: false, publishedHost: host, publicUrl: null };
  const asked = env.ORBIT_CONTAINER?.trim() === '1';
  if (asked && WILDCARD_HOSTS.has(host) && inContainer()) {
    return { tls: null, container: true, publishedHost: '127.0.0.1', publicUrl: null };
  }
  if (asked && WILDCARD_HOSTS.has(host)) {
    throw refuse(
      `ORBIT_CONTAINER=1 is set, but this is not a container (got ORBIT_HOST=${host})`,
      'Outside a container orbitd listens on loopback only: use ORBIT_HOST=127.0.0.1. Hosted mode (TLS + OIDC) serves other machines.',
    );
  }
  throw refuse(
    `orbitd only listens on loopback in local mode (got ORBIT_HOST=${host})`,
    asked
      ? 'Inside a container use ORBIT_HOST=0.0.0.0 (or ::) and publish the port to the host loopback only (127.0.0.1:7420:7420).'
      : 'The local API is plain HTTP with a bearer token: use 127.0.0.1. Inside a container set ORBIT_CONTAINER=1 with ORBIT_HOST=0.0.0.0; for other machines use hosted mode (TLS + OIDC).',
  );
}

/**
 * Where the built App lives: `ORBIT_APP_DIR`, else `apps/orbit-app/dist` of
 * this checkout (the packaged layout arrives in M8).
 */
export function appDir(env: Env): string {
  return resolve(env.ORBIT_APP_DIR ?? join(import.meta.dirname, '../../orbit-app/dist'));
}

export interface Daemon {
  url: string;
  /** The port orbitd listens on (with ORBIT_PORT=0, the one it was given). */
  port: number;
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
 * The orbitd composition root: config → listen rules → database → service
 * → HTTP(S) server with a fresh bearer token. orbitd is the single writer of
 * the Orbit database while it runs.
 */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const config = loadConfig(opts.env);
  const plan = planListen(config, opts.env, opts.inContainer);
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
      listen: { tls: plan.tls !== null, container: plan.container },
      ...opts.service,
    });
    service.redactor.addSecret(token);
    const envClientSecret = opts.env.ORBIT_OIDC_CLIENT_SECRET?.trim() ?? '';
    const clientSecretFromEnv = envClientSecret === '' ? null : envClientSecret;
    if (clientSecretFromEnv !== null) service.redactor.addSecret(clientSecretFromEnv);

    let port = opts.port ?? config.api.port;
    // Loopback names always; hosted mode adds the public host (DNS-rebinding guard).
    const hosts = () => [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      ...(plan.publicUrl !== null ? [new URL(plan.publicUrl).host] : []),
    ];
    let stopping: Promise<void> | null = null;
    // App sign-ins live in memory: a restart (new token) signs every browser out.
    const sessions = new SessionStore();
    const oidcConfig = config.mode === 'hosted' ? config.hosted.oidc : null;
    const oidc =
      plan.publicUrl !== null && oidcConfig !== null
        ? new OidcSignIn({
            issuer: oidcConfig.issuer,
            clientId: oidcConfig.clientId,
            // Read per sign-in: `orbit secret set oidc_client_secret` needs no restart.
            clientSecret: () => service.vault.get(OIDC_CLIENT_SECRET) ?? clientSecretFromEnv,
            scopes: oidcConfig.scopes,
            redirectUri: `${plan.publicUrl}${OIDC_CALLBACK_PATH}`,
            principals: () => config.principals,
          })
        : null;
    const app = createApp({
      service,
      token,
      allowedHosts: hosts,
      allowedOrigins: config.api.allowedOrigins,
      sessions,
      appRoot: appDir(opts.env),
      hosted:
        plan.publicUrl !== null
          ? { publicUrl: plan.publicUrl, oidc, tls: plan.tls !== null }
          : null,
      // The bin exits the process; embedded daemons (tests) just stop.
      onStop: () => (opts.onStopRequested ? opts.onStopRequested() : void stop()),
    });
    const server = await new Promise<Server>((resolve, reject) => {
      const s = serve(
        {
          fetch: app.fetch,
          hostname: config.api.host,
          port,
          ...(plan.tls
            ? {
                createServer: createHttpsServer,
                serverOptions: { cert: plan.tls.cert, key: plan.tls.key, minVersion: 'TLSv1.2' },
              }
            : {}),
        },
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
    // The address clients on this machine use: the loopback port (127.0.0.1
    // for a container bind), or with in-process TLS the public URL, the name
    // the certificate is for.
    const published = plan.publishedHost.includes(':')
      ? `[${plan.publishedHost.replace(/^\[|\]$/g, '')}]`
      : plan.publishedHost;
    const url =
      plan.tls !== null && plan.publicUrl !== null ? plan.publicUrl : `http://${published}:${port}`;
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
        sessions.clear();
        server.close();
        // SSE clients hold connections open; the daemon is going away anyway.
        server.closeAllConnections();
        await service.stop();
        db.close();
        cleanup();
      })());
    return { url, port, config, service, stop };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Is a daemon for this home answering on its published address? */
export function daemonInfoExists(home: string): boolean {
  return existsSync(daemonFiles(home).info);
}
