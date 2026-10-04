import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { baselinePolicy, isInside } from './baseline';

const root = mkdtempSync(join(tmpdir(), 'orbit-policy-'));
const home = join(root, 'home');
const orbitHome = join(home, '.orbit');
const ws = join(orbitHome, 'workspaces', 'bot');
const outside = join(root, 'outside');
const shared = join(root, 'shared');
for (const d of [ws, outside, shared, join(home, '.claude'), join(home, '.aws')])
  mkdirSync(d, { recursive: true });
writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
symlinkSync(outside, join(ws, 'escape'));
symlinkSync(join(home, '.claude'), join(ws, 'creds'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const policy = baselinePolicy({ workspace: ws, readRoots: [shared], home, orbitHome });
const ask = async (toolName: string, input: Record<string, unknown> = {}) =>
  (
    await policy(
      { toolName, input, toolUseId: 't', parentToolUseId: null },
      new AbortController().signal,
    )
  ).behavior;

describe('baseline default-deny policy', () => {
  describe('reads', () => {
    it('allows reads inside the workspace and explicit read roots', async () => {
      expect(await ask('Read', { file_path: join(ws, 'notes.txt') })).toBe('allow');
      expect(await ask('Read', { file_path: 'notes.txt' })).toBe('allow');
      expect(await ask('Read', { file_path: join(shared, 'doc.md') })).toBe('allow');
      expect(await ask('Glob', { pattern: '**/*.md' })).toBe('allow');
      expect(await ask('Glob', { pattern: `${ws}/**/*.md` })).toBe('allow');
      expect(await ask('Grep', { pattern: 'TODO' })).toBe('allow');
      expect(await ask('Grep', { pattern: 'x', path: ws })).toBe('allow');
    });

    it.each([
      ['Read', { file_path: join(home, '.claude', '.credentials.json') }],
      ['Read', { file_path: '~/.claude/.credentials.json' }],
      ['Read', { file_path: join(home, '.aws', 'credentials') }],
      ['Read', { file_path: '/proc/self/environ' }],
      ['Read', { file_path: '/etc/passwd' }],
      ['Read', { file_path: join(orbitHome, 'orbit.db') }],
      ['Read', { file_path: join(ws, 'creds', '.credentials.json') }],
      ['Read', { file_path: join(ws, 'escape', 'secret') }],
      ['Read', { file_path: '../../orbit.db' }],
      ['Glob', { pattern: '/home/**/*.json' }],
      ['Glob', { pattern: '../**' }],
      ['Grep', { pattern: 'key', path: '/' }],
      ['Grep', { pattern: 'key', glob: '~/.ssh/*' }],
      ['LS', { path: home }],
    ])('denies %s %j', async (tool, input) => {
      expect(await ask(tool, input)).toBe('deny');
    });
  });

  describe('writes', () => {
    it('allows writes inside the workspace, relative or absolute', async () => {
      expect(await ask('Write', { file_path: join(ws, 'a.txt') })).toBe('allow');
      expect(await ask('Edit', { file_path: 'notes/new.md' })).toBe('allow');
    });

    it.each([
      ['/etc/passwd'],
      ['~/.claude/settings.json'],
      ['~/.orbit/config.json'],
      ['~'],
      ['~root/.bashrc'],
      [join(ws, '..', 'other', 'x')],
      [join(ws, 'escape', 'x')],
      [`${ws}-evil/x`],
      [join(ws, 'CLAUDE.md')],
      [join(ws, '.claude', 'settings.json')],
      [join(ws, 'sub', '.mcp.json')],
      [join(ws, '.git', 'hooks', 'pre-commit')],
    ])('denies a write to %s', async (path) => {
      expect(await ask('Write', { file_path: path })).toBe('deny');
    });

    it('denies writes without a path and never writes into read roots', async () => {
      expect(await ask('Write', {})).toBe('deny');
      expect(await ask('Write', { file_path: join(shared, 'x') })).toBe('deny');
    });
  });

  it.each(['Bash', 'WebFetch', 'WebSearch', 'mcp__gmail__send', 'SomethingNew', ''])(
    'denies %s by default',
    async (tool) => {
      expect(await ask(tool, { command: 'echo hi' })).toBe('deny');
    },
  );

  it('allows delegation and todo bookkeeping', async () => {
    expect(await ask('Task', { description: 'x' })).toBe('allow');
    expect(await ask('TodoWrite', { todos: [] })).toBe('allow');
  });

  it('isInside handles the root itself, prefix look-alikes and ~', () => {
    expect(isInside(ws, ws)).toBe(true);
    expect(isInside(ws, `${ws}-evil/x`)).toBe(false);
    expect(isInside(ws, '~/x')).toBe(false);
  });
});
