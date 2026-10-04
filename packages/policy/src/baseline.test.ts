import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { baselinePolicy, isInside } from './baseline';

const root = mkdtempSync(join(tmpdir(), 'orbit-policy-'));
const ws = join(root, 'ws');
const outside = join(root, 'outside');
mkdirSync(ws);
mkdirSync(outside);
symlinkSync(outside, join(ws, 'escape'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const policy = baselinePolicy(ws);
const ask = (toolName: string, input: Record<string, unknown> = {}) =>
  policy({ toolName, input, toolUseId: 't', parentToolUseId: null }, new AbortController().signal);

describe('baseline default-deny policy', () => {
  it.each(['Read', 'Glob', 'Grep', 'Task'])('allows read-only %s', async (tool) => {
    expect((await ask(tool)).behavior).toBe('allow');
  });

  it.each(['Bash', 'WebFetch', 'WebSearch', 'mcp__gmail__send', 'SomethingNew', ''])(
    'denies %s by default',
    async (tool) => {
      expect((await ask(tool, { command: 'echo hi' })).behavior).toBe('deny');
    },
  );

  it('allows writes inside the workspace, relative or absolute', async () => {
    expect((await ask('Write', { file_path: join(ws, 'a.txt') })).behavior).toBe('allow');
    expect((await ask('Edit', { file_path: 'notes/new.md' })).behavior).toBe('allow');
  });

  it('denies writes outside the workspace, via .. or via symlinks', async () => {
    expect((await ask('Write', { file_path: '/etc/passwd' })).behavior).toBe('deny');
    expect((await ask('Write', { file_path: join(ws, '..', 'outside', 'x') })).behavior).toBe(
      'deny',
    );
    expect((await ask('Write', { file_path: join(ws, 'escape', 'x') })).behavior).toBe('deny');
    expect((await ask('Write', {})).behavior).toBe('deny');
  });

  it('isInside handles the root itself and prefix look-alikes', () => {
    expect(isInside(ws, ws)).toBe(true);
    expect(isInside(ws, `${ws}-evil/x`)).toBe(false);
  });
});
