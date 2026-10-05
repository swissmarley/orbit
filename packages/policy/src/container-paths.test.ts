import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@orbit/store';
import { afterAll, describe, expect, it } from 'vitest';
import { ApprovalQueue } from './approvals';
import { type PathMount, checkFileAccess, fileAccessContext, toHostPath } from './baseline';
import { diffForTool } from './card';
import { PolicyEngine } from './engine';

// A docker Bot (ADR-018): the engine sees /workspace (and /repo read-only);
// the policy checks the host directories behind them.
const root = mkdtempSync(join(tmpdir(), 'orbit-policy-ctr-'));
const home = join(root, 'home');
const orbitHome = join(home, '.orbit');
const ws = join(orbitHome, 'workspaces', 'bot_docker');
const repo = join(root, 'repo');
const outside = join(root, 'outside');
for (const d of [ws, repo, outside, join(home, '.claude'), join(ws, '.orbit-home', '.claude')]) {
  mkdirSync(d, { recursive: true });
}
writeFileSync(join(ws, 'notes.md'), 'old line\n');
symlinkSync(outside, join(ws, 'escape'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const mounts: PathMount[] = [
  { container: '/workspace', host: ws, writable: true },
  { container: '/repo', host: repo, writable: false },
];
// Read roots of a container Bot: its read-only mounts (the spec's host read roots are not mounted).
const files = fileAccessContext({ workspace: ws, readRoots: [repo], home, orbitHome, mounts });

describe('toHostPath', () => {
  const table: [string, string | null][] = [
    ['/workspace', ws],
    ['/workspace/notes.md', join(ws, 'notes.md')],
    ['/workspace/src/a/b.ts', join(ws, 'src', 'a', 'b.ts')],
    ['notes.md', join(ws, 'notes.md')],
    ['./src/../notes.md', join(ws, 'notes.md')],
    [
      '/workspace/.orbit-home/.claude/settings.json',
      join(ws, '.orbit-home', '.claude', 'settings.json'),
    ],
    ['/repo/README.md', join(repo, 'README.md')],
    ['/workspace/**/*.ts', join(ws, '**', '*.ts')],
    ['/workspacefoo/x', null],
    ['/workspace/../etc/passwd', null],
    ['../etc/passwd', null],
    ['/etc/passwd', null],
    ['/proc/1/environ', null],
    ['/run/orbit/api.sock', null],
    ['/tmp/x', null],
    [ws, null], // a host path means nothing inside the container
    ['/', null],
    ['~/.claude/x', '~/.claude/x'],
  ];
  for (const [path, expected] of table) {
    it(`${path} → ${expected ?? 'refused'}`, () => {
      expect(toHostPath(path, mounts)).toBe(expected);
    });
  }
});

describe('file confinement for a container Bot', () => {
  const check = (toolName: string, input: Record<string, unknown>) =>
    checkFileAccess(toolName, input, files);
  const table: [string, Record<string, unknown>, 'allow' | RegExp][] = [
    ['Read', { file_path: '/workspace/notes.md' }, 'allow'],
    ['Read', { file_path: 'notes.md' }, 'allow'],
    ['Read', { file_path: '/repo/README.md' }, 'allow'],
    ['Glob', { pattern: '/workspace/**/*.md' }, 'allow'],
    ['Glob', { pattern: '**/*.md' }, 'allow'],
    ['Grep', { pattern: 'TODO', path: '/workspace/src' }, 'allow'],
    ['Read', { file_path: '/workspace/.orbit-home/session.jsonl' }, 'allow'],
    ['Write', { file_path: '/workspace/out.txt', content: 'x' }, 'allow'],
    ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'allow'],
    ['Read', { file_path: '/etc/passwd' }, /outside the container's workspace/],
    ['Read', { file_path: '/proc/self/environ' }, /outside the container's workspace/],
    ['Read', { file_path: '/run/orbit/api.sock' }, /outside the container's workspace/],
    ['Read', { file_path: ws + '/notes.md' }, /outside the container's workspace/],
    [
      'Read',
      { file_path: join(home, '.claude', '.credentials.json') },
      /outside the container's workspace/,
    ],
    ['Glob', { pattern: '/**/*' }, /outside the container's workspace/],
    ['Read', { file_path: '/workspace/../etc/passwd' }, /Path traversal/],
    ['Read', { file_path: '/workspace/escape/secret' }, /outside the Bot workspace/],
    ['Read', { file_path: '~/.ssh/id_rsa' }, /Home-relative/],
    ['Write', { file_path: '/repo/README.md', content: 'x' }, /Writes outside the Bot workspace/],
    ['Write', { file_path: '/tmp/x', content: 'x' }, /outside the container's workspace/],
    [
      'Write',
      { file_path: '/workspace/escape/x', content: 'x' },
      /Writes outside the Bot workspace/,
    ],
    [
      'Write',
      { file_path: '/workspace/../../etc/cron.d/x', content: 'x' },
      /outside the container's workspace/,
    ],
    ['Write', { file_path: '/workspace/CLAUDE.md', content: 'x' }, /engine configuration/],
    [
      'Edit',
      {
        file_path: '/workspace/.orbit-home/.claude/settings.json',
        old_string: 'a',
        new_string: 'b',
      },
      /engine configuration/,
    ],
    [
      'Write',
      { file_path: '/workspace/.claude/settings.json', content: '{}' },
      /engine configuration/,
    ],
  ];
  for (const [tool, input, expected] of table) {
    it(`${tool} ${JSON.stringify(input)} → ${expected === 'allow' ? 'allow' : 'deny'}`, () => {
      const r = check(tool, input);
      if (expected === 'allow') expect(r).toBeNull();
      else expect(r).toMatch(expected);
    });
  }

  it('without mounts, host paths keep working as before (directory and worktree Bots)', () => {
    const host = fileAccessContext({ workspace: ws, home, orbitHome });
    expect(checkFileAccess('Read', { file_path: join(ws, 'notes.md') }, host)).toBeNull();
    expect(checkFileAccess('Read', { file_path: '/workspace/notes.md' }, host)).toMatch(
      /outside the Bot workspace/,
    );
  });

  it('the policy engine denies container paths outside the mounts before anything else', () => {
    const q = new ApprovalQueue(openDatabase(':memory:'));
    const engine = new PolicyEngine(q, q.ruleStore);
    const ctx = {
      botId: 'bot_docker',
      runId: 'run_1',
      files,
      shellContained: true,
      tainted: false,
    };
    const req = (toolName: string, input: Record<string, unknown>) => ({
      toolName,
      input,
      toolUseId: 't1',
      parentToolUseId: null,
    });
    expect(
      engine.evaluate(req('Write', { file_path: '/workspace/a.txt', content: 'x' }), ctx),
    ).toMatchObject({
      decision: 'allow',
      tier: 'WRITE_LOCAL',
    });
    expect(engine.evaluate(req('Read', { file_path: '/etc/shadow' }), ctx)).toMatchObject({
      decision: 'deny',
    });
    // No network in the container: Bash is a local change (ADR-018).
    expect(engine.evaluate(req('Bash', { command: 'make test' }), ctx)).toMatchObject({
      decision: 'allow',
      tier: 'WRITE_LOCAL',
    });
    // With an allowlist the container's shell is not contained: Bash needs approval.
    expect(
      engine.evaluate(req('Bash', { command: 'curl https://pypi.org' }), {
        ...ctx,
        shellContained: false,
      }),
    ).toMatchObject({ decision: 'ask', tier: 'EXTERNAL' });
  });

  it('approval-card diffs read the host file behind a container path', () => {
    const diff = diffForTool(
      'Edit',
      { file_path: '/workspace/notes.md', old_string: 'old', new_string: 'new' },
      ws,
      mounts,
    );
    expect(diff).toMatch(/-old line/);
    expect(diff).toMatch(/\+new line/);
    // Outside the mounts there is nothing to read on the host.
    expect(diffForTool('Write', { file_path: '/etc/hosts', content: 'x' }, ws, mounts)).toMatch(
      /\+x/,
    );
  });
});
