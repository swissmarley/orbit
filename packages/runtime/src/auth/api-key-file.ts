import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { OrbitError } from '@orbit/core';
import type { Env } from '../env';

/**
 * Where orbitd's API key came from (M8 safety review). Only `environment`
 * leaves it in orbitd's own process environment, where processes of the same
 * user can read it (`/proc/<pid>/environ` on Linux, `ps eww` on macOS).
 */
export type ApiKeyOrigin =
  /** ANTHROPIC_API_KEY stayed in orbitd's environment (it could not be removed). */
  | 'environment'
  /** ORBIT_API_KEY_FILE (a 0600 file, or a container secret under /run/secrets). */
  | 'file'
  /** ANTHROPIC_API_KEY was handed over on a pipe and is not in orbitd's environment. */
  | 'handed_over';

/**
 * Set by whoever starts orbitd without ANTHROPIC_API_KEY in its environment
 * but with the key on a pipe: `stdin` (the orbit CLI writes it to orbitd's
 * standard input) or `pid:<n>` (orbitd re-executed itself; process n holds
 * the pipe). Never the key itself.
 */
export const API_KEY_HANDOVER_VAR = 'ORBIT_API_KEY_HANDOVER';

/** Container runtimes mount secrets here (Compose, Swarm); their mode is the runtime's. */
export const CONTAINER_SECRETS_DIR = '/run/secrets';

/** Largest key file read (a key is ~100 bytes; anything bigger is not one). */
const MAX_KEY_FILE = 16 * 1024;

function invalid(message: string, hint: string): OrbitError {
  return new OrbitError('invalid_config', message, { hint });
}

/** A key: printable ASCII without whitespace, after trimming surrounding whitespace. */
export function parseApiKey(raw: string): string | null {
  const key = raw.trim();
  if (key === '') return null;
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw invalid(
      'The API key holds whitespace or characters an API key never has',
      'Put only the key in the file (one line, no quotes).',
    );
  }
  return key;
}

export interface ApiKeyFileDeps {
  /** Opens and reads at most `max` bytes; the default checks the file's kind and mode first. */
  read?: (
    path: string,
    max: number,
    noFollow: boolean,
  ) => { text: string; kind: 'file' | 'other'; mode: number };
}

function readBounded(
  path: string,
  max: number,
  noFollow: boolean,
): { text: string; kind: 'file' | 'other'; mode: number } {
  // O_NOFOLLOW: a link swapped in for the file is refused, not followed.
  const fd = openSync(path, constants.O_RDONLY | (noFollow ? constants.O_NOFOLLOW : 0));
  try {
    const st = fstatSync(fd);
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > max) break;
    }
    return {
      text: buf.subarray(0, n).toString('utf8'),
      kind: st.isFile() ? 'file' : 'other',
      mode: st.mode & 0o777,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * The key in `ORBIT_API_KEY_FILE`, or null when the file is empty (a
 * container started without a key). The file must be a regular file only
 * its owner can read (0600 or 0400), like an SSH key; under `/run/secrets`
 * the container runtime decides the mode, and an empty mount (`/dev/null`,
 * compose.yaml's default) means "no key". Errors never carry the content.
 */
export function readApiKeyFile(path: string, deps: ApiKeyFileDeps = {}): string | null {
  if (!isAbsolute(path)) {
    throw invalid(
      `ORBIT_API_KEY_FILE must be an absolute path (got ${path})`,
      'Set ORBIT_API_KEY_FILE to the full path of the file holding the key.',
    );
  }
  const abs = resolve(path);
  const secret = abs.startsWith(CONTAINER_SECRETS_DIR + sep);
  let got: { text: string; kind: 'file' | 'other'; mode: number };
  try {
    // Container secrets may be links (Kubernetes' ..data); the runtime made them.
    got = (deps.read ?? readBounded)(abs, MAX_KEY_FILE, !secret);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    throw invalid(
      `ORBIT_API_KEY_FILE ${abs} cannot be read (${code})`,
      code === 'ELOOP'
        ? 'Point ORBIT_API_KEY_FILE at the file itself, not at a symbolic link.'
        : 'Check the path and that the user running orbitd can read it.',
    );
  }
  if (!secret) {
    if (got.kind !== 'file') {
      throw invalid(
        `ORBIT_API_KEY_FILE ${abs} is not a regular file`,
        'Point ORBIT_API_KEY_FILE at a file that holds only the key.',
      );
    }
    if ((got.mode & 0o077) !== 0) {
      throw invalid(
        `ORBIT_API_KEY_FILE ${abs} can be read by other users (mode ${got.mode.toString(8).padStart(4, '0')})`,
        `Make it private: chmod 600 ${abs}`,
      );
    }
  }
  if (got.text.length > MAX_KEY_FILE) {
    throw invalid(
      `ORBIT_API_KEY_FILE ${abs} is too large to hold an API key`,
      'Put only the key in the file.',
    );
  }
  return parseApiKey(got.text);
}

export interface ResolvedApiKey {
  /**
   * orbitd's environment as the service sees it: an in-memory copy with
   * ANTHROPIC_API_KEY set from the file when one is configured. Never a
   * process environment: children get allowlists built from it, and none of
   * them takes the key (ADR-018).
   */
  env: Env;
  origin: ApiKeyOrigin | null;
}

/**
 * ORBIT_API_KEY_FILE as a key source equivalent to ANTHROPIC_API_KEY, for the
 * AuthResolver and the key proxies alike. Both set to different keys is
 * refused (which one is meant?).
 */
export function resolveApiKey(
  env: Env,
  opts: { origin?: ApiKeyOrigin; deps?: ApiKeyFileDeps } = {},
): ResolvedApiKey {
  const file = env.ORBIT_API_KEY_FILE?.trim();
  const fromEnv = env.ANTHROPIC_API_KEY?.trim() ? env.ANTHROPIC_API_KEY.trim() : null;
  if (!file) {
    return { env: { ...env }, origin: fromEnv ? (opts.origin ?? 'environment') : null };
  }
  const key = readApiKeyFile(file, opts.deps);
  if (fromEnv !== null && key !== null && fromEnv !== key) {
    throw invalid(
      'Both ANTHROPIC_API_KEY and ORBIT_API_KEY_FILE are set, to different keys',
      'Unset one of them (ORBIT_API_KEY_FILE keeps the key out of process environments).',
    );
  }
  if (key === null) {
    return { env: { ...env }, origin: fromEnv ? (opts.origin ?? 'environment') : null };
  }
  return {
    env: { ...env, ANTHROPIC_API_KEY: key },
    origin: fromEnv ? (opts.origin ?? 'environment') : 'file',
  };
}

/**
 * Where an API key file can live (`ORBIT_API_KEY_FILE`, container secrets):
 * denied to Bots' file tools, the engine sandbox and plugins alike, since a
 * 0600 file of the owner is readable by every process of the same user.
 */
export function apiKeyFilePaths(env: Env): string[] {
  const file = env.ORBIT_API_KEY_FILE?.trim();
  return [CONTAINER_SECRETS_DIR, ...(file && isAbsolute(file) ? [resolve(file)] : [])];
}
