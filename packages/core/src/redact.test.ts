import { describe, expect, it } from 'vitest';
import { Redactor } from './redact';

describe('Redactor', () => {
  const r = new Redactor();

  it.each([
    ['anthropic key', 'key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'sk-ant-api03'],
    ['github token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdef'],
    ['slack token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234567890'],
    ['aws key', 'AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    ['bearer', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', 'abcdefghijklmnop'],
    ['assignment', 'password = hunter2hunter2', 'hunter2hunter2'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrs', 'eyJhbGci'],
    [
      'private key',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
      'MIIEow',
    ],
  ])('redacts %s', (_label, input, secretPart) => {
    const out = r.redactString(input);
    expect(out).not.toContain(secretPart);
    expect(out).toContain('[REDACTED:');
  });

  it('keeps the non-secret prefix of bearer headers and assignments', () => {
    expect(r.redactString('Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Bearer [REDACTED:bearer]');
    expect(r.redactString('api_key: abcdefgh12345')).toBe('api_key: [REDACTED:assignment]');
  });

  it('redacts registered exact secrets anywhere, including inside words', () => {
    const rr = new Redactor(['vault-value-42']);
    expect(rr.redactString('x=prefix-vault-value-42-suffix')).toBe(
      'x=prefix-[REDACTED:secret]-suffix',
    );
  });

  it('ignores secrets too short to match safely', () => {
    const rr = new Redactor(['abc']);
    expect(rr.redactString('abc abc')).toBe('abc abc');
  });

  it('deep-redacts objects, arrays and sensitive keys without mutating input', () => {
    const input = {
      tool: 'Bash',
      input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" x' },
      headers: [{ authorization: 'short-but-sensitive' }],
      nested: { password: 'p@ss', count: 3, ok: true, none: null },
    };
    const out = r.redact(input);
    expect(JSON.stringify(out)).not.toContain('abcdefghijklmnop');
    expect(out.headers[0]!.authorization).toBe('[REDACTED:field]');
    expect(out.nested.password).toBe('[REDACTED:field]');
    expect(out.nested.count).toBe(3);
    expect(out.nested.ok).toBe(true);
    expect(out.nested.none).toBeNull();
    expect(input.nested.password).toBe('p@ss');
  });

  it('leaves ordinary text alone', () => {
    const text = 'The launch window opens on Tuesday at 09:00 UTC. Owner: Ada.';
    expect(r.redactString(text)).toBe(text);
  });
});
