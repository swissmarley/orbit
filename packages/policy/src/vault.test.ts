import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitError } from '@orbit/core';
import { type OrbitDb, openDatabase } from '@orbit/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type KeychainLike, SecretVault } from './vault';

const POSIX = process.platform !== 'win32';
const PLAINTEXT = 'ghp_plaintextSecretValue1234567890abcd';

let root: string;
let home: string;
let db: OrbitDb;
let clock: number;
const now = () => new Date(Date.UTC(2026, 9, 4, 12, 0, 0) + clock++ * 1000);

beforeEach(() => {
  clock = 0;
  root = mkdtempSync(join(tmpdir(), 'orbit-vault-'));
  home = join(root, 'orbit-home');
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const openFileVault = (d: OrbitDb = db) =>
  SecretVault.open({ db: d, home, keySource: 'file', now });

class FakeKeychain implements KeychainLike {
  sets = 0;
  constructor(
    public stored: string | null = null,
    private readonly opts: { failGet?: boolean; failSet?: boolean; persist?: boolean } = {},
  ) {}
  getPassword(): string | null {
    if (this.opts.failGet) throw new Error('keychain locked');
    return this.stored;
  }
  setPassword(v: string): void {
    this.sets++;
    if (this.opts.failSet) throw new Error('keychain read-only');
    if (this.opts.persist !== false) this.stored = v;
  }
}

function rawSecretRows(d: OrbitDb = db): Record<string, string>[] {
  return d.sqlite.prepare('SELECT * FROM secrets ORDER BY name').all() as Record<string, string>[];
}

async function expectOrbitError(p: Promise<unknown> | (() => unknown), code: string, re?: RegExp) {
  let err: unknown;
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(OrbitError);
  expect((err as OrbitError).code).toBe(code);
  if (re) expect((err as OrbitError).message).toMatch(re);
}

describe('SecretVault basics', () => {
  it('round-trips values and reports metadata without values', async () => {
    const v = await openFileVault();
    expect(v.keySource).toBe('file');
    const meta = v.set('GITHUB_TOKEN', PLAINTEXT);
    expect(meta).toEqual({
      name: 'GITHUB_TOKEN',
      createdAt: '2026-10-04T12:00:00.000Z',
      updatedAt: '2026-10-04T12:00:00.000Z',
    });
    expect(v.get('GITHUB_TOKEN')).toBe(PLAINTEXT);
    expect(v.has('GITHUB_TOKEN')).toBe(true);
    expect(v.has('NOPE')).toBe(false);
    expect(v.get('NOPE')).toBeUndefined();
    v.set('EMPTY', '');
    expect(v.get('EMPTY')).toBe('');
    v.set('UNICODE', 'pässwörd ✓ 🔑');
    expect(v.get('UNICODE')).toBe('pässwörd ✓ 🔑');
  });

  it('updates in place, keeping createdAt', async () => {
    const v = await openFileVault();
    v.set('A', 'one');
    const m = v.set('A', 'two');
    expect(m).toEqual({
      name: 'A',
      createdAt: '2026-10-04T12:00:00.000Z',
      updatedAt: '2026-10-04T12:00:01.000Z',
    });
    expect(v.get('A')).toBe('two');
    expect(v.list()).toHaveLength(1);
  });

  it('lists sorted by name, never including values; values() decrypts all', async () => {
    const v = await openFileVault();
    v.set('ZED', 'zzzzzz-value');
    v.set('alpha', 'aaaaaa-value');
    v.set('MIDDLE', 'mmmmmm-value');
    v.set('_under', 'uuuuuu-value');
    const list = v.list();
    expect(list.map((m) => m.name)).toEqual(['MIDDLE', 'ZED', '_under', 'alpha']);
    for (const m of list) expect(Object.keys(m).sort()).toEqual(['createdAt', 'name', 'updatedAt']);
    expect(JSON.stringify(list)).not.toMatch(/-value/);
    expect(v.values()).toEqual(['mmmmmm-value', 'zzzzzz-value', 'uuuuuu-value', 'aaaaaa-value']);
  });

  it('removes secrets', async () => {
    const v = await openFileVault();
    v.set('A', 'one');
    v.set('B', 'two');
    expect(v.remove('A')).toBe(true);
    expect(v.remove('A')).toBe(false);
    expect(v.remove('NEVER')).toBe(false);
    expect(v.has('A')).toBe(false);
    expect(v.get('A')).toBeUndefined();
    expect(v.list().map((m) => m.name)).toEqual(['B']);
  });

  it.each([
    '',
    '1ABC',
    'has-dash',
    'has space',
    'dot.name',
    'A'.repeat(65),
    'émoji',
    'A\n',
    '../etc',
  ])('rejects invalid name %j with invalid_input', async (name) => {
    const v = await openFileVault();
    await expectOrbitError(() => v.set(name, 'x'), 'invalid_input');
    expect(v.list()).toEqual([]);
  });

  it.each(['A', '_', 'a1', 'ORBIT_SLACK_TOKEN', `A${'b'.repeat(63)}`])(
    'accepts valid name %j',
    async (name) => {
      const v = await openFileVault();
      v.set(name, 'value');
      expect(v.get(name)).toBe('value');
    },
  );
});

describe('SecretVault encryption', () => {
  it('stores neither plaintext nor the key in the database rows', async () => {
    const v = await openFileVault();
    v.set('GITHUB_TOKEN', PLAINTEXT);
    const key = readFileSync(join(home, 'vault.key'), 'utf8').trim();
    const rows = rawSecretRows();
    expect(rows).toHaveLength(1);
    const all = JSON.stringify(rows);
    expect(all).not.toContain(PLAINTEXT);
    expect(all).not.toContain(Buffer.from(PLAINTEXT).toString('base64'));
    expect(all).not.toContain(key);
    const row = rows[0]!;
    expect(Buffer.from(row.iv!, 'base64')).toHaveLength(12);
    expect(Buffer.from(row.tag!, 'base64')).toHaveLength(16);
    // nothing else in the database holds the key either
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const t of tables) {
      const dump = JSON.stringify(db.sqlite.prepare(`SELECT * FROM "${t.name}"`).all());
      expect(dump).not.toContain(key);
      expect(dump).not.toContain(PLAINTEXT);
    }
  });

  it('never writes plaintext or the key into the database files on disk', async () => {
    const dbPath = join(root, 'db', 'orbit.db');
    const fileDb = openDatabase(dbPath);
    const v = await openFileVault(fileDb);
    v.set('GITHUB_TOKEN', PLAINTEXT);
    v.set('OTHER', PLAINTEXT);
    const key = readFileSync(join(home, 'vault.key'), 'utf8').trim();
    const rawKey = Buffer.from(key, 'base64');
    const scan = () => {
      for (const f of readdirSync(join(root, 'db'))) {
        const bytes = readFileSync(join(root, 'db', f));
        expect(bytes.includes(Buffer.from(PLAINTEXT))).toBe(false);
        expect(bytes.includes(Buffer.from(key))).toBe(false);
        expect(bytes.includes(rawKey)).toBe(false);
      }
    };
    scan(); // WAL file included
    fileDb.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    fileDb.close();
    scan();
    // and it persists: a fresh process with the same home reads it back
    const reopened = openDatabase(dbPath);
    expect((await openFileVault(reopened)).get('GITHUB_TOKEN')).toBe(PLAINTEXT);
    reopened.close();
  });

  it('uses a fresh IV per encryption', async () => {
    const v = await openFileVault();
    v.set('A', 'same-value');
    v.set('B', 'same-value');
    const [a, b] = rawSecretRows();
    expect(a!.iv).not.toBe(b!.iv);
    expect(a!.ciphertext).not.toBe(b!.ciphertext);
    const before = a!.iv;
    v.set('A', 'same-value');
    expect(rawSecretRows()[0]!.iv).not.toBe(before);
  });

  it('binds ciphertexts to their names (swapping rows makes get() throw)', async () => {
    const v = await openFileVault();
    v.set('A', 'value-of-a');
    v.set('B', 'value-of-b');
    const [a, b] = rawSecretRows();
    const upd = db.sqlite.prepare(
      'UPDATE secrets SET ciphertext = ?, iv = ?, tag = ? WHERE name = ?',
    );
    upd.run(b!.ciphertext, b!.iv, b!.tag, 'A');
    upd.run(a!.ciphertext, a!.iv, a!.tag, 'B');
    await expectOrbitError(() => v.get('A'), 'invalid_config', /Vault key does not match/);
    await expectOrbitError(() => v.get('B'), 'invalid_config', /Vault key does not match/);
    await expectOrbitError(() => v.values(), 'invalid_config');
  });

  it('detects a tampered ciphertext or tag', async () => {
    const v = await openFileVault();
    v.set('A', 'value-of-a');
    v.set('B', 'value-of-b');
    const [a, b] = rawSecretRows();
    const ct = Buffer.from(a!.ciphertext!, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    db.sqlite
      .prepare('UPDATE secrets SET ciphertext = ? WHERE name = ?')
      .run(ct.toString('base64'), 'A');
    const tag = Buffer.from(b!.tag!, 'base64');
    tag[0] = tag[0]! ^ 0x01;
    db.sqlite.prepare('UPDATE secrets SET tag = ? WHERE name = ?').run(tag.toString('base64'), 'B');
    await expectOrbitError(() => v.get('A'), 'invalid_config');
    await expectOrbitError(() => v.get('B'), 'invalid_config');
  });
});

describe('SecretVault file key', () => {
  it('creates <home>/vault.key (0600) in a 0700 directory, as 32 random bytes', async () => {
    expect(existsSync(home)).toBe(false);
    await openFileVault();
    const keyPath = join(home, 'vault.key');
    expect(Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')).toHaveLength(32);
    if (POSIX) {
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    }
  });

  it('reuses the existing key across instances', async () => {
    const v1 = await openFileVault();
    v1.set('A', 'persisted');
    const key = readFileSync(join(home, 'vault.key'), 'utf8');
    const v2 = await openFileVault();
    expect(v2.get('A')).toBe('persisted');
    expect(readFileSync(join(home, 'vault.key'), 'utf8')).toBe(key);
  });

  it.runIf(POSIX)('refuses a group/world-readable key file', async () => {
    await openFileVault();
    const keyPath = join(home, 'vault.key');
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      chmodSync(keyPath, mode);
      await expectOrbitError(openFileVault(), 'invalid_config', /readable by other users/);
    }
    chmodSync(keyPath, 0o400);
    await expect(openFileVault()).resolves.toBeInstanceOf(SecretVault);
  });

  it('refuses a key file that is not a 32-byte key', async () => {
    await openFileVault();
    writeFileSync(join(home, 'vault.key'), 'dG9vLXNob3J0\n', { mode: 0o600 });
    await expectOrbitError(openFileVault(), 'invalid_config', /32-byte/);
  });

  it('fails get() with invalid_config when the key file was replaced', async () => {
    const v1 = await openFileVault();
    v1.set('A', 'secret-a');
    writeFileSync(join(home, 'vault.key'), randomBytes(32).toString('base64'), { mode: 0o600 });
    const v2 = await openFileVault();
    expect(v2.has('A')).toBe(true);
    expect(v2.list().map((m) => m.name)).toEqual(['A']);
    await expectOrbitError(() => v2.get('A'), 'invalid_config', /^Vault key does not match/);
  });
});

describe('SecretVault keychain', () => {
  it('uses an existing keychain key and creates no key file', async () => {
    const kc = new FakeKeychain(randomBytes(32).toString('base64'));
    const v = await SecretVault.open({ db, home, keychain: kc, now });
    expect(v.keySource).toBe('keychain');
    v.set('A', 'kc-value');
    expect(v.get('A')).toBe('kc-value');
    expect(existsSync(join(home, 'vault.key'))).toBe(false);
    expect(kc.sets).toBe(0);
    expect(JSON.stringify(rawSecretRows())).not.toContain(kc.stored);
    // same keychain key → same data readable by a new instance
    const v2 = await SecretVault.open({ db, home, keychain: kc, keySource: 'keychain' });
    expect(v2.get('A')).toBe('kc-value');
  });

  it('auto: creates the key in the keychain on a fresh install', async () => {
    const kc = new FakeKeychain();
    const v = await SecretVault.open({ db, home, keychain: kc });
    expect(v.keySource).toBe('keychain');
    expect(kc.sets).toBe(1);
    expect(Buffer.from(kc.stored!, 'base64')).toHaveLength(32);
    expect(existsSync(join(home, 'vault.key'))).toBe(false);
  });

  it('auto: falls back to the file when the keychain throws', async () => {
    const v = await SecretVault.open({
      db,
      home,
      keychain: new FakeKeychain(null, { failGet: true }),
    });
    expect(v.keySource).toBe('file');
    expect(existsSync(join(home, 'vault.key'))).toBe(true);
  });

  it('auto: falls back to the file when the keychain cannot store the key', async () => {
    for (const kc of [
      new FakeKeychain(null, { failSet: true }),
      new FakeKeychain(null, { persist: false }),
    ]) {
      const v = await SecretVault.open({ db, home, keychain: kc });
      expect(v.keySource).toBe('file');
    }
  });

  it('auto: keeps using an existing key file when the keychain is empty', async () => {
    const v1 = await openFileVault();
    v1.set('A', 'file-value');
    const kc = new FakeKeychain();
    const v2 = await SecretVault.open({ db, home, keychain: kc });
    expect(v2.keySource).toBe('file');
    expect(kc.sets).toBe(0);
    expect(v2.get('A')).toBe('file-value');
  });

  it("keySource 'keychain' fails with invalid_config when the keychain is unavailable", async () => {
    await expectOrbitError(
      SecretVault.open({
        db,
        home,
        keySource: 'keychain',
        keychain: new FakeKeychain(null, { failGet: true }),
      }),
      'invalid_config',
      /keychain/,
    );
    expect(existsSync(join(home, 'vault.key'))).toBe(false);
  });

  it("keySource 'file' never consults the keychain", async () => {
    const kc = new FakeKeychain(randomBytes(32).toString('base64'), { failGet: true });
    const v = await SecretVault.open({ db, home, keySource: 'file', keychain: kc });
    expect(v.keySource).toBe('file');
  });

  it('rejects a malformed keychain key instead of silently replacing it', async () => {
    await expectOrbitError(
      SecretVault.open({ db, home, keychain: new FakeKeychain('bm90LWEta2V5') }),
      'invalid_config',
      /32-byte/,
    );
  });

  it('fails get() with invalid_config when the keychain key changed', async () => {
    const kc = new FakeKeychain(randomBytes(32).toString('base64'));
    (await SecretVault.open({ db, home, keychain: kc })).set('A', 'x-value');
    kc.stored = randomBytes(32).toString('base64');
    const v = await SecretVault.open({ db, home, keychain: kc });
    await expectOrbitError(() => v.get('A'), 'invalid_config', /Vault key does not match/);
  });
});
