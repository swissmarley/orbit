import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { daemonFiles, localClient, readDaemonInfo } from '@orbit/sdk-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from './daemon';

const REPO = resolve(import.meta.dirname, '../../..');

describe('orbitd', () => {
  let home: string;
  let daemon: Daemon | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orbitd-'));
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => ({
    ORBIT_HOME: home,
    ORBIT_DRIVER: 'mock',
    PATH: process.env.PATH ?? '',
    ...extra,
  });
  const start = (extra: Record<string, string> = {}) =>
    startDaemon({
      env: env(extra),
      port: 0,
      log: () => undefined,
      service: { vaultKeySource: 'file' },
    });

  it('listens on loopback, publishes its address and a private token, and serves clients', async () => {
    daemon = await start();
    expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const files = daemonFiles(home);
    for (const f of [files.info, files.token, files.lock]) {
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
    expect(readDaemonInfo(home)).toMatchObject({ pid: process.pid, url: daemon.url });
    const client = localClient(home)!;
    expect((await client.health()).ok).toBe(true);
    const doctor = await client.doctor();
    expect(doctor.daemon).toMatchObject({ url: daemon.url, pid: process.pid });
    // The token never shows up in anything Orbit records.
    const token = readFileSync(files.token, 'utf8').trim();
    expect(daemon.service.redactor.redactString(`t=${token}`)).not.toContain(token);
  });

  it('refuses a second daemon for the same home, and takes over a stale lock', async () => {
    daemon = await start();
    await expect(start()).rejects.toMatchObject({ code: 'blocked', message: /already running/ });
    await daemon.stop();
    daemon = undefined;
    const files = daemonFiles(home);
    expect(existsSync(files.info) || existsSync(files.token) || existsSync(files.lock)).toBe(false);
    writeFileSync(files.lock, '999999999', { mode: 0o600 }); // crashed daemon
    daemon = await start();
    expect(readFileSync(files.lock, 'utf8')).toBe(String(process.pid));
  });

  it('a daemon that fails to listen leaves no token or address behind', async () => {
    daemon = await start();
    const port = new URL(daemon.url).port;
    const other = mkdtempSync(join(tmpdir(), 'orbitd-other-'));
    try {
      await expect(
        startDaemon({
          env: { ORBIT_HOME: other, ORBIT_DRIVER: 'mock', PATH: process.env.PATH ?? '' },
          port: Number(port),
          log: () => undefined,
          service: { vaultKeySource: 'file' },
        }),
      ).rejects.toMatchObject({ message: /in use/ });
      const files = daemonFiles(other);
      expect([files.token, files.info, files.lock].filter((f) => existsSync(f))).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses hosted mode and non-loopback binds (token over plain HTTP)', async () => {
    await expect(start({ ORBIT_MODE: 'hosted' })).rejects.toMatchObject({
      code: 'invalid_config',
      message: /Hosted mode/,
    });
    await expect(start({ ORBIT_HOST: '0.0.0.0' })).rejects.toMatchObject({
      message: /only listens on loopback/,
    });
    expect(existsSync(daemonFiles(home).lock)).toBe(false);
  });

  it('rejects requests that name another host (DNS rebinding)', async () => {
    daemon = await start();
    const port = new URL(daemon.url).port;
    const token = readFileSync(daemonFiles(home).token, 'utf8').trim();
    const ok = await fetch(`${daemon.url}/v1/bots`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    // fetch() will not send a forged Host header; a raw request will.
    const rebound = await new Promise<{ status: number }>((resolve, reject) => {
      const req = request(
        `${daemon!.url}/v1/bots`,
        { headers: { authorization: `Bearer ${token}`, host: `evil.example:${port}` } },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0 });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(rebound.status).toBe(403);
  });

  it('runs as a process: starts, answers, and stops on request', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/orbitd/src/bin.ts'], {
      cwd: REPO,
      env: { ...env(), ORBIT_PORT: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    for (let i = 0; i < 200 && !readDaemonInfo(home); i++)
      await new Promise((r) => setTimeout(r, 50));
    const client = localClient(home);
    expect(client, stderr).not.toBeNull();
    expect((await client!.health()).pid).toBe(child.pid);
    await client!.stopDaemon();
    expect(await exited).toBe(0);
    expect(stderr).toMatch(/listening on http:\/\/127\.0\.0\.1:/);
    expect(existsSync(daemonFiles(home).info)).toBe(false);
  }, 20_000);
});
