import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrbitError } from '@orbit/core';
import { buildChildEnv, defaultHome } from '@orbit/runtime';
import { type OrbitClient, daemonFiles, localClient, readDaemonInfo } from '@orbit/sdk-client';

const START_TIMEOUT_MS = 15_000;

/**
 * Spawn orbitd detached, logging to $ORBIT_HOME/logs/orbitd.log. Its env is
 * an allowlist ('orbitd': Orbit settings + API credentials, never OAuth
 * tokens). In the dev tree the bin is TypeScript, so tsx is preloaded.
 */
export function spawnDaemon(
  env: Record<string, string | undefined>,
  spawnFn: typeof spawn = spawn,
): void {
  const home = defaultHome(env);
  const files = daemonFiles(home);
  mkdirSync(dirname(files.log), { recursive: true, mode: 0o700 });
  const bin = fileURLToPath(import.meta.resolve('@orbit/orbitd/bin'));
  const args = bin.endsWith('.ts') ? ['--import', import.meta.resolve('tsx'), bin] : [bin];
  const log = openSync(files.log, 'a', 0o600);
  try {
    const child = spawnFn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', log, log],
      env: buildChildEnv('orbitd', env),
      cwd: home,
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** Wait until the daemon of `home` answers its health check. */
export async function waitForDaemon(
  home: string,
  timeoutMs = START_TIMEOUT_MS,
): Promise<OrbitClient> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = localClient(home);
    if (client) {
      try {
        await client.health();
        return client;
      } catch {
        // published but not answering yet (or stale): keep waiting
      }
    }
    if (Date.now() >= deadline) {
      throw new OrbitError('daemon_unavailable', 'orbitd did not start', {
        hint: `See ${daemonFiles(home).log} for why.`,
      });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A client of a running daemon, or null (no daemon.json, or it does not answer). */
export async function runningDaemon(home: string): Promise<OrbitClient | null> {
  const client = localClient(home, { timeoutMs: 3000 });
  if (!client) return null;
  try {
    await client.health();
    return client;
  } catch {
    return null;
  }
}

/** Resolve once the daemon of `home` has removed its address file. */
export async function waitForDaemonExit(home: string, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(daemonFiles(home).info) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (readDaemonInfo(home)) {
    throw new OrbitError('daemon_unavailable', 'orbitd did not stop in time');
  }
}
