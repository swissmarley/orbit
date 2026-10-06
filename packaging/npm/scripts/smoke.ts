/**
 * Smoke test of the `orbit-bots` npm package (ADR-017): build it, `npm pack`
 * it, install the tarball into a throwaway prefix and drive the installed
 * `orbit` against the orbitd it auto-starts, with the MockDriver, a free port
 * and a throwaway ORBIT_HOME. No credentials, no network beyond the npm
 * install itself. The daemon is always stopped, also when a check fails.
 *
 * Usage: pnpm --filter orbit-bots smoke [--no-build] [--keep]
 */
import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toolEnv as allowlistedToolEnv } from './lib';

const PKG = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');

const tmp = mkdtempSync(join(tmpdir(), 'orbit-bots-smoke-'));
const prefix = join(tmp, 'prefix');
const home = join(tmp, 'home');
const orbitHome = join(tmp, 'orbit');
const files = join(tmp, 'files');
for (const d of [prefix, home, orbitHome, files]) mkdirSync(d, { recursive: true });

const installed = join(prefix, 'lib', 'node_modules', 'orbit-bots');
const orbitBin = join(prefix, 'bin', 'orbit');

function ok(message: string): void {
  process.stdout.write(`✓ ${message}\n`);
}

class SmokeError extends Error {}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new SmokeError(message);
}

/** npm and the build need the developer's own setup (registry, proxy) — an allowlist of it. */
const toolEnv = () => allowlistedToolEnv(process.env);

/** What the installed `orbit` sees: an allowlist, the MockDriver, no credentials at all. */
function orbitEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${join(prefix, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: home,
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    ORBIT_HOME: orbitHome,
    ORBIT_DRIVER: 'mock',
    ORBIT_PORT: '0',
  };
  for (const k of ['TMPDIR', 'TZ']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function run(
  cmd: string,
  argv: string[],
  opts: SpawnSyncOptions & { allowFail?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 300_000, ...opts });
  const out = { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  if (!opts.allowFail && r.status !== 0) {
    throw new SmokeError(
      `${cmd} ${argv.join(' ')} exited ${String(r.status)}${r.error ? ` (${r.error.message})` : ''}\n${out.stdout}\n${out.stderr}`,
    );
  }
  return out;
}

const orbit = (argv: string[], opts: { allowFail?: boolean; input?: string } = {}) =>
  run(orbitBin, argv, { env: orbitEnv(), cwd: home, timeout: 60_000, ...opts });

const orbitJson = (argv: string[]): unknown => JSON.parse(orbit([...argv, '--json']).stdout);

function daemonPid(): number | null {
  try {
    const info = JSON.parse(readFileSync(join(orbitHome, 'daemon.json'), 'utf8')) as {
      pid?: number;
    };
    return typeof info.pid === 'number' ? info.pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDaemon(): Promise<void> {
  const pid = daemonPid();
  if (existsSync(orbitBin)) {
    const r = orbit(['daemon', 'stop', '--json'], { allowFail: true });
    if (r.status !== 0) process.stderr.write(`smoke: orbit daemon stop: ${r.stdout}${r.stderr}\n`);
  }
  if (pid === null) return;
  const deadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) {
    process.kill(pid, 'SIGKILL');
    process.stderr.write(`smoke: orbitd ${pid} did not exit after daemon stop; killed it\n`);
  }
}

async function main(): Promise<void> {
  if (!args.includes('--no-build')) {
    run('pnpm', ['run', 'build'], { cwd: PKG, env: toolEnv(), stdio: 'inherit' });
  }

  // Pack exactly what `npm publish` would upload.
  const packed = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: PKG, env: toolEnv() }).stdout,
  ) as { filename: string; size: number; unpackedSize: number; files: { path: string }[] }[];
  const pack = packed[0];
  check(pack, 'npm pack printed nothing');
  const paths = pack.files.map((f) => f.path);
  for (const p of [
    'package.json',
    'LICENSE',
    'README.md',
    'dist/orbit.mjs',
    'dist/orbitd.mjs',
    'dist/orbit-hook.mjs',
    'dist/app/index.html',
    'dist/plugins/filesystem/server.mjs',
    'dist/plugins/filesystem/orbit-plugin.json',
  ]) {
    check(paths.includes(p), `the tarball lacks ${p}`);
  }
  const strays = paths.filter(
    (p) => !/^(package\.json|LICENSE|README\.md|dist\/.+)$/.test(p) || p.endsWith('.map'),
  );
  check(strays.length === 0, `the tarball holds files outside the allowlist: ${strays.join(', ')}`);
  ok(
    `npm pack: ${pack.filename} (${(pack.size / 1024 / 1024).toFixed(1)} MB, ${paths.length} files, unpacked ${(pack.unpackedSize / 1024 / 1024).toFixed(1)} MB)`,
  );

  run(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      join(tmp, pack.filename),
    ],
    { cwd: tmp, env: toolEnv(), timeout: 600_000 },
  );
  check(existsSync(orbitBin), `npm did not link ${orbitBin}`);
  check(existsSync(join(installed, 'dist', 'orbitd.mjs')), 'the installed package has no orbitd');
  check(
    !existsSync(join(installed, 'node_modules', 'tsx')),
    'tsx was installed: the package must not need it',
  );
  ok(`installed into ${prefix}`);

  // The CLI auto-starts the packaged orbitd (plain node, no tsx).
  const doctor = orbitJson(['doctor']) as {
    ok: boolean;
    driver: string;
    daemon: { pid: number; url: string } | null;
  };
  check(doctor.ok && doctor.driver === 'mock', `doctor: ${JSON.stringify(doctor)}`);
  check(doctor.daemon, 'doctor shows no daemon: the CLI did not start orbitd');
  const cmdline = `/proc/${doctor.daemon.pid}/cmdline`;
  if (existsSync(cmdline)) {
    const argv = readFileSync(cmdline, 'utf8').split('\0').filter(Boolean);
    check(
      argv.length === 2 && argv[1] === join(installed, 'dist', 'orbitd.mjs'),
      `orbitd runs as ${argv.join(' ')}`,
    );
  }
  ok(`orbit doctor --json: mock driver, orbitd ${doctor.daemon.pid} at ${doctor.daemon.url}`);

  orbitJson(['bot', 'create', '--name', 'Smoke', '--goal', 'Answer pong', '--fixture', 'pong']);
  const events = orbit(['run', 'smoke', '--json'])
    .stdout.trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string });
  check(
    events.at(-1)?.type === 'run.completed',
    `the Run ended with ${String(events.at(-1)?.type)}`,
  );
  ok(`a Bot ran to completion through the packaged orbitd (${events.length} events)`);

  // The reference plugins come from the package; the Filesystem one starts its bundled server.
  const plugins = orbitJson(['plugins']) as { id: string; dir: string }[];
  check(
    plugins
      .map((p) => p.id)
      .sort()
      .join() === 'browser,filesystem,github,google,slack',
    `plugins: ${plugins.map((p) => p.id).join()}`,
  );
  check(
    plugins.every((p) => p.dir.startsWith(join(installed, 'dist', 'plugins'))),
    `plugin folders: ${plugins.map((p) => p.dir).join()}`,
  );
  orbit(['plugin', 'setting', 'filesystem', 'FS_ROOTS', files, '--json']);
  const enabled = orbitJson(['plugin', 'enable', 'filesystem']) as {
    enabled: boolean;
    state: string;
    tools: unknown[];
  };
  check(
    enabled.enabled && enabled.state === 'ready' && enabled.tools.length === 4,
    `enabling filesystem: ${JSON.stringify(enabled)}`,
  );
  ok('the bundled Filesystem plugin server started and passed its check (no network)');

  // The App: a one-time sign-in link on stdout, and orbitd serves index.html.
  const app = orbitJson(['app', '--no-open']) as { url: string; expiresAt: string };
  const url = new URL(app.url);
  check(
    url.hostname === '127.0.0.1' && url.pathname === '/login' && /^#ticket=.+/.test(url.hash),
    `orbit app --json: ${app.url}`,
  );
  for (const path of ['/', '/login']) {
    const res = await fetch(new URL(path, url.origin));
    const body = await res.text();
    check(
      res.status === 200 &&
        (res.headers.get('content-type') ?? '').startsWith('text/html') &&
        body.includes('<div id="root">') &&
        res.headers.get('content-security-policy')?.includes("default-src 'self'"),
      `GET ${path}: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  ok(`orbit app --json: sign-in link on stdout; orbitd serves the App at ${url.origin}`);

  // The CliDriver hook ships and fails closed without its bridge.
  const hook = run(process.execPath, [join(installed, 'dist', 'orbit-hook.mjs')], {
    input: '{"hook_event_name":"PreToolUse"}',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    allowFail: true,
    timeout: 30_000,
  });
  check(
    hook.status === 2 && hook.stdout.includes('"deny"'),
    `orbit-hook.mjs: ${hook.status} ${hook.stdout}`,
  );
  ok('the CliDriver hook script ships and fails closed');
}

let code = 0;
try {
  await main();
  process.stdout.write('smoke test passed\n');
} catch (err) {
  code = 1;
  process.stderr.write(`smoke test FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  const log = join(orbitHome, 'logs', 'orbitd.log');
  if (existsSync(log)) process.stderr.write(`--- orbitd.log ---\n${readFileSync(log, 'utf8')}\n`);
} finally {
  await stopDaemon();
  if (keep) process.stdout.write(`kept ${tmp}\n`);
  else rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
