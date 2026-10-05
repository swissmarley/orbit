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

  it.each([
    [
      'aws secret env',
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
      'wJalrXUtnFEMI',
    ],
    [
      'aws credentials file',
      'aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
      'wJalrXUtnFEMI',
    ],
    [
      'bedrock bearer token',
      'AWS_BEARER_TOKEN_BEDROCK=ABSKQmVkcm9ja0FQSUtleS1leGFtcGxlMTIzNDU2Nzg5',
      'ABSKQmVkcm9ja',
    ],
    ['bedrock token alone', 'token ABSKQmVkcm9ja0FQSUtleS1leGFtcGxlMTIzNDU2Nzg5', 'ABSKQmVkcm9ja'],
    ['google api key', 'key AIzaSyA-1234567890abcdefghijklmnopqrstu', 'AIzaSyA-12345'],
    ['url credentials', 'postgres://orbit:s3cr3tpass@db:5432/x', 's3cr3tpass'],
    ['netrc', 'machine api.example.com login me password hunter2xyz', 'hunter2xyz'],
    ['hook token env', 'ORBIT_HOOK_TOKEN=' + 'ab12'.repeat(12), 'ab12ab12ab12'],
  ])('redacts %s', (_label, input, secretPart) => {
    const out = r.redactString(input);
    expect(out).not.toContain(secretPart);
  });

  it('keeps URL structure when redacting credentials', () => {
    expect(r.redactString('https://me:pa55word@example.com/x')).toBe(
      'https://me:[REDACTED:url-credentials]@example.com/x',
    );
  });

  it('does not mangle token counts', () => {
    expect(r.redactString('max_tokens: 64000, output_tokens=12')).toBe(
      'max_tokens: 64000, output_tokens=12',
    );
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

  it('redacts 4–5 character secrets where they stand alone (review L10)', () => {
    const rr = new Redactor(['4821', 'hunt2']);
    expect(rr.redactString('PIN: 4821. code=hunt2, again "4821"')).toBe(
      'PIN: [REDACTED:secret]. code=[REDACTED:secret], again "[REDACTED:secret]"',
    );
    // Inside a longer token it is ordinary text, not the secret.
    expect(rr.redactString('order 948213 and hunt22 and 4821x')).toBe(
      'order 948213 and hunt22 and 4821x',
    );
    expect(rr.redact({ note: 'pin 4821' })).toEqual({ note: 'pin [REDACTED:secret]' });
  });

  it('also hides the trimmed form of a whitespace-padded secret (re-review L4)', () => {
    const r = new Redactor();
    r.addSecret('abcd  ');
    r.addSecret('token-value-0123456789\n');
    expect(r.redactString('pin abcd here')).not.toContain('abcd');
    expect(r.redactString('t=token-value-0123456789;')).not.toContain('token-value');
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
