import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { MIN_SHORT_SECRET_LENGTH, OrbitError } from '@orbit/core';
import { type OrbitDb, schema } from '@orbit/store';
import { asc, eq } from 'drizzle-orm';
import { type KeySource, type KeychainLike, type LocalKeySpec, loadLocalKey } from './keys';

export { KEYCHAIN_SERVICE, type KeySource, type KeychainLike } from './keys';

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
export const KEYCHAIN_ACCOUNT = 'vault-key';
const IV_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';

const VAULT_KEY: LocalKeySpec = {
  account: KEYCHAIN_ACCOUNT,
  file: 'vault.key',
  label: 'Vault key',
  loss: 'secrets encrypted with it cannot be read',
};

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
    const { key, source } = loadLocalKey(VAULT_KEY, opts);
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
