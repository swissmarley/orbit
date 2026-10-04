import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fake `claude` executable for auth-probe tests. It answers
 * `claude auth status --json` and `claude --version`, and records the argv and
 * the exact environment it received to `<dir>/received.<auth|version>.json` so
 * tests can prove what a child actually got (ADR-005).
 *
 * No real `claude`, no credentials, no network.
 */
export interface FakeClaudeOptions {
  /** JSON printed for `auth status --json`; null prints nothing. */
  status?: Record<string, unknown> | null;
  /** Exit code for `auth status --json`. */
  statusExit?: number;
  /** stderr for `auth status --json`. */
  statusStderr?: string;
  /** If set, `auth status` sleeps this long before answering (timeout tests). */
  hangMs?: number;
  /** Printed for `--version`. */
  version?: string;
  versionExit?: number;
  /**
   * If true, the fake reports an API-key login whenever ANTHROPIC_API_KEY is in
   * its environment, the way a real CLI would. Proves the probe's answer
   * reflects the CLI's own login, not Orbit's key.
   */
  reflectApiKey?: boolean;
}

export interface Received {
  argv: string[];
  env: Record<string, string>;
}

export interface FakeClaude {
  dir: string;
  path: string;
  /** What the `auth status` / `--version` invocation received, or null if never run. */
  received(which: 'auth' | 'version'): Received | null;
  cleanup(): void;
}

export function makeFakeClaude(options: FakeClaudeOptions = {}): FakeClaude {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-fake-claude-'));
  const cfg = {
    dumpDir: dir,
    status:
      options.status === undefined
        ? { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }
        : options.status,
    statusExit: options.statusExit ?? 0,
    statusStderr: options.statusStderr ?? '',
    hangMs: options.hangMs ?? 0,
    version: options.version ?? '2.1.289 (Claude Code)',
    versionExit: options.versionExit ?? 0,
    reflectApiKey: options.reflectApiKey ?? false,
  };
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = ${JSON.stringify(cfg)};
const args = process.argv.slice(2);
const which =
  args.length === 1 && args[0] === '--version'
    ? 'version'
    : args.join(' ') === 'auth status --json'
      ? 'auth'
      : 'other';
fs.writeFileSync(
  path.join(cfg.dumpDir, 'received.' + which + '.json'),
  JSON.stringify({ argv: args, env: process.env }),
);
function finish() {
  if (which === 'version') {
    process.stdout.write(cfg.version + '\\n');
    process.exitCode = cfg.versionExit;
    return;
  }
  if (which === 'auth') {
    let status = cfg.status;
    if (cfg.reflectApiKey && Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY')) {
      status = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' };
    }
    if (status !== null) process.stdout.write(JSON.stringify(status) + '\\n');
    if (cfg.statusStderr) process.stderr.write(cfg.statusStderr);
    process.exitCode = cfg.statusExit;
    return;
  }
  process.stderr.write('fake claude: unexpected argv ' + JSON.stringify(args));
  process.exitCode = 2;
}
if (which === 'auth' && cfg.hangMs > 0) setTimeout(finish, cfg.hangMs);
else finish();
`;
  const path = join(dir, 'claude');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return {
    dir,
    path,
    received(which) {
      const file = join(dir, `received.${which}.json`);
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8')) as Received;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
