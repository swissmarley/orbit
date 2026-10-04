import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type ClientOptions, OrbitClient } from './client';

/** Files orbitd keeps in $ORBIT_HOME (all 0600). */
export function daemonFiles(home: string) {
  return {
    /** Where the running daemon listens: written after listen, removed on exit. */
    info: join(home, 'daemon.json'),
    /** Bearer token for the local API (random, regenerated per daemon start). */
    token: join(home, 'daemon.token'),
    /** Exclusive lock: one daemon per ORBIT_HOME. */
    lock: join(home, 'daemon.lock'),
    log: join(home, 'logs', 'orbitd.log'),
  };
}

export const DaemonInfo = z.object({
  pid: z.int(),
  url: z.string(),
  startedAt: z.string(),
  version: z.string(),
});
export type DaemonInfo = z.infer<typeof DaemonInfo>;

export function readDaemonInfo(home: string): DaemonInfo | null {
  const files = daemonFiles(home);
  if (!existsSync(files.info)) return null;
  try {
    const parsed = DaemonInfo.safeParse(JSON.parse(readFileSync(files.info, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Client for the daemon of this ORBIT_HOME, or null when none has published its address. */
export function localClient(
  home: string,
  options: Omit<ClientOptions, 'baseUrl' | 'token'> = {},
): OrbitClient | null {
  const info = readDaemonInfo(home);
  const files = daemonFiles(home);
  if (!info || !existsSync(files.token)) return null;
  const token = readFileSync(files.token, 'utf8').trim();
  return new OrbitClient({ ...options, baseUrl: info.url, token });
}
