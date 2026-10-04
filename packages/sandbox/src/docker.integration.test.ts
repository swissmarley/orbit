import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeBot } from '../test/helpers';
import { SandboxManager } from './manager';
import { defaultRunner } from './runner';
import type { SpawnedProcess, SpawnOptions, Workspace } from './types';

/** Environment for the docker CLI in these tests (no credentials). */
const clientEnv: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
if (process.env.HOME !== undefined) clientEnv.HOME = process.env.HOME;
if (process.env.DOCKER_HOST !== undefined) clientEnv.DOCKER_HOST = process.env.DOCKER_HOST;

const dockerAvailable =
  spawnSync('docker', ['info'], { env: clientEnv, stdio: 'ignore', timeout: 20_000 }).status === 0;

const IMAGE = 'node:22-bookworm-slim';
const TIMEOUT = 60_000;

function docker(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { env: clientEnv, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function inspect(container: string): {
  Id: string;
  State: { Running: boolean };
  Config: { Env: string[]; Labels: Record<string, string> };
  HostConfig: {
    NetworkMode: string;
    Memory: number;
    PidsLimit: number;
    NanoCpus: number;
    CapDrop: string[];
    SecurityOpt: string[];
    ReadonlyRootfs: boolean;
  };
} {
  const r = docker('inspect', '--type', 'container', container);
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as ReturnType<typeof inspect>[])[0]!;
}

function collect(child: SpawnedProcess): Promise<{ code: number | null; stdout: string }> {
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => (stdout += c));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      // Let buffered stdout drain before resolving.
      setImmediate(() => {
        resolve({ code, stdout });
      });
    });
  });
}

const spawnOptions = (args: string[], signal = new AbortController().signal): SpawnOptions => ({
  command: 'node',
  args,
  cwd: '/host/path/that/does/not/exist/in/the/container',
  env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
  signal,
});

const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-sandbox-docker-')));
const created = new Set<string>();

afterAll(() => {
  for (const name of created) docker('rm', '-f', name);
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!dockerAvailable)('SandboxManager — docker (real daemon)', () => {
  const suffix = randomUUID().slice(0, 8);
  const manager = new SandboxManager({
    orbitHome: join(root, 'orbit'),
    home: join(root, 'home'),
    run: defaultRunner(clientEnv),
    dockerClientEnv: clientEnv,
  });
  const bot = makeBot(
    {
      name: `it docker ${suffix}`,
      sandbox: { kind: 'docker', image: IMAGE, cpus: 1, memoryMb: 256, pidsLimit: 64 },
    },
    `bot_it_${suffix}`,
  );
  const container = SandboxManager.containerName(bot);
  created.add(container);
  let ws: Workspace;

  it(
    'creates a resource-limited, unprivileged, offline container',
    async () => {
      ws = await manager.prepare(bot, 'sdk');
      expect(ws).toMatchObject({
        kind: 'docker',
        isolation: 'container',
        shellContained: false,
        docker: { container, workdir: '/workspace' },
      });
      const info = inspect(container);
      expect(info.State.Running).toBe(true);
      expect(info.HostConfig.NetworkMode).toBe('none');
      expect(info.HostConfig.Memory).toBe(256 * 1024 * 1024);
      expect(info.HostConfig.PidsLimit).toBe(64);
      expect(info.HostConfig.NanoCpus).toBe(1e9);
      expect(info.HostConfig.CapDrop).toEqual(['ALL']);
      expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
      expect(info.Config.Labels['orbit.bot']).toBe(bot.id);
    },
    TIMEOUT,
  );

  it(
    'reuses the running container and restarts a stopped one',
    async () => {
      const id = inspect(container).Id;
      await manager.prepare(bot, 'sdk');
      expect(inspect(container).Id).toBe(id);

      expect(docker('kill', container).status).toBe(0);
      expect(inspect(container).State.Running).toBe(false);
      await manager.prepare(bot, 'mock');
      const after = inspect(container);
      expect(after.Id).toBe(id);
      expect(after.State.Running).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'runs the engine command via docker exec with the forwarded environment',
    async () => {
      const probe = `probe-${randomUUID()}`;
      const spawnEngine = manager.engineSpawner(ws, { ORBIT_PROBE: probe, PATH: '/host/only' });
      const child = spawnEngine(
        spawnOptions([
          '-e',
          'console.log(process.env.ORBIT_PROBE, require("fs").existsSync("/workspace"), process.cwd(), process.env.CLAUDE_CODE_ENTRYPOINT, process.env.PATH.includes("/host/only"))',
        ]),
      );
      child.stdin.end();
      const r = await collect(child);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(`${probe} true /workspace sdk-ts false`);
    },
    TIMEOUT,
  );

  it(
    'the workspace bind mount is writable by the engine and visible on the host',
    async () => {
      const child = manager.engineSpawner(
        ws,
        {},
      )(
        spawnOptions([
          '-e',
          'require("fs").writeFileSync("/workspace/hello.txt", "from container")',
        ]),
      );
      child.stdin.end();
      expect((await collect(child)).code).toBe(0);
      expect(readFileSync(join(ws.path, 'hello.txt'), 'utf8')).toBe('from container');
    },
    TIMEOUT,
  );

  it(
    'secret values never appear in ps or in the container config',
    async () => {
      const secret = `secret-${randomUUID()}`;
      const child = manager.engineSpawner(ws, { ORBIT_PROBE: secret })(
        spawnOptions([
          '-e',
          'console.log(process.env.ORBIT_PROBE === undefined ? "missing" : "present"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0))',
        ]),
      );
      const done = collect(child);
      // Wait until the engine is up, then look at the process tables.
      await new Promise<void>((resolve) => {
        child.stdout.once('data', () => {
          resolve();
        });
      });
      const hostPs = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8', env: clientEnv });
      expect(hostPs.status).toBe(0);
      expect(hostPs.stdout).toContain('ORBIT_PROBE');
      expect(hostPs.stdout).not.toContain(secret);
      const top = docker('top', container, '-eo', 'pid,args');
      expect(top.status).toBe(0);
      expect(top.stdout).not.toContain(secret);
      expect(inspect(container).Config.Env.join('\n')).not.toContain(secret);

      child.stdin.end();
      const r = await done;
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('present');
    },
    TIMEOUT,
  );

  it(
    'has no network',
    async () => {
      const child = manager.engineSpawner(
        ws,
        {},
      )(
        spawnOptions([
          '-e',
          'require("dns").lookup("example.com", (err) => { console.log(err ? "offline" : "online"); })',
        ]),
      );
      child.stdin.end();
      const r = await collect(child);
      expect(r.stdout.trim()).toBe('offline');
    },
    TIMEOUT,
  );

  it(
    'abort stops the engine process inside the container',
    async () => {
      const marker = `orbit-abort-${randomUUID().slice(0, 8)}`;
      const ac = new AbortController();
      const child = manager.engineSpawner(
        ws,
        {},
      )(
        spawnOptions(
          ['-e', `process.title = "${marker}"; setInterval(() => {}, 1000); console.log("up")`],
          ac.signal,
        ),
      );
      const done = collect(child);
      await new Promise<void>((resolve) => {
        child.stdout.once('data', () => {
          resolve();
        });
      });
      expect(docker('top', container, '-eo', 'pid,args').stdout).toContain(marker);
      ac.abort();
      await done;
      // The in-container process must not outlive the aborted client.
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        alive = docker('top', container, '-eo', 'pid,args').stdout.includes(marker);
        if (alive) await new Promise((r) => setTimeout(r, 100));
      }
      expect(alive).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'destroy removes the container and keeps the workspace unless purged',
    async () => {
      await manager.destroy(bot);
      expect(docker('inspect', '--type', 'container', container).status).not.toBe(0);
      expect(existsSync(ws.path)).toBe(true);
      await manager.destroy(bot, { purge: true });
      expect(existsSync(ws.path)).toBe(false);
    },
    TIMEOUT,
  );
});
