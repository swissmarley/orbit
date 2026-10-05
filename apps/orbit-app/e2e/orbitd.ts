import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const BIN = join(ROOT, 'apps/orbitd/src/bin.ts');

export interface Orbitd {
  url: string;
  home: string;
  /** Call the API with the bearer token (what the CLI does). */
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** A one-time sign-in link, as `orbit app` prints it. */
  signInUrl(): Promise<string>;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A real orbitd on a free loopback port (ORBIT_PORT=0) with the mock driver
 * and a throwaway ORBIT_HOME, serving the built App. Its environment is an
 * explicit allowlist (never process.env wholesale), and stop() always stops it.
 */
export async function startOrbitd(extraEnv: Record<string, string> = {}): Promise<Orbitd> {
  const home = mkdtempSync(join(tmpdir(), 'orbit-e2e-'));
  const tsx = createRequire(join(ROOT, 'apps/orbit-tui/package.json')).resolve('tsx');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? home,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TZ: process.env.TZ ?? 'UTC',
    ORBIT_HOME: home,
    ORBIT_PORT: '0',
    ORBIT_DRIVER: 'mock',
    ...extraEnv,
  };
  const child: ChildProcess = spawn(process.execPath, ['--import', tsx, BIN], {
    env,
    cwd: home,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  const info = join(home, 'daemon.json');
  for (let i = 0; i < 300 && !existsSync(info); i++) {
    if (child.exitCode !== null) throw new Error(`orbitd exited: ${stderr}`);
    await sleep(100);
  }
  if (!existsSync(info)) throw new Error(`orbitd did not start: ${stderr}`);
  const { url } = JSON.parse(readFileSync(info, 'utf8')) as { url: string };
  const token = readFileSync(join(home, 'daemon.token'), 'utf8').trim();
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(url + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  return {
    url,
    home,
    api,
    async signInUrl() {
      const { ticket } = await api<{ ticket: string }>('POST', '/v1/session/tickets');
      return `${url}/login#ticket=${ticket}`;
    },
    async stop() {
      const running = () => child.exitCode === null;
      if (running()) {
        await api('POST', '/v1/daemon/stop').catch(() => undefined);
        for (let i = 0; i < 50 && running(); i++) await sleep(100);
        if (running()) child.kill('SIGKILL');
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
