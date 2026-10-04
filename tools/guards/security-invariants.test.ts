import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OAUTH_PRESENCE_HELPER, scanRepo, scanText } from './scan';

const ROOT = resolve(import.meta.dirname, '../..');

describe('repository security invariants', () => {
  it('has no violations anywhere in the repository', () => {
    const violations = scanRepo(ROOT);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

// Positive controls: prove the scanner actually detects what it claims to.
describe('scanner positive controls', () => {
  const src = 'packages/runtime/src/drivers/cli.ts';

  it('flags credential file references in source', () => {
    const v = scanText(src, "const p = join(home, '.claude', '.credentials.json');");
    expect(v.map((x) => x.rule)).toEqual(['no-credential-file']);
  });

  it('flags keychain lookups in shell and config files', () => {
    const v = scanText(
      'scripts/x.sh',
      'security find-generic-password -s "Claude Code-credentials"',
    );
    expect(v.map((x) => x.rule)).toEqual(['no-keychain-entry']);
  });

  it('flags reads of the OAuth token env var (dot and bracket forms)', () => {
    expect(scanText(src, 'const t = process.env.CLAUDE_CODE_OAUTH_TOKEN;')).toHaveLength(1);
    expect(scanText(src, "const t = process.env['CLAUDE_CODE_OAUTH_TOKEN'];")).toHaveLength(1);
  });

  it('allows the single audited presence helper', () => {
    expect(scanText(OAUTH_PRESENCE_HELPER, "'CLAUDE_CODE_OAUTH_TOKEN' in process.env")).toEqual([]);
  });

  it('flags hardcoded model IDs in source and config, not in fixtures or docs', () => {
    expect(scanText(src, "model: 'claude-opus-5-5'")).toHaveLength(1);
    expect(scanText('docker-compose.yml', 'ORBIT_DEFAULT_MODEL: claude-sonnet-5-5')).toHaveLength(
      1,
    );
    expect(
      scanText('packages/runtime/fixtures/cli/init.jsonl', '"model":"claude-opus-5-5"'),
    ).toEqual([]);
    expect(scanText('README.md', 'e.g. claude-opus-5-5')).toEqual([]);
  });

  it('allows aliases', () => {
    expect(scanText(src, "model: 'opus'")).toEqual([]);
  });
});
