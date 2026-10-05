import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Entry as KeyringEntry } from '@napi-rs/keyring';
import { OrbitError } from '@orbit/core';

/**
 * Local 32-byte keys that must never enter the database (ADR-005, ADR-007):
 * the vault's data key and the audit log's MAC key. Each lives in the OS
 * keychain (service 'orbit', its own account) or in a 0600 file under
 * ORBIT_HOME, and is created on first use.
 */

export type KeySource = 'keychain' | 'file';

/** The subset of a keychain entry the key store needs; injectable for tests. */
export interface KeychainLike {
  getPassword(): string | null;
  setPassword(v: string): void;
}

export interface LocalKeyOptions {
  /** ORBIT_HOME; the key file is `<home>/<file>`. */
  home: string;
  /** Default 'auto': keychain when it holds (or can durably hold) the key, else file. */
  keySource?: 'auto' | KeySource;
  /** Injected keychain entry (tests). Defaults to the OS keychain via @napi-rs/keyring. */
  keychain?: KeychainLike;
}

export interface LocalKeySpec {
  /** Keychain account under service 'orbit'. */
  account: string;
  /** Key file name under ORBIT_HOME. */
  file: string;
  /** How messages name the key: 'Vault key', 'Audit key'. */
  label: string;
  /** What is lost without the original key (the hint on a malformed key). */
  loss: string;
}

export interface LocalKey {
  key: Buffer;
  source: KeySource;
  /** True when this call created the key (a fresh install, or a lost key). */
  created: boolean;
}

export const KEYCHAIN_SERVICE = 'orbit';
const KEY_BYTES = 32;

/**
 * The OS keychain entry. Loaded lazily so a missing native binding only
 * disables the keychain instead of breaking every importer of this module.
 * On Linux the entry is pinned to the Secret Service: the keyutils fallback is
 * kernel memory only and would lose the key on reboot.
 */
function osKeychain(account: string): KeychainLike {
  const require = createRequire(import.meta.url);
  const { Entry } = require('@napi-rs/keyring') as { Entry: typeof KeyringEntry };
  const entry = new Entry(KEYCHAIN_SERVICE, account, {
    linux: { store: 'secret-service' },
  });
  return {
    getPassword: () => entry.getPassword(),
    setPassword: (v) => {
      entry.setPassword(v);
    },
  };
}

function decodeKey(spec: LocalKeySpec, encoded: string, where: string): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new OrbitError(
      'invalid_config',
      `${spec.label} in ${where} is not a ${KEY_BYTES}-byte key`,
      {
        hint: `Restore the original key; ${spec.loss} otherwise.`,
      },
    );
  }
  return key;
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

function keyFileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false;
    throw err;
  }
}

/** Read `<home>/<file>`, creating it (0600, in a 0700 dir) if missing. */
function loadOrCreateFileKey(spec: LocalKeySpec, home: string): LocalKey {
  const path = join(home, spec.file);
  try {
    return { key: readFileKey(spec, path), source: 'file', created: false };
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  let fd: number;
  try {
    // 'wx': fail if another process created it in the meantime.
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if (isErrno(err, 'EEXIST')) {
      return { key: readFileKey(spec, path), source: 'file', created: false };
    }
    throw err;
  }
  try {
    writeSync(fd, `${key.toString('base64')}\n`);
  } finally {
    closeSync(fd);
  }
  return { key, source: 'file', created: true };
}

function readFileKey(spec: LocalKeySpec, path: string): Buffer {
  const st = statSync(path);
  if (!st.isFile()) {
    throw new OrbitError('invalid_config', `${spec.label} ${path} is not a regular file`);
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new OrbitError(
      'invalid_config',
      `${spec.label} ${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)})`,
      { hint: `Run: chmod 600 ${path}` },
    );
  }
  return decodeKey(spec, readFileSync(path, 'utf8'), path);
}

/** Create a fresh key in the keychain and confirm it reads back. */
function createKeychainKey(keychain: KeychainLike): Buffer | undefined {
  const key = randomBytes(KEY_BYTES);
  const encoded = key.toString('base64');
  keychain.setPassword(encoded);
  return keychain.getPassword() === encoded ? key : undefined;
}

/** Resolve (or create) one local key: keychain or file, never the database. */
export function loadLocalKey(spec: LocalKeySpec, opts: LocalKeyOptions): LocalKey {
  const mode = opts.keySource ?? 'auto';
  if (mode === 'file') return loadOrCreateFileKey(spec, opts.home);

  if (mode === 'keychain') {
    try {
      const keychain = opts.keychain ?? osKeychain(spec.account);
      const existing = keychain.getPassword();
      if (existing) {
        return {
          key: decodeKey(spec, existing, 'the OS keychain'),
          source: 'keychain',
          created: false,
        };
      }
      const key = createKeychainKey(keychain);
      if (!key) throw new Error('the keychain did not persist the key');
      return { key, source: 'keychain', created: true };
    } catch (err) {
      if (err instanceof OrbitError) throw err;
      throw new OrbitError(
        'invalid_config',
        `OS keychain is unavailable for the ${spec.label.toLowerCase()}`,
        {
          hint: `Use keySource 'file' (or 'auto') to keep the key in <ORBIT_HOME>/${spec.file}.`,
          cause: err,
        },
      );
    }
  }

  // auto: an existing keychain key wins, then an existing key file; on a fresh
  // install prefer the keychain if it durably stores the key. Any keychain
  // error or a missing/non-persisting entry falls back to the file.
  let keychain: KeychainLike | undefined;
  try {
    keychain = opts.keychain ?? osKeychain(spec.account);
    const existing = keychain.getPassword();
    if (existing) {
      return {
        key: decodeKey(spec, existing, 'the OS keychain'),
        source: 'keychain',
        created: false,
      };
    }
  } catch (err) {
    if (err instanceof OrbitError) throw err;
    keychain = undefined;
  }
  if (keychain && !keyFileExists(join(opts.home, spec.file))) {
    try {
      const key = createKeychainKey(keychain);
      if (key) return { key, source: 'keychain', created: true };
    } catch {
      // fall through to the file key
    }
  }
  return loadOrCreateFileKey(spec, opts.home);
}

export const AUDIT_KEYCHAIN_ACCOUNT = 'audit-key';

const AUDIT_KEY: LocalKeySpec = {
  account: AUDIT_KEYCHAIN_ACCOUNT,
  file: 'audit.key',
  label: 'Audit key',
  loss: 'the keyed audit records and checkpoints made with it cannot be verified',
};

/** The audit log's MAC key (ADR-007, M8): keychain or `<home>/audit.key`, created on first use. */
export function loadAuditKey(opts: LocalKeyOptions): LocalKey {
  return loadLocalKey(AUDIT_KEY, opts);
}
