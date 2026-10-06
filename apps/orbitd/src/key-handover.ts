import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
} from 'node:fs';
import { OrbitError } from '@orbit/core';
import { API_KEY_HANDOVER_VAR, type Env, parseApiKey } from '@orbit/runtime';

/**
 * Keeping the API key out of orbitd's process environment (M8 safety
 * review). A process's initial environment stays readable to every process
 * of the same user for its whole life (`/proc/<pid>/environ`), and removing
 * a variable at run time does not change that memory. So:
 *
 * - the orbit CLI starts orbitd without ANTHROPIC_API_KEY and writes the key
 *   to its standard input (`ORBIT_API_KEY_HANDOVER=stdin`);
 * - orbitd started by hand (or by a service manager) with the key in its
 *   environment re-executes itself once — same PID, so terminals, systemd
 *   and tini keep working — without the variable, after leaving the key in a
 *   pipe held by a short-lived helper process (`pid:<n>`), from which the new
 *   image reads it through `/proc/<n>/fd/0`.
 *
 * The key is never on a command line or in a file.
 */

/** The helper that holds the pipe carries this variable (and nothing else). */
export const KEY_HOLDER_MARKER = 'ORBIT_API_KEY_HOLDER';

const MAX_KEY_BYTES = 16 * 1024;

function readFdBounded(fd: number): string {
  const buf = Buffer.alloc(MAX_KEY_BYTES + 1);
  let n = 0;
  for (;;) {
    let r: number;
    try {
      r = readSync(fd, buf, n, buf.length - n, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      throw err;
    }
    if (r === 0) break;
    n += r;
    if (n > MAX_KEY_BYTES)
      throw new OrbitError('invalid_input', 'The handed-over key is too large');
  }
  return buf.subarray(0, n).toString('utf8');
}

function refused(why: string): OrbitError {
  return new OrbitError('invalid_config', `The API key handover failed: ${why}`, {
    hint: 'Start orbitd with ORBIT_API_KEY_FILE pointing at a 0600 file that holds the key, or through the orbit CLI.',
  });
}

export interface ReceivedKey {
  /** orbitd's environment for the service: an in-memory copy with the key, without the handover variable. */
  env: Env;
  handedOver: boolean;
}

/**
 * Read a key handed over on a pipe (see above). Without the handover
 * variable the environment is returned unchanged. A handover that names
 * anything but a pipe (a terminal, a file) is refused rather than read.
 */
export function receiveApiKey(
  env: Env,
  deps: { kill?: (pid: number) => void; stdinFd?: number } = {},
): ReceivedKey {
  const how = env[API_KEY_HANDOVER_VAR]?.trim();
  if (!how) return { env, handedOver: false };
  const out: Env = { ...env };
  Reflect.deleteProperty(out, API_KEY_HANDOVER_VAR);
  let text: string;
  if (how === 'stdin') {
    const fd = deps.stdinFd ?? 0;
    const st = fstatSync(fd);
    if (!st.isFIFO() && !st.isSocket()) refusedThrow('standard input is not a pipe');
    text = readFdBounded(fd);
  } else {
    const m = /^pid:(\d{1,10})$/.exec(how);
    if (!m?.[1]) throw refused(`${API_KEY_HANDOVER_VAR} must be "stdin" or "pid:<n>"`);
    const pid = Number(m[1]);
    const proc = `/proc/${pid}`;
    let marker: boolean;
    try {
      marker = readFileSync(`${proc}/environ`, 'utf8')
        .split('\0')
        .includes(`${KEY_HOLDER_MARKER}=1`);
    } catch {
      marker = false;
    }
    if (!marker) throw refused(`process ${pid} is not Orbit's key holder`);
    let link: string;
    try {
      link = readlinkSync(`${proc}/fd/0`);
    } catch {
      link = '';
    }
    if (!link.startsWith('pipe:')) throw refused(`process ${pid} does not hold a pipe`);
    const fd = openSync(`${proc}/fd/0`, 'r');
    try {
      text = readFdBounded(fd);
    } finally {
      closeSync(fd);
      (deps.kill ?? ((p: number) => process.kill(p, 'SIGKILL')))(pid);
    }
  }
  const key = parseApiKey(text);
  if (key === null) throw refused('no key arrived');
  out.ANTHROPIC_API_KEY = key;
  return { env: out, handedOver: true };
}

function refusedThrow(why: string): never {
  throw refused(why);
}

/**
 * Starts the holder in the background and prints its pid: `cat` copies the
 * key from our end (a socket, closed when we exec) into a real pipe — only a
 * pipe can be opened again through `/proc/<pid>/fd` — whose read end is the
 * holder's standard input. The shell exits at once, so neither process stays
 * our child (no zombie after the exec); the holder exits by itself after 30 s.
 */
const LAUNCH_HOLDER =
  'exec 3<&0 0</dev/null; cat <&3 3<&- | "$0" -e "$1" 3<&- >/dev/null & echo $!';
const HOLDER = 'setTimeout(() => {}, 30000)';

export interface ReexecDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execve?: ((file: string, args: string[], env: Record<string, string>) => never) | undefined;
  hasProc?: () => boolean;
}

/**
 * When orbitd's own environment holds ANTHROPIC_API_KEY: leave the key in a
 * pipe held by a helper, then re-execute this process (same PID) without the
 * variable. Returns false — and orbitd keeps the key in its environment,
 * which doctor reports — where that is not possible: not Linux (no
 * `/proc/<pid>/fd`), no `process.execve`, or the helper did not start.
 */
export async function reexecWithoutKey(
  log: (level: string, message: string) => void,
  deps: ReexecDeps = {},
): Promise<false> {
  const env = deps.env ?? process.env;
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key || env[API_KEY_HANDOVER_VAR]) return false;
  const platform = deps.platform ?? process.platform;
  // `execve: undefined` in deps means "this Node has none" (tests).
  const nodeExecve = process.execve?.bind(process);
  const execve =
    'execve' in deps
      ? deps.execve
      : nodeExecve
        ? (file: string, args: string[], e: Record<string, string>) => nodeExecve(file, args, e)
        : undefined;
  const hasProc = deps.hasProc ?? (() => existsSync('/proc/self/fd'));
  if (platform !== 'linux' || !execve || !hasProc()) return false;

  let holderPid: number;
  const launcher = spawn('/bin/sh', ['-c', LAUNCH_HOLDER, process.execPath, HOLDER], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { [KEY_HOLDER_MARKER]: '1', PATH: '/usr/bin:/bin' },
  });
  try {
    let out = '';
    launcher.stdout.setEncoding('utf8');
    launcher.stdout.on('data', (d: string) => (out += d));
    const [code] = await Promise.all([
      new Promise<number | null>((resolve, reject) => {
        launcher.once('error', reject);
        launcher.once('exit', resolve);
      }),
      new Promise<void>((resolve) => launcher.stdout.once('end', resolve)),
      // `cat` copies the key into the holder's pipe and exits at the end of
      // our input, so the pipe holds the key and then end-of-file.
      new Promise<void>((resolve, reject) =>
        launcher.stdin.end(`${key}\n`, (err?: Error | null) => (err ? reject(err) : resolve())),
      ),
    ]);
    holderPid = Number(out.trim());
    if (code !== 0 || !Number.isInteger(holderPid) || holderPid <= 0) {
      throw new Error(`the key holder did not start (exit ${String(code)})`);
    }
  } catch (err) {
    launcher.stdin.destroy();
    log(
      'warn',
      `could not keep the API key out of orbitd's environment: ${(err as Error).message}`,
    );
    return false;
  }
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && k !== 'ANTHROPIC_API_KEY') next[k] = v;
  }
  next[API_KEY_HANDOVER_VAR] = `pid:${holderPid}`;
  return execve(
    process.execPath,
    [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    next,
  );
}
