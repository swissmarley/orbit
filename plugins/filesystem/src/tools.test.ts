import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ToolContext, handle } from '@orbit/plugin-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tools } from './tools';

const matching = (re: RegExp) => expect.stringMatching(re) as unknown as string;

let base: string;
let notes: string;
let ctx: ToolContext;

const call = async (name: string, args: Record<string, unknown>) => {
  const r = await handle(
    { name: 'filesystem', version: '0', tools },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ctx,
  );
  const result = r?.result as { content: { text: string }[]; isError: boolean };
  return { text: result.content[0]?.text ?? '', isError: result.isError };
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orbit-fs-'));
  notes = join(base, 'notes');
  mkdirSync(join(notes, 'sub'), { recursive: true });
  writeFileSync(join(notes, 'todo.md'), '# Todo\n- buy milk\n');
  writeFileSync(join(notes, 'sub', 'ideas.txt'), 'orbit plugins are neat\n');
  writeFileSync(join(base, 'secret.txt'), 'outside');
  ctx = { workspace: base, env: { FS_ROOTS: notes } };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('filesystem plugin', () => {
  it('lists, reads and searches inside the configured folders', async () => {
    expect((await call('list_directory', {})).text).toMatch(/dir +sub/);
    expect((await call('read_file', { path: 'todo.md' })).text).toContain('buy milk');
    expect((await call('search_files', { query: 'neat' })).text).toContain(
      'sub/ideas.txt: orbit plugins are neat',
    );
  });

  it('never reaches outside the folders: absolute paths, .. and symlinks', async () => {
    expect(await call('read_file', { path: join(base, 'secret.txt') })).toMatchObject({
      isError: true,
    });
    expect(await call('read_file', { path: '../secret.txt' })).toMatchObject({ isError: true });
    symlinkSync(join(base, 'secret.txt'), join(notes, 'link.txt'));
    expect(await call('read_file', { path: 'link.txt' })).toMatchObject({
      isError: true,
      text: matching(/outside/),
    });
    expect(await call('write_file', { path: 'link.txt', content: 'x' })).toMatchObject({
      isError: true,
    });
    expect(readFileSync(join(base, 'secret.txt'), 'utf8')).toBe('outside');
    expect(await call('write_file', { path: '../escape.txt', content: 'x' })).toMatchObject({
      isError: true,
    });
  });

  it('refuses credential stores, Orbit data and hidden files even inside a root (review H2)', async () => {
    const home = join(base, 'home');
    const orbitHome = join(home, 'orbit');
    const ws = join(orbitHome, 'workspaces', 'bot_1');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    mkdirSync(join(home, 'cloud'), { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    writeFileSync(join(home, 'cloud', 'credentials'), 'aws secret');
    writeFileSync(join(orbitHome, 'orbit.db'), 'database');
    writeFileSync(join(ws, 'draft.md'), 'the Bot’s own file');
    writeFileSync(join(home, '.env'), 'TOKEN=x');
    writeFileSync(join(home, 'plan.md'), 'plain notes');
    // The owner shares their whole home folder.
    ctx = {
      workspace: ws,
      env: {
        FS_ROOTS: home,
        ORBIT_WORKSPACE: ws,
        ORBIT_DENIED_PATHS: JSON.stringify([join(home, '.ssh'), join(home, 'cloud'), orbitHome]),
      },
    };
    expect((await call('read_file', { path: 'plan.md' })).text).toBe('plain notes');
    expect((await call('read_file', { path: 'orbit/workspaces/bot_1/draft.md' })).isError).toBe(
      false,
    );
    for (const path of [
      '.ssh/id_ed25519',
      join(home, '.ssh', 'id_ed25519'),
      'cloud/credentials',
      'orbit/orbit.db',
      '.env',
      '/proc/self/environ',
    ]) {
      expect(await call('read_file', { path }), path).toMatchObject({ isError: true });
    }
    // A link in a shared folder pointing at a denied file is followed, then refused.
    symlinkSync(join(home, 'cloud', 'credentials'), join(home, 'creds.txt'));
    expect(await call('read_file', { path: 'creds.txt' })).toMatchObject({
      isError: true,
      text: matching(/credentials or Orbit data/),
    });
    expect(await call('write_file', { path: 'orbit/orbit.db', content: 'x' })).toMatchObject({
      isError: true,
    });
    expect(readFileSync(join(orbitHome, 'orbit.db'), 'utf8')).toBe('database');
    const found = (await call('search_files', { query: 'secret', limit: 100 })).text;
    expect(found).toBe('No matches.');
    expect((await call('search_files', { query: 'database' })).text).toBe('No matches.');
    // Positive control: the same search finds plain files.
    expect((await call('search_files', { query: 'plain' })).text).toContain('plan.md');

    ctx = { ...ctx, env: { ...ctx.env, ORBIT_DENIED_PATHS: 'not json' } };
    expect(await call('read_file', { path: 'plan.md' })).toMatchObject({
      isError: true,
      text: matching(/nothing is reachable/),
    });
  });

  it('writes inside the folders, creating sub-folders only when asked', async () => {
    expect(await call('write_file', { path: 'new/a.md', content: 'hello' })).toMatchObject({
      isError: true,
    });
    expect(
      await call('write_file', { path: 'new/a.md', content: 'hello', createFolders: true }),
    ).toMatchObject({
      isError: false,
    });
    expect(readFileSync(join(notes, 'new', 'a.md'), 'utf8')).toBe('hello');
  });

  it('says clearly when it is not set up', async () => {
    ctx = { workspace: base, env: {} };
    expect(await call('list_directory', {})).toMatchObject({
      isError: true,
      text: matching(/FS_ROOTS/),
    });
  });
});
