import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WORKSPACE_LIST_LIMIT,
  listWorkspace,
  readWorkspaceFile,
  workspacePathSegments,
} from './workspace-files';

let home: string;
let ws: string;
const secret = () => join(home, 'daemon.token');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orbit-wsfiles-'));
  mkdirSync(join(home, 'workspaces'));
  ws = join(home, 'workspaces', 'bot_1');
  mkdirSync(ws);
  writeFileSync(secret(), 'orbit-daemon-token-value');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('workspace paths', () => {
  it('accepts relative names and refuses anything that could leave or reveal', () => {
    expect(workspacePathSegments('')).toEqual([]);
    expect(workspacePathSegments('notes/./a.md')).toEqual(['notes', 'a.md']);
    for (const bad of [
      '../daemon.token',
      'notes/../../x',
      '/etc/passwd',
      'C:/x',
      'a\\b',
      'a\0b',
      '.git/config',
      'sub/.GIT/HEAD',
      'x/'.repeat(70),
    ]) {
      expect(() => workspacePathSegments(bad), bad).toThrow(
        expect.objectContaining({ code: 'invalid_input' }),
      );
    }
  });
});

describe('listing a workspace', () => {
  it('lists directories first, then files by name; hides .git; shows links without following', () => {
    mkdirSync(join(ws, 'notes'));
    writeFileSync(join(ws, 'b.txt'), 'bb');
    writeFileSync(join(ws, 'a.txt'), 'a');
    writeFileSync(join(ws, '.git'), 'gitdir: /somewhere');
    symlinkSync(secret(), join(ws, 'token-link'));
    const l = listWorkspace(ws, '');
    expect(l.exists).toBe(true);
    expect(l.entries.map((e) => [e.name, e.kind, e.size])).toEqual([
      ['notes', 'directory', null],
      ['a.txt', 'file', 1],
      ['b.txt', 'file', 2],
      ['token-link', 'symlink', null],
    ]);
    expect(listWorkspace(ws, 'notes')).toMatchObject({ path: 'notes', entries: [] });
  });

  it('a Bot that never ran has no workspace yet', () => {
    rmSync(ws, { recursive: true });
    expect(listWorkspace(ws, '')).toEqual({
      path: '',
      exists: false,
      entries: [],
      truncated: false,
    });
    expect(() => listWorkspace(ws, 'notes')).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('never lists through a symbolic link, nor a workspace that is one', () => {
    symlinkSync(home, join(ws, 'up'));
    expect(() => listWorkspace(ws, 'up')).toThrow(/symbolic link/);
    const elsewhere = join(home, 'workspaces', 'bot_2');
    symlinkSync(home, elsewhere);
    expect(() => listWorkspace(elsewhere, '')).toThrow(/not a plain directory/);
  });

  it('caps a huge directory and says so', () => {
    for (let i = 0; i < WORKSPACE_LIST_LIMIT + 5; i++) writeFileSync(join(ws, `f${i}`), '');
    const l = listWorkspace(ws, '');
    expect(l.entries).toHaveLength(WORKSPACE_LIST_LIMIT);
    expect(l.truncated).toBe(true);
  });
});

describe('previewing a file', () => {
  it('shows text, with size and time', () => {
    mkdirSync(join(ws, 'notes'));
    writeFileSync(join(ws, 'notes', 'a.md'), '# Hello\n');
    expect(readWorkspaceFile(ws, 'notes/a.md')).toMatchObject({
      path: 'notes/a.md',
      size: 8,
      kind: 'text',
      text: '# Hello\n',
      truncated: false,
    });
  });

  it('never reads through a symbolic link, wherever it sits on the path', () => {
    symlinkSync(secret(), join(ws, 'token'));
    expect(() => readWorkspaceFile(ws, 'token')).toThrow(/symbolic link/);
    symlinkSync(home, join(ws, 'home'));
    expect(() => readWorkspaceFile(ws, 'home/daemon.token')).toThrow(/symbolic link/);
  });

  it('refuses a hard link to a file outside (it would be the same file)', () => {
    linkSync(secret(), join(ws, 'innocent.txt'));
    expect(() => readWorkspaceFile(ws, 'innocent.txt')).toThrow(/hard links/);
  });

  it('refuses a FIFO without blocking, and directories', () => {
    if (process.platform === 'win32') return;
    execFileSync('mkfifo', [join(ws, 'pipe')]);
    expect(() => readWorkspaceFile(ws, 'pipe')).toThrow(/not a file/);
    mkdirSync(join(ws, 'dir'));
    expect(() => readWorkspaceFile(ws, 'dir')).toThrow(/not a file/);
    expect(() => readWorkspaceFile(ws, '')).toThrow(/Name a file/);
  });

  it('does not show binary files', () => {
    writeFileSync(join(ws, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(join(ws, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(readWorkspaceFile(ws, 'img.png')).toMatchObject({ kind: 'binary', text: null });
    expect(readWorkspaceFile(ws, 'latin1.txt')).toMatchObject({ kind: 'binary', text: null });
  });

  it('shows the start of a large file, even when the cut splits a character', () => {
    writeFileSync(join(ws, 'big.txt'), `${'a'.repeat(9)}é and more`);
    const p = readWorkspaceFile(ws, 'big.txt', 10);
    expect(p).toMatchObject({ kind: 'text', text: 'a'.repeat(9), truncated: true });
  });

  it('missing files are not found', () => {
    expect(() => readWorkspaceFile(ws, 'nope.txt')).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
    writeFileSync(join(ws, 'file'), 'x');
    expect(() => readWorkspaceFile(ws, 'file/inside')).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});
