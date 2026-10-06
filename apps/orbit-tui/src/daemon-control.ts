import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { OrbitError } from '@orbit/core';
import { API_KEY_HANDOVER_VAR, buildChildEnv, defaultHome, orbitLayout } from '@orbit/runtime';
import { type OrbitClient, daemonFiles, localClient, readDaemonInfo } from '@orbit/sdk-client';

const START_TIMEOUT_MS = 15_000;

/**
 * Spawn orbitd detached, logging to $ORBIT_HOME/logs/orbitd.log. Its env is
 * an allowlist ('orbitd': Orbit settings + cloud credentials, never OAuth
 * tokens); the API key goes on its standard input, never in its env. In the
 * dev tree the bin is TypeScript, so tsx is preloaded; the npm package runs
 * its bundled `dist/orbitd.mjs` directly (ADR-017).
 */
export function spawnDaemon(
  env: Record<string, string | undefined>,
  spawnFn: typeof spawn = spawn,
  args: readonly string[] = orbitLayout().orbitd.args,
): void {
  const home = defaultHome(env);
  const files = daemonFiles(home);
  mkdirSync(dirname(files.log), { recursive: true, mode: 0o700 });
  const log = openSync(files.log, 'a', 0o600);
  try {
    // The API key goes over orbitd's standard input, not its environment:
    // a process's environment stays readable to the same user for its whole
    // life (/proc/<pid>/environ), and orbitd lives long.
    const childEnv = buildChildEnv('orbitd', env);
    const key = childEnv.ANTHROPIC_API_KEY?.trim();
    Reflect.deleteProperty(childEnv, 'ANTHROPIC_API_KEY');
    if (key) childEnv[API_KEY_HANDOVER_VAR] = 'stdin';
    else Reflect.deleteProperty(childEnv, API_KEY_HANDOVER_VAR);
    const child = spawnFn(process.execPath, args, {
      detached: true,
      stdio: [key ? 'pipe' : 'ignore', log, log],
      env: childEnv,
      cwd: home,
    });
    if (key) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(`${key}\n`);
    }
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
