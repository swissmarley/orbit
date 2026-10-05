import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@orbit/store';
import { describe, expect, it } from 'vitest';
import { WHOLE_WORKSPACE, WorkspaceTaint, workspaceRelative } from './workspace-taint';

describe('WorkspaceTaint', () => {
  it('maps paths into the workspace and rejects outside ones', () => {
    expect(workspaceRelative('/w', '/w/notes/a.md')).toBe('notes/a.md');
    expect(workspaceRelative('/w', 'notes/a.md')).toBe('notes/a.md');
    expect(workspaceRelative('/w', '/w')).toBe('');
    expect(workspaceRelative('/w', '/etc/passwd')).toBeNull();
    expect(workspaceRelative('/w', '/w/../x')).toBeNull();
  });

  it('a marked file exposes its sources; others stay clean', () => {
    const t = new WorkspaceTaint(openDatabase(':memory:'));
    t.mark('bot_1', 'notes/page.md', ['WebFetch'], 'run_1');
    expect(t.exposure('bot_1', 'notes/page.md')).toEqual(['file:notes/page.md', 'WebFetch']);
    expect(t.exposure('bot_1', 'other.md')).toEqual([]);
    expect(t.exposure('bot_2', 'notes/page.md')).toEqual([]);
  });

  it('a directory read (Grep/Glob) is exposed to marked files beneath it', () => {
    const t = new WorkspaceTaint(openDatabase(':memory:'));
    t.mark('bot_1', 'notes/page.md', ['WebFetch'], 'run_1');
    expect(t.exposure('bot_1', 'notes', { directory: true })).toContain('WebFetch');
    expect(t.exposure('bot_1', '', { directory: true })).toContain('WebFetch');
    expect(t.exposure('bot_1', 'src', { directory: true })).toEqual([]);
  });

  it('the whole-workspace mark taints every read', () => {
    const t = new WorkspaceTaint(openDatabase(':memory:'));
    t.mark('bot_1', WHOLE_WORKSPACE, ['Bash'], 'run_1');
    expect(t.exposure('bot_1', 'anything.txt')).toEqual(['workspace', 'Bash']);
  });

  it('merges sources on repeated marks, clears one file or all', () => {
    const t = new WorkspaceTaint(openDatabase(':memory:'));
    t.mark('bot_1', 'a', ['WebFetch'], 'run_1');
    t.mark('bot_1', 'a', ['mcp__mail__read_email'], 'run_2');
    expect(t.list('bot_1')[0]?.sources).toEqual(['WebFetch', 'mcp__mail__read_email']);
    t.mark('bot_1', 'b', ['x'], 'run_2');
    t.clear('bot_1', 'a');
    expect(t.list('bot_1').map((r) => r.path)).toEqual(['b']);
    expect(t.clearAll('bot_1')).toBe(1);
    expect(t.list('bot_1')).toEqual([]);
  });
});

describe('workspace paths are canonical (review M6 M2)', () => {
  it('a symlink inside the workspace resolves to the file it points to', () => {
    const ws = mkdtempSync(join(tmpdir(), 'orbit-ws-'));
    writeFileSync(join(ws, 'notes.md'), 'x');
    symlinkSync(join(ws, 'notes.md'), join(ws, 'alias.md'));
    expect(workspaceRelative(ws, join(ws, 'alias.md'))).toBe('notes.md');
    expect(workspaceRelative(ws, 'sub/../notes.md')).toBe('notes.md');
    expect(workspaceRelative(ws, 'new/file.md')).toBe('new/file.md');
    expect(workspaceRelative(ws, '..foo')).toBe('..foo');
    const t = new WorkspaceTaint(openDatabase(':memory:'));
    t.mark('bot_1', workspaceRelative(ws, 'notes.md') ?? '', ['WebFetch'], 'run_1');
    expect(t.exposure('bot_1', workspaceRelative(ws, 'alias.md') ?? '')).toContain('WebFetch');
  });
});
