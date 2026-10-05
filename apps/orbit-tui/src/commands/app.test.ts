import type { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openInBrowser, signInFile } from './app';

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function fakeSpawn() {
  const calls: { cmd: string; args: readonly string[]; env: Record<string, string> }[] = [];
  const fn = ((cmd: string, args: readonly string[], opts: { env: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts.env });
    return { on: () => undefined, unref: () => undefined };
  }) as unknown as typeof spawn;
  return { fn, calls };
}

describe('orbit app: opening the browser', () => {
  const url = 'http://127.0.0.1:7420/login#ticket=SECRET-TICKET-0123456789';

  it('the ticket never appears on the launcher command line; it sits in a 0600 file', () => {
    home = mkdtempSync(join(tmpdir(), 'orbit-app-open-'));
    const { fn, calls } = fakeSpawn();
    openInBrowser(url, { PATH: '/usr/bin', HOME: '/home/x' }, home, fn);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.args)).not.toContain('SECRET-TICKET');
    expect(calls[0]?.args).toContain(signInFile(home));
    const file = signInFile(home);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(
      'url=http://127.0.0.1:7420/login#ticket=SECRET-TICKET',
    );
  });

  it('the launcher env is an allowlist plus display variables: no credentials (ADR-005)', () => {
    home = mkdtempSync(join(tmpdir(), 'orbit-app-open-'));
    const { fn, calls } = fakeSpawn();
    openInBrowser(
      url,
      {
        PATH: '/usr/bin',
        DISPLAY: ':0',
        ANTHROPIC_API_KEY: 'sk-ant-api-should-not-pass',
        ANTHROPIC_AUTH_TOKEN: 'nope',
        CLAUDE_CODE_OAUTH_TOKEN: 'nope',
        AWS_SECRET_ACCESS_KEY: 'nope',
        SOME_RANDOM: 'nope',
      },
      home,
      fn,
    );
    const env = calls[0]?.env ?? {};
    expect(env.PATH).toBe('/usr/bin');
    expect(env.DISPLAY).toBe(':0');
    for (const k of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'SOME_RANDOM',
    ]) {
      expect(env[k]).toBeUndefined();
    }
  });

  it('escapes the URL in the redirect page', () => {
    home = mkdtempSync(join(tmpdir(), 'orbit-app-open-'));
    openInBrowser('http://127.0.0.1:1/login#ticket="><script>x</script>', {}, home, fakeSpawn().fn);
    expect(readFileSync(signInFile(home), 'utf8')).not.toContain('<script>');
  });
});
