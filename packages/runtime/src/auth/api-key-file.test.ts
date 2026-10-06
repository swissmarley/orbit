import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readApiKeyFile, resolveApiKey } from './api-key-file';

const KEY = 'sk-ant-api03-FILEKEY-000000';
const dir = mkdtempSync(join(tmpdir(), 'orbit-keyfile-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function keyFile(name: string, content: string, mode = 0o600): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

describe('ORBIT_API_KEY_FILE', () => {
  it('reads a private file (trailing newline trimmed) into the in-memory env only', () => {
    const file = keyFile('key', `${KEY}\n`);
    expect(readApiKeyFile(file)).toBe(KEY);
    const source = { ORBIT_API_KEY_FILE: file, PATH: '/usr/bin' };
    const r = resolveApiKey(source);
    expect(r).toEqual({ env: { ...source, ANTHROPIC_API_KEY: KEY }, origin: 'file' });
    // The caller's env object (process.env in orbitd) is not changed.
    expect(source).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(process.env.ANTHROPIC_API_KEY).not.toBe(KEY);
  });

  it('refuses a file other users can read, a link, a relative path, a missing file', () => {
    expect(() => readApiKeyFile(keyFile('open', KEY, 0o644))).toThrow(
      /can be read by other users \(mode 0644\)/,
    );
    expect(() => readApiKeyFile(keyFile('group', KEY, 0o640))).toThrow(/other users/);
    const target = keyFile('target', KEY);
    symlinkSync(target, join(dir, 'link'));
    expect(() => readApiKeyFile(join(dir, 'link'))).toThrow(/cannot be read \(ELOOP\)/);
    expect(() => readApiKeyFile('key.txt')).toThrow(/absolute path/);
    expect(() => readApiKeyFile(join(dir, 'missing'))).toThrow(/cannot be read \(ENOENT\)/);
    expect(() => readApiKeyFile(keyFile('spaces', 'sk-ant one two'))).toThrow(/whitespace/);
  });

  it('never puts the key in an error message', () => {
    const file = keyFile('bad', `${KEY} extra`);
    try {
      readApiKeyFile(file);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
      expect(JSON.stringify(err)).not.toContain(KEY);
    }
  });

  it('an empty file means no key; under /run/secrets the runtime decides the mode (/dev/null too)', () => {
    expect(readApiKeyFile(keyFile('empty', '\n'))).toBeNull();
    const read = (path: string) => {
      expect(path).toBe('/run/secrets/anthropic_api_key');
      return { text: '', kind: 'other' as const, mode: 0o666 };
    };
    expect(readApiKeyFile('/run/secrets/anthropic_api_key', { read })).toBeNull();
    const secret = () => ({ text: `${KEY}\n`, kind: 'file' as const, mode: 0o444 });
    expect(
      resolveApiKey(
        { ORBIT_API_KEY_FILE: '/run/secrets/anthropic_api_key' },
        { deps: { read: secret } },
      ),
    ).toMatchObject({ env: { ANTHROPIC_API_KEY: KEY }, origin: 'file' });
  });

  it('ANTHROPIC_API_KEY alone is the environment origin unless the caller says it was handed over', () => {
    expect(resolveApiKey({ ANTHROPIC_API_KEY: KEY }).origin).toBe('environment');
    expect(resolveApiKey({ ANTHROPIC_API_KEY: KEY }, { origin: 'handed_over' }).origin).toBe(
      'handed_over',
    );
    expect(resolveApiKey({}).origin).toBeNull();
    // Both, different: refused; both, the same: fine.
    const file = keyFile('both', KEY);
    expect(() =>
      resolveApiKey({ ANTHROPIC_API_KEY: 'sk-ant-other', ORBIT_API_KEY_FILE: file }),
    ).toThrow(/different keys/);
    expect(resolveApiKey({ ANTHROPIC_API_KEY: KEY, ORBIT_API_KEY_FILE: file }).env).toMatchObject({
      ANTHROPIC_API_KEY: KEY,
    });
  });
});
