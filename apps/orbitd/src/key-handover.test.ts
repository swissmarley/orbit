import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localClient, readDaemonInfo } from '@orbit/sdk-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon } from './daemon';
import { receiveApiKey, reexecWithoutKey } from './key-handover';

const REPO = resolve(import.meta.dirname, '../../..');
const KEY = 'sk-ant-api03-HANDOVER-0000000000';
const linuxProc = process.platform === 'linux' && existsSync('/proc/self/environ');

/** The NUL-separated environment of a live process (Linux). */
const environOf = (pid: number) => readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');

describe("the API key stays out of orbitd's process environment", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orbitd-key-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const env = (extra: Record<string, string> = {}) => ({
    ORBIT_HOME: home,
    ORBIT_DRIVER: 'mock',
    ORBIT_PORT: '0',
    PATH: process.env.PATH ?? '',
    HOME: home,
    ...extra,
  });

  /** Start the real bin as a process; returns its client once it listens. */
  async function runBin(e: Record<string, string>, stdin?: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/orbitd/src/bin.ts'], {
      cwd: REPO,
      env: e,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    for (let i = 0; i < 300 && !readDaemonInfo(home); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const client = localClient(home);
    expect(client, stderr).not.toBeNull();
    return { child, client: client!, exited, stderr: () => stderr };
  }

  it.skipIf(!linuxProc)(
    're-executes itself (same PID) without ANTHROPIC_API_KEY; the key arrives on a pipe',
    async () => {
      const { child, client, exited, stderr } = await runBin(env({ ANTHROPIC_API_KEY: KEY }));
      try {
        expect((await client.health()).pid).toBe(child.pid);
        // What any process of the same user can read: no key, only the handover's name.
        const environ = environOf(child.pid!);
        expect(environ.join('\n')).not.toContain(KEY);
        expect(environ.some((v) => v.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
        const holder = environ.find((v) => v.startsWith('ORBIT_API_KEY_HANDOVER='));
        expect(holder).toMatch(/^ORBIT_API_KEY_HANDOVER=pid:\d+$/);
        // orbitd still has the key (the resolver sees an API key) and does not warn.
        const doctor = await client.doctor();
        expect(doctor.apiCredential).toBe('api_key');
        expect(doctor.warnings.map((w) => w.code)).not.toContain('api_key_in_environment');
        // The helper that held the pipe is gone.
        const holderPid = Number(holder!.split(':')[1]);
        // (Gone, or a zombie where PID 1 does not reap orphans, as in some sandboxes.)
        const state = () => {
          try {
            return readFileSync(`/proc/${holderPid}/stat`, 'utf8').replace(/^.*\) /s, '')[0];
          } catch {
            return 'gone';
          }
        };
        for (let i = 0; i < 50 && !['gone', 'Z', 'X'].includes(state() ?? ''); i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(['gone', 'Z', 'X']).toContain(state());
        expect(stderr()).not.toContain(KEY);
      } finally {
        await client.stopDaemon();
        expect(await exited).toBe(0);
      }
    },
    30_000,
  );

  it.skipIf(!linuxProc)(
    'takes the key on standard input (how the orbit CLI starts it)',
    async () => {
      const { child, client, exited } = await runBin(
        env({ ORBIT_API_KEY_HANDOVER: 'stdin' }),
        `${KEY}\n`,
      );
      try {
        expect(environOf(child.pid!).join('\n')).not.toContain(KEY);
        expect((await client.doctor()).apiCredential).toBe('api_key');
      } finally {
        await client.stopDaemon();
        await exited;
      }
    },
    30_000,
  );

  it('ORBIT_API_KEY_FILE: orbitd reads the key from a 0600 file; no environment holds it', async () => {
    const file = join(home, 'anthropic-api-key');
    writeFileSync(file, `${KEY}\n`);
    chmodSync(file, 0o600);
    const source = env({ ORBIT_API_KEY_FILE: file });
    const daemon = await startDaemon({
      env: source,
      port: 0,
      log: () => undefined,
      service: { vaultKeySource: 'file' },
    });
    try {
      expect(source).not.toHaveProperty('ANTHROPIC_API_KEY');
      const doctor = await localClient(home)!.doctor();
      expect(doctor.apiCredential).toBe('api_key');
      expect(doctor.warnings.map((w) => w.code)).not.toContain('api_key_in_environment');
      expect(daemon.service.redactor.redactString(`k=${KEY}`)).not.toContain(KEY);
    } finally {
      await daemon.stop();
    }
  });

  it('a key left in the environment (no re-exec possible) is reported by doctor', async () => {
    const daemon = await startDaemon({
      env: env({ ANTHROPIC_API_KEY: KEY }),
      port: 0,
      log: () => undefined,
      service: { vaultKeySource: 'file' },
    });
    try {
      const doctor = await localClient(home)!.doctor();
      const warning = doctor.warnings.find((w) => w.code === 'api_key_in_environment');
      expect(warning?.message).toMatch(/ORBIT_API_KEY_FILE/);
      expect(warning?.message).not.toContain(KEY);
    } finally {
      await daemon.stop();
    }
  });

  it('does not re-execute off Linux or without process.execve, and never without a key', async () => {
    const execve = () => {
      throw new Error('must not exec');
    };
    const log = () => undefined;
    const base = { env: { ANTHROPIC_API_KEY: KEY }, execve, hasProc: () => true };
    await expect(reexecWithoutKey(log, { ...base, platform: 'darwin' })).resolves.toBe(false);
    await expect(
      reexecWithoutKey(log, { ...base, platform: 'linux', execve: undefined }),
    ).resolves.toBe(false);
    await expect(reexecWithoutKey(log, { ...base, platform: 'linux', env: {} })).resolves.toBe(
      false,
    );
    await expect(
      reexecWithoutKey(log, {
        ...base,
        platform: 'linux',
        env: { ANTHROPIC_API_KEY: KEY, ORBIT_API_KEY_HANDOVER: 'stdin' },
      }),
    ).resolves.toBe(false);
  });

  it('refuses a handover that does not name a pipe (a terminal, a stranger process)', () => {
    expect(() => receiveApiKey({ ORBIT_API_KEY_HANDOVER: 'file:/etc/passwd' })).toThrow(
      /must be "stdin" or "pid:<n>"/,
    );
    // This test process is not a key holder.
    expect(() => receiveApiKey({ ORBIT_API_KEY_HANDOVER: `pid:${process.pid}` })).toThrow(
      /is not Orbit's key holder/,
    );
    expect(receiveApiKey({ PATH: '/bin' })).toEqual({ env: { PATH: '/bin' }, handedOver: false });
  });
});
