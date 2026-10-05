import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { type IncomingHttpHeaders, createServer } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeBot } from '../test/helpers';
import { CONTAINER_SOCKET_DIR, SandboxManager } from './manager';
import { staticApiKey } from './proxy/key-source';
import { defaultRunner } from './runner';
import type { SpawnedProcess, SpawnOptions, Workspace } from './types';

/** Environment for the docker CLI in these tests (no credentials). */
const clientEnv: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
if (process.env.HOME !== undefined) clientEnv.HOME = process.env.HOME;
if (process.env.DOCKER_HOST !== undefined) clientEnv.DOCKER_HOST = process.env.DOCKER_HOST;

const dockerAvailable =
  spawnSync('docker', ['info'], { env: clientEnv, stdio: 'ignore', timeout: 20_000 }).status === 0;

/**
 * The real sandbox image (docker/sandbox.Dockerfile) installs Claude Code,
 * which takes minutes; these tests need only node and socat. The tag is
 * derived from the Dockerfile text, so a rebuild happens only when it changes.
 */
const TEST_DOCKERFILE = [
  'FROM node:22-bookworm-slim',
  'RUN apt-get update && apt-get install -y --no-install-recommends socat && rm -rf /var/lib/apt/lists/*',
].join('\n');
const IMAGE = `orbit-sandbox-test:${createHash('sha256').update(TEST_DOCKERFILE).digest('hex').slice(0, 12)}`;
const TIMEOUT = 60_000;

/** The API key orbitd holds. It must never be visible inside a container. */
const SECRET_KEY = `sk-ant-api03-INTEGRATION-${randomUUID()}`;

function docker(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { env: clientEnv, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function inspect(container: string): {
  Id: string;
  State: { Running: boolean };
  Config: { Env: string[]; Labels: Record<string, string>; Cmd: string[] };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
  HostConfig: {
    NetworkMode: string;
    Memory: number;
    PidsLimit: number;
    NanoCpus: number;
    CapDrop: string[];
    SecurityOpt: string[];
    Init: boolean | null;
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

/** Run a node script inside the Bot's container the way the engine runs. */
async function inContainer(
  manager: SandboxManager,
  ws: Workspace,
  script: string,
  args: string[] = [],
  engineEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string }> {
  const child = manager.engineSpawner(ws, engineEnv)(spawnOptions(['-e', script, ...args]));
  child.stdin.end();
  return collect(child);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-sbx-')));
const created = new Set<string>();
const closers: (() => Promise<void> | void)[] = [];

/** The Anthropic API as the host-side key proxy sees it: records what arrives. */
const apiSeen: IncomingHttpHeaders[] = [];
const api = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    apiSeen.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[]}');
  });
});
/** A host service the allowlisted Bot may reach through the egress proxy. */
const echo = createNetServer((s) => {
  s.on('data', (d) => s.write(`echo:${d.toString()}`));
  s.on('error', () => undefined);
});
let apiBase = '';
let echoPort = 0;

beforeAll(async () => {
  if (!dockerAvailable) return;
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  echoPort = (echo.address() as AddressInfo).port;
  if (docker('image', 'inspect', IMAGE).status !== 0) {
    const r = spawnSync('docker', ['build', '-t', IMAGE, '-'], {
      env: clientEnv,
      input: TEST_DOCKERFILE,
      encoding: 'utf8',
      timeout: 300_000,
    });
    expect(r.status, r.stderr).toBe(0);
  }
}, 320_000);

afterAll(async () => {
  for (const close of closers) await close();
  for (const name of created) docker('rm', '-f', name);
  api.close();
  echo.close();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!dockerAvailable)('SandboxManager — docker (real daemon)', () => {
  const suffix = randomUUID().slice(0, 8);
  let manager: SandboxManager;
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

  beforeAll(() => {
    manager = new SandboxManager({
      orbitHome: join(root, 'orbit'),
      home: join(root, 'home'),
      run: defaultRunner(clientEnv),
      dockerClientEnv: clientEnv,
      credential: { kind: 'key', source: staticApiKey(SECRET_KEY) },
      apiUpstream: apiBase,
    });
    closers.push(() => manager.close());
  });

  it(
    'creates a resource-limited, unprivileged container with no network but its proxy sockets',
    async () => {
      ws = await manager.prepare(bot, 'sdk');
      expect(ws).toMatchObject({
        kind: 'docker',
        isolation: 'container',
        // No network and no key inside: Bash counts as sandboxed (ADR-018).
        shellContained: true,
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
      expect(info.HostConfig.Init).toBe(true);
      expect(info.Config.Labels['orbit.bot']).toBe(bot.id);
      expect(info.Config.Labels['orbit.config']).toBe(manager.containerConfigHash(bot, ws.path));
      expect(info.Mounts).toContainEqual(
        expect.objectContaining({
          Source: manager.socketDir(bot),
          Destination: CONTAINER_SOCKET_DIR,
          RW: false,
        }),
      );
    },
    TIMEOUT,
  );

  it(
    'the API key never enters the container; the engine reaches the API through the key proxy',
    async () => {
      apiSeen.length = 0;
      // Even if the host env carried the key, the spawner never forwards it.
      const r = await inContainer(
        manager,
        ws,
        `(async () => {
          const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY },
            body: JSON.stringify({ model: 'sonnet', max_tokens: 1, messages: [] }),
          });
          const files = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/files', { method: 'POST', body: '{}' });
          console.log(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY, status: res.status, files: files.status }));
        })()`,
        [],
        { ANTHROPIC_API_KEY: SECRET_KEY },
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual({
        key: 'orbit-key-proxy-placeholder',
        status: 200,
        files: 403,
      });
      // The real key was injected on the host, after the container's request left it.
      expect(apiSeen).toHaveLength(1);
      expect(apiSeen[0]?.['x-api-key']).toBe(SECRET_KEY);

      // Nowhere in the container: no process environment, file or the container config.
      const scan = await inContainer(
        manager,
        ws,
        `const fs = require('fs');
        // Passed reversed, so this process's own command line does not match.
        const needle = process.argv[1].split('').reverse().join('');
        let hits = 0;
        for (const pid of fs.readdirSync('/proc').filter((p) => /^\\d+$/.test(p))) {
          try { if (fs.readFileSync('/proc/' + pid + '/environ').includes(needle)) hits++; } catch {}
          try { if (fs.readFileSync('/proc/' + pid + '/cmdline').includes(needle)) hits++; } catch {}
        }
        const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = d + '/' + e.name;
          try { if (e.isDirectory()) walk(p); else if (e.isFile() && fs.readFileSync(p).includes(needle)) hits++; } catch {}
        } };
        for (const d of ['/workspace', '/tmp', '/etc']) walk(d);
        console.log(hits, fs.readFileSync('/proc/1/environ', 'utf8').includes('ANTHROPIC_API_KEY'));`,
        [SECRET_KEY.slice(-24).split('').reverse().join('')],
      );
      expect(scan.stdout.trim()).toBe('0 false');
      expect(docker('inspect', container).stdout).not.toContain(SECRET_KEY.slice(-24));
    },
    TIMEOUT,
  );

  it(
    'cannot reach the network directly',
    async () => {
      const r = await inContainer(
        manager,
        ws,
        `const net = require('net');
        require('dns').lookup('example.com', (err) => {
          const s = net.connect(443, '1.1.1.1');
          s.on('connect', () => { console.log(err ? 'dns-offline' : 'dns-online', 'tcp-online'); process.exit(0); });
          s.on('error', (e) => { console.log(err ? 'dns-offline' : 'dns-online', 'tcp-' + e.code); process.exit(0); });
        });`,
      );
      expect(r.stdout.trim()).toMatch(/^dns-offline tcp-(ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)$/);
    },
    TIMEOUT,
  );

  it(
    'reuses the running container and restarts a stopped one',
    async () => {
      const id = inspect(container).Id;
      (await manager.prepare(bot, 'sdk')).release?.();
      expect(inspect(container).Id).toBe(id);

      expect(docker('kill', container).status).toBe(0);
      expect(inspect(container).State.Running).toBe(false);
      (await manager.prepare(bot, 'mock')).release?.();
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
      const r = await inContainer(
        manager,
        ws,
        'console.log(process.env.ORBIT_PROBE, require("fs").existsSync("/workspace"), process.cwd(), process.env.CLAUDE_CODE_ENTRYPOINT, process.env.PATH.includes("/host/only"))',
        [],
        { ORBIT_PROBE: probe, PATH: '/host/only' },
      );
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(`${probe} true /workspace sdk-ts false`);
    },
    TIMEOUT,
  );

  it(
    'the workspace bind mount is writable by the engine and visible on the host',
    async () => {
      const r = await inContainer(
        manager,
        ws,
        'require("fs").writeFileSync("/workspace/hello.txt", "from container")',
      );
      expect(r.code).toBe(0);
      expect(readFileSync(join(ws.path, 'hello.txt'), 'utf8')).toBe('from container');
    },
    TIMEOUT,
  );

  it(
    'the proxy sockets cannot be replaced from inside the container',
    async () => {
      const r = await inContainer(
        manager,
        ws,
        `const fs = require('fs');
        try { fs.unlinkSync('${CONTAINER_SOCKET_DIR}/api.sock'); console.log('removed'); }
        catch (e) { console.log(e.code); }`,
      );
      expect(r.stdout.trim()).toMatch(/^(EROFS|EACCES|EPERM)$/);
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
    'after the Run ends the key proxy refuses; a changed limit recreates the container',
    async () => {
      ws.release?.();
      const idle = await new Promise<number>((resolve) => {
        // No lease: even a well-formed request from the container is refused.
        void inContainer(
          manager,
          ws,
          `fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', body: '{"messages":[]}' })
            .then((r) => console.log(r.status), () => console.log(0))`,
        ).then((r) => resolve(Number(r.stdout.trim())));
      });
      expect(idle).toBe(403);

      const id = inspect(container).Id;
      const bigger = {
        ...bot,
        spec: { ...bot.spec, sandbox: { ...bot.spec.sandbox, memoryMb: 384 } },
      };
      ws = await manager.prepare(bigger, 'sdk');
      const after = inspect(container);
      expect(after.Id).not.toBe(id);
      expect(after.HostConfig.Memory).toBe(384 * 1024 * 1024);
      expect(existsSync(join(ws.path, 'hello.txt'))).toBe(true); // the workspace survives
      ws.release?.();
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

describe.skipIf(!dockerAvailable)('SandboxManager — docker egress allowlist (real daemon)', () => {
  const suffix = randomUUID().slice(0, 8);
  let manager: SandboxManager;
  let bot: ReturnType<typeof makeBot>;
  let ws: Workspace;

  beforeAll(() => {
    manager = new SandboxManager({
      orbitHome: join(root, 'orbit-egress'),
      home: join(root, 'home'),
      run: defaultRunner(clientEnv),
      dockerClientEnv: clientEnv,
      credential: { kind: 'key', source: staticApiKey(SECRET_KEY) },
      apiUpstream: apiBase,
      // echo.orbit.test resolves to the host's loopback echo service.
      proxy: { lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]) },
    });
    closers.push(() => manager.close());
    bot = makeBot(
      {
        name: `it egress ${suffix}`,
        sandbox: {
          kind: 'docker',
          image: IMAGE,
          network: 'allowlist',
          // The loopback literal is allowlisted too, so the checked address may be used.
          allowedDomains: [`echo.orbit.test:${echoPort}`, `127.0.0.1:${echoPort}`],
        },
      },
      `bot_eg_${suffix}`,
    );
    created.add(SandboxManager.containerName(bot));
  });

  it(
    'reaches only allowlisted hosts, only through the egress socket',
    async () => {
      ws = await manager.prepare(bot, 'sdk');
      expect(ws.shellContained).toBe(false); // with an allowlist Bash stays EXTERNAL
      expect(inspect(SandboxManager.containerName(bot)).HostConfig.NetworkMode).toBe('none');
      const r = await inContainer(
        manager,
        ws,
        `const net = require('net');
        const proxy = new URL(process.env.HTTPS_PROXY);
        const tunnel = (target) => new Promise((resolve) => {
          const s = net.connect(Number(proxy.port), proxy.hostname, () =>
            s.write('CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\n\\r\\n'));
          let head = '';
          s.on('data', (d) => {
            if (head.includes('\\r\\n\\r\\n')) { resolve('200:' + d.toString()); s.destroy(); return; }
            head += d.toString();
            if (!head.includes('\\r\\n\\r\\n')) return;
            const status = head.split(' ')[1];
            if (status === '200') s.write('ping'); else { resolve(status); s.destroy(); }
          });
          s.on('error', (e) => resolve('error:' + e.code));
        });
        (async () => {
          const allowed = await tunnel('echo.orbit.test:' + process.argv[1]);
          const other = await tunnel('example.org:443');
          const otherPort = await tunnel('echo.orbit.test:22');
          const direct = await new Promise((resolve) => {
            const s = net.connect(Number(process.argv[1]), '127.0.0.1');
            s.on('connect', () => { resolve('connected'); s.destroy(); });
            s.on('error', (e) => resolve(e.code));
          });
          console.log(JSON.stringify({ allowed, other, otherPort, direct }));
        })();`,
        [String(echoPort)],
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual({
        allowed: '200:echo:ping',
        other: '403',
        otherPort: '403',
        // The container's own loopback has nothing on the host's port.
        direct: 'ECONNREFUSED',
      });
      const [status] = manager.proxyStatus();
      expect(status).toMatchObject({ network: 'allowlist', egress: { forwarded: 1, refused: 2 } });
      expect(status?.egress?.recent.map((x) => x.target)).toEqual([
        'example.org:443',
        'echo.orbit.test:22',
      ]);
      ws.release?.();
      await manager.destroy(bot, { purge: true });
    },
    TIMEOUT,
  );
});
