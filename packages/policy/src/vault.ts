import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Entry as KeyringEntry } from '@napi-rs/keyring';
import { MIN_SHORT_SECRET_LENGTH, OrbitError } from '@orbit/core';
import { type OrbitDb, schema } from '@orbit/store';
import { asc, eq } from 'drizzle-orm';

/**
 * Encrypted secrets vault (PLAN.md §2.6, ADR-005).
 *
 * Values are encrypted with AES-256-GCM (random 12-byte IV per encryption,
 * auth tag stored, the secret's name bound as additional authenticated data
 * so ciphertexts cannot be swapped between names). The 32-byte data key lives
 * in the OS keychain (service 'orbit', account 'vault-key') or in
 * `<ORBIT_HOME>/vault.key` (mode 0600) — never in the database.
 */

export interface SecretMeta {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type KeySource = 'keychain' | 'file';

/** The subset of a keychain entry the vault needs; injectable for tests. */
export interface KeychainLike {
  getPassword(): string | null;
  setPassword(v: string): void;
}

export interface SecretVaultOptions {
  db: OrbitDb;
  /** ORBIT_HOME; the key file is `<home>/vault.key`. */
  home: string;
  /** Default 'auto': keychain when it holds (or can durably hold) the key, else file. */
  keySource?: 'auto' | KeySource;
  now?: () => Date;
  /** Injected keychain entry (tests). Defaults to the OS keychain via @napi-rs/keyring. */
  keychain?: KeychainLike;
}

export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const KEYCHAIN_SERVICE = 'orbit';
export const KEYCHAIN_ACCOUNT = 'vault-key';
const KEY_FILE = 'vault.key';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';

/**
 * The OS keychain entry. Loaded lazily so a missing native binding only
 * disables the keychain instead of breaking every importer of this module.
 * On Linux the entry is pinned to the Secret Service: the keyutils fallback is
 * kernel memory only and would lose the key (and every secret) on reboot.
 */
function osKeychain(): KeychainLike {
  const require = createRequire(import.meta.url);
  const { Entry } = require('@napi-rs/keyring') as { Entry: typeof KeyringEntry };
  const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, {
    linux: { store: 'secret-service' },
  });
  return {
    getPassword: () => entry.getPassword(),
    setPassword: (v) => {
      entry.setPassword(v);
    },
  };
}

function decodeKey(encoded: string, where: string): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new OrbitError('invalid_config', `Vault key in ${where} is not a ${KEY_BYTES}-byte key`, {
      hint: 'Restore the original key; secrets encrypted with it cannot be read otherwise.',
    });
  }
  return key;
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

function keyFilePath(home: string): string {
  return join(home, KEY_FILE);
}

function keyFileExists(home: string): boolean {
  try {
    statSync(keyFilePath(home));
    return true;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false;
    throw err;
  }
}

/** Read `<home>/vault.key`, creating it (0600, in a 0700 dir) if missing. */
function loadOrCreateFileKey(home: string): Buffer {
  const path = keyFilePath(home);
  try {
    return readFileKey(path);
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
    if (isErrno(err, 'EEXIST')) return readFileKey(path);
    throw err;
  }
  try {
    writeSync(fd, `${key.toString('base64')}\n`);
  } finally {
    closeSync(fd);
  }
  return key;
}

function readFileKey(path: string): Buffer {
  const st = statSync(path);
  if (!st.isFile()) {
    throw new OrbitError('invalid_config', `Vault key ${path} is not a regular file`);
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new OrbitError(
      'invalid_config',
      `Vault key ${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)})`,
      { hint: `Run: chmod 600 ${path}` },
    );
  }
  return decodeKey(readFileSync(path, 'utf8'), path);
}

/** Create a fresh key in the keychain and confirm it reads back. */
function createKeychainKey(keychain: KeychainLike): Buffer | undefined {
  const key = randomBytes(KEY_BYTES);
  const encoded = key.toString('base64');
  keychain.setPassword(encoded);
  return keychain.getPassword() === encoded ? key : undefined;
}

function resolveKey(opts: SecretVaultOptions): { key: Buffer; source: KeySource } {
  const mode = opts.keySource ?? 'auto';
  if (mode === 'file') return { key: loadOrCreateFileKey(opts.home), source: 'file' };

  if (mode === 'keychain') {
    try {
      const keychain = opts.keychain ?? osKeychain();
      const existing = keychain.getPassword();
      const key = existing ? decodeKey(existing, 'the OS keychain') : createKeychainKey(keychain);
      if (!key) throw new Error('the keychain did not persist the key');
      return { key, source: 'keychain' };
    } catch (err) {
      if (err instanceof OrbitError) throw err;
      throw new OrbitError('invalid_config', 'OS keychain is unavailable for the vault key', {
        hint: "Use keySource 'file' (or 'auto') to keep the key in <ORBIT_HOME>/vault.key.",
        cause: err,
      });
    }
  }

  // auto: an existing keychain key wins, then an existing key file; on a fresh
  // install prefer the keychain if it durably stores the key. Any keychain
  // error or a missing/non-persisting entry falls back to the file.
  let keychain: KeychainLike | undefined;
  try {
    keychain = opts.keychain ?? osKeychain();
    const existing = keychain.getPassword();
    if (existing) return { key: decodeKey(existing, 'the OS keychain'), source: 'keychain' };
  } catch (err) {
    if (err instanceof OrbitError) throw err;
    keychain = undefined;
  }
  if (keychain && !keyFileExists(opts.home)) {
    try {
      const key = createKeychainKey(keychain);
      if (key) return { key, source: 'keychain' };
    } catch {
      // fall through to the file key
    }
  }
  return { key: loadOrCreateFileKey(opts.home), source: 'file' };
}

function assertName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) {
    throw new OrbitError('invalid_input', `Invalid secret name ${JSON.stringify(name)}`, {
      hint: 'Use an env-var style name: a letter or _, then letters, digits or _ (max 64).',
    });
  }
}

export class SecretVault {
  readonly keySource: KeySource;
  private readonly key: Buffer;
  private readonly db: OrbitDb;
  private readonly now: () => Date;

  constructor(opts: SecretVaultOptions) {
    const { key, source } = resolveKey(opts);
    this.key = key;
    this.keySource = source;
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
  }

  /** Resolve the key (keychain or file) and open the vault. */
  static open(opts: SecretVaultOptions): Promise<SecretVault> {
    return new Promise((resolve) => {
      resolve(new SecretVault(opts));
    });
  }

  /** Create or replace a secret. */
  set(name: string, value: string): SecretMeta {
    assertName(name);
    // Anything shorter could not be redacted without mangling ordinary text (review L10).
    if (value.trim().length < MIN_SHORT_SECRET_LENGTH) {
      throw new OrbitError(
        'invalid_input',
        `A secret must be at least ${MIN_SHORT_SECRET_LENGTH} characters`,
        {
          hint: 'Orbit hides secret values in everything it shows; shorter values cannot be told apart from ordinary text.',
        },
      );
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ts = this.now().toISOString();
    const enc = {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      updatedAt: ts,
    };
    const row = this.db.orm
      .insert(schema.secrets)
      .values({ name, createdAt: ts, ...enc })
      .onConflictDoUpdate({ target: schema.secrets.name, set: enc })
      .returning({
        name: schema.secrets.name,
        createdAt: schema.secrets.createdAt,
        updatedAt: schema.secrets.updatedAt,
      })
      .get();
    return row;
  }

  /** Decrypt a secret; undefined when it does not exist. */
  get(name: string): string | undefined {
    const row = this.db.orm
      .select()
      .from(schema.secrets)
      .where(eq(schema.secrets.name, name))
      .get();
    return row ? this.decrypt(row) : undefined;
  }

  has(name: string): boolean {
    return (
      this.db.orm
        .select({ name: schema.secrets.name })
        .from(schema.secrets)
        .where(eq(schema.secrets.name, name))
        .get() !== undefined
    );
  }

  /** Names and timestamps, sorted by name. Never returns values. */
  list(): SecretMeta[] {
    return this.db.orm
      .select({
        name: schema.secrets.name,
        createdAt: schema.secrets.createdAt,
        updatedAt: schema.secrets.updatedAt,
      })
      .from(schema.secrets)
      .orderBy(asc(schema.secrets.name))
      .all();
  }

  remove(name: string): boolean {
    return (
      this.db.orm.delete(schema.secrets).where(eq(schema.secrets.name, name)).run().changes > 0
    );
  }

  /** Every decrypted value — for seeding the Redactor. */
  values(): string[] {
    return this.db.orm
      .select()
      .from(schema.secrets)
      .orderBy(asc(schema.secrets.name))
      .all()
      .map((row) => this.decrypt(row));
  }

  private decrypt(row: { name: string; ciphertext: string; iv: string; tag: string }): string {
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(row.iv, 'base64'));
      decipher.setAAD(Buffer.from(row.name, 'utf8'));
      decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (err) {
      throw new OrbitError(
        'invalid_config',
        `Vault key does not match secret "${row.name}" (wrong key, or the record was tampered with)`,
        {
          hint: `The vault key comes from the ${this.keySource === 'file' ? 'key file <ORBIT_HOME>/vault.key' : 'OS keychain'}; restore the original key or re-set the secret.`,
          cause: err,
        },
      );
    }
  }
}
