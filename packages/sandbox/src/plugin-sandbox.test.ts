import { describe, expect, it } from 'vitest';
import {
  type PluginSandboxInput,
  bwrapArgs,
  detectPluginSandbox,
  pluginSandboxSpec,
  sbplString,
  seatbeltProfile,
  wrapPluginCommand,
} from './plugin-sandbox';

const HOME = '/home/owner';
const ORBIT = '/home/owner/.orbit';

function input(over: Partial<PluginSandboxInput> = {}): PluginSandboxInput {
  return {
    platform: 'linux',
    home: HOME,
    orbitHome: ORBIT,
    denied: [
      { path: `${HOME}/.ssh`, kind: 'dir' },
      { path: `${HOME}/.netrc`, kind: 'file' },
      { path: ORBIT, kind: 'dir' },
      { path: '/proc', kind: 'dir' },
    ],
    pluginDir: '/opt/orbit/plugins/fs',
    runtime: ['/opt/node22'],
    system: [{ path: '/usr' }, { path: '/bin', symlink: 'usr/bin' }, { path: '/etc' }],
    folders: [],
    workspace: null,
    git: null,
    network: false,
    ...over,
  };
}

/** The value after each occurrence of `flag`. */
const after = (args: string[], flag: string) =>
  args.flatMap((a, i) => (a === flag ? [args.slice(i + 1, i + 3).join(' ')] : []));

describe('pluginSandboxSpec', () => {
  it('drops folders and runtime roots that overlap a denied path, either way round', () => {
    const spec = pluginSandboxSpec(
      input({
        folders: [
          { path: HOME, access: 'read' }, // contains ~/.ssh
          { path: `${HOME}/.ssh/keys`, access: 'read' }, // inside ~/.ssh
          { path: `${ORBIT}/workspaces/other`, access: 'write' }, // another Bot's workspace
          { path: `${HOME}/Documents`, access: 'write' },
          { path: `${HOME}/Documents/`, access: 'read' }, // the same folder: wider access wins
        ],
        runtime: ['/opt/node22', `${HOME}/.ssh`],
      }),
    );
    expect(spec.folders).toEqual([{ path: `${HOME}/Documents`, access: 'write' }]);
    expect(spec.runtime).toEqual(['/opt/node22']);
    expect(spec.dropped.map((d) => d.path)).toEqual([
      HOME,
      `${HOME}/.ssh/keys`,
      `${ORBIT}/workspaces/other`,
      `${HOME}/.ssh`,
    ]);
    expect(spec.dropped[0]?.reason).toMatch(/overlaps \/home\/owner\/\.ssh/);
  });

  it('works in the workspace when it is bound, else in the empty home', () => {
    expect(pluginSandboxSpec(input()).cwd).toBe(HOME);
    const ws = `${ORBIT}/workspaces/bot_1`;
    expect(pluginSandboxSpec(input({ workspace: { path: ws, access: 'read' } })).cwd).toBe(ws);
    expect(
      pluginSandboxSpec(input({ platform: 'darwin', privateDir: '/private/tmp/orbit-p1' })).cwd,
    ).toBe('/private/tmp/orbit-p1/home');
  });
});

describe('bwrapArgs', () => {
  it('builds the whole sandbox in order: namespaces, system, fresh dirs, empty home, runtime, plugin', () => {
    expect(bwrapArgs(pluginSandboxSpec(input()))).toEqual([
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/bin',
      '/bin',
      '--ro-bind',
      '/etc',
      '/etc',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      HOME,
      '--ro-bind',
      '/opt/node22',
      '/opt/node22',
      '--ro-bind',
      '/opt/orbit/plugins/fs',
      '/opt/orbit/plugins/fs',
      '--chdir',
      HOME,
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--setenv',
      'TMP',
      '/tmp',
      '--setenv',
      'TEMP',
      '/tmp',
      '--',
    ]);
  });

  it('shares the network only when a tool needs it', () => {
    expect(bwrapArgs(pluginSandboxSpec(input()))).not.toContain('--share-net');
    expect(bwrapArgs(pluginSandboxSpec(input({ network: true })))).toContain('--share-net');
    // --unshare-all always comes first: without --share-net the network namespace is private.
    expect(bwrapArgs(pluginSandboxSpec(input({ network: true })))[0]).toBe('--unshare-all');
  });

  it('binds owner folders as declared and the workspace read-only or read-write', () => {
    const ws = `${ORBIT}/workspaces/bot_1`;
    const ro = bwrapArgs(
      pluginSandboxSpec(
        input({
          folders: [
            { path: '/data/notes', access: 'read' },
            { path: '/data/out', access: 'write' },
          ],
          workspace: { path: ws, access: 'read' },
        }),
      ),
    );
    expect(after(ro, '--ro-bind')).toContain('/data/notes /data/notes');
    expect(after(ro, '--bind')).toEqual(['/data/out /data/out']);
    expect(after(ro, '--ro-bind')).toContain(`${ws} ${ws}`);
    const rw = bwrapArgs(pluginSandboxSpec(input({ workspace: { path: ws, access: 'write' } })));
    expect(after(rw, '--bind')).toEqual([`${ws} ${ws}`]);
    expect(rw.slice(rw.indexOf('--chdir'), rw.indexOf('--chdir') + 2)).toEqual(['--chdir', ws]);
  });

  it('masks denied paths that lie inside a bind (dirs with a tmpfs, files with /dev/null), before the workspace', () => {
    const ws = '/srv/orbit/workspaces/bot_1';
    const args = bwrapArgs(
      pluginSandboxSpec(
        input({
          orbitHome: '/srv/orbit',
          denied: [
            { path: '/srv/orbit', kind: 'dir' },
            { path: '/etc/orbit-secret', kind: 'file' },
            { path: `${HOME}/.ssh`, kind: 'dir' }, // under the tmpfs home: nothing to mask
          ],
          system: [{ path: '/usr' }, { path: '/etc' }, { path: '/srv' }],
          workspace: { path: ws, access: 'write' },
        }),
      ),
    );
    const mask = args.indexOf('/srv/orbit', args.indexOf('--tmpfs', args.indexOf(HOME)));
    expect(args[mask - 1]).toBe('--tmpfs');
    expect(after(args, '--ro-bind')).toContain('/dev/null /etc/orbit-secret');
    expect(args).not.toContain(`${HOME}/.ssh`);
    // The workspace inside the masked $ORBIT_HOME is bound back afterwards.
    expect(args.lastIndexOf(ws)).toBeGreaterThan(mask);
  });

  it("binds a worktree Bot's git directory with its config, hooks and info read-only on top", () => {
    const git = '/home/owner/src/repo/.git';
    const args = bwrapArgs(
      pluginSandboxSpec(
        input({
          workspace: { path: `${ORBIT}/workspaces/bot_1`, access: 'write' },
          git: {
            dir: git,
            access: 'write',
            protect: [`${git}/config`, `${git}/hooks`, `${git}/info`],
          },
        }),
      ),
    );
    const at = args.indexOf(git);
    expect(args[at - 1]).toBe('--bind');
    expect(after(args, '--ro-bind')).toEqual(
      expect.arrayContaining([
        `${git}/config ${git}/config`,
        `${git}/hooks ${git}/hooks`,
        `${git}/info ${git}/info`,
      ]),
    );
    expect(args.indexOf(`${git}/config`)).toBeGreaterThan(at);
    const ro = bwrapArgs(
      pluginSandboxSpec(input({ git: { dir: git, access: 'read', protect: [] } })),
    );
    expect(ro[ro.indexOf(git) - 1]).toBe('--ro-bind');
  });

  it('never carries environment values (the env stays buildPluginEnv)', () => {
    const args = bwrapArgs(pluginSandboxSpec(input({ network: true })));
    const setenv = args.flatMap((a, i) => (a === '--setenv' ? [args[i + 1]] : []));
    expect(setenv).toEqual(['TMPDIR', 'TMP', 'TEMP']);
  });

  it('wraps the command after the separator', () => {
    const w = wrapPluginCommand(
      { kind: 'bwrap', path: '/usr/bin/bwrap' },
      pluginSandboxSpec(input()),
      { command: '/opt/node22/bin/node', args: ['/opt/orbit/plugins/fs/server.js'] },
    );
    expect(w.command).toBe('/usr/bin/bwrap');
    expect(w.args.slice(-3)).toEqual([
      '--',
      '/opt/node22/bin/node',
      '/opt/orbit/plugins/fs/server.js',
    ]);
  });
});

describe('seatbeltProfile', () => {
  const mac = (over: Partial<PluginSandboxInput> = {}) =>
    pluginSandboxSpec(
      input({
        platform: 'darwin',
        home: '/Users/owner',
        orbitHome: '/Users/owner/.orbit',
        denied: [
          { path: '/Users/owner/.ssh', kind: 'dir' },
          { path: '/Users/owner/.orbit', kind: 'dir' },
        ],
        pluginDir: '/Users/owner/src/orbit/plugins/fs',
        runtime: ['/opt/homebrew/Cellar/node/22.1.0'],
        system: [],
        privateDir: '/private/var/folders/x/T/orbit-plugin-1',
        tempRoots: ['/private/var/folders', '/private/tmp'],
        ...over,
      }),
    );

  it('denies by default and reads outside home, Orbit data and shared temp folders', () => {
    const p = seatbeltProfile(mac());
    expect(p.startsWith('(version 1)\n(deny default)\n')).toBe(true);
    expect(p).toContain(
      '(allow file-read* (require-all (subpath "/") (require-not (subpath "/Users/owner")) (require-not (subpath "/Users/owner/.orbit")) (require-not (subpath "/Users/owner/.ssh")) (require-not (subpath "/private/var/folders")) (require-not (subpath "/private/tmp"))))',
    );
    expect(p).toContain('(subpath "/Users/owner/src/orbit/plugins/fs")');
    expect(p).toContain('(subpath "/private/var/folders/x/T/orbit-plugin-1")');
    expect(p).not.toContain('(allow network*)');
    expect(p).not.toContain('com.apple.dnssd.service');
    // No rule ever allows writes outside the private directory and /dev/null here.
    expect(p).toContain(
      '(allow file-write* (subpath "/private/var/folders/x/T/orbit-plugin-1") (literal "/dev/null"))',
    );
  });

  it('allows the network and name resolution only when a tool needs it', () => {
    const p = seatbeltProfile(mac({ network: true }));
    expect(p).toContain('(allow network*)');
    expect(p).toContain('(global-name "com.apple.dnssd.service")');
  });

  it('writes to writable folders and the workspace; a git directory without config, hooks and info', () => {
    const ws = '/Users/owner/.orbit/workspaces/bot_1';
    const git = '/Users/owner/src/repo/.git';
    const p = seatbeltProfile(
      mac({
        folders: [{ path: '/Volumes/data', access: 'write' }],
        workspace: { path: ws, access: 'write' },
        git: { dir: git, access: 'write', protect: [`${git}/config`, `${git}/hooks`] },
      }),
    );
    expect(p).toContain(`(subpath "/Volumes/data") (subpath "${ws}"))`);
    expect(p).toContain(
      `(allow file-write* (require-all (subpath "${git}") (require-not (subpath "${git}/config")) (require-not (subpath "${git}/hooks"))))`,
    );
  });

  it('keeps denied paths out of a readable folder that contains them', () => {
    const p = seatbeltProfile(
      mac({
        pluginDir: '/opt/plugins/x',
        runtime: [],
        denied: [{ path: '/opt/plugins/x/.npmrc', kind: 'file' }],
      }),
    );
    expect(p).toContain(
      '(require-all (subpath "/opt/plugins/x") (require-not (subpath "/opt/plugins/x/.npmrc")))',
    );
  });

  it('escapes quotes and backslashes and refuses control characters', () => {
    expect(sbplString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"');
    expect(() => sbplString('/a\nb')).toThrow(/control characters/);
  });

  it('needs a private directory', () => {
    expect(() => seatbeltProfile(mac({ privateDir: undefined }))).toThrow(/private directory/);
  });

  it('wraps the command with -p and the profile', () => {
    const w = wrapPluginCommand({ kind: 'sandbox-exec', path: '/usr/bin/sandbox-exec' }, mac(), {
      command: '/usr/local/bin/node',
      args: ['server.js'],
    });
    expect(w.args[0]).toBe('-p');
    expect(w.args[1]).toMatch(/^\(version 1\)/);
    expect(w.args.slice(2)).toEqual(['/usr/local/bin/node', 'server.js']);
  });
});

describe('detectPluginSandbox', () => {
  const ok = () => ({ code: 0, stderr: '' });

  it('linux: available when bwrap is on PATH and builds a sandbox', () => {
    const calls: string[][] = [];
    const s = detectPluginSandbox({
      platform: 'linux',
      pathEnv: '/usr/local/bin:/usr/bin',
      exists: (p) => p === '/usr/bin/bwrap',
      probe: (c, a) => {
        calls.push([c, ...a]);
        return ok();
      },
    });
    expect(s).toEqual({
      available: true,
      engine: 'bwrap',
      path: '/usr/bin/bwrap',
      reason: null,
      platform: 'linux',
    });
    expect(calls[0]?.slice(0, 2)).toEqual(['/usr/bin/bwrap', '--unshare-all']);
  });

  it('linux: says why when bwrap is missing or cannot build namespaces', () => {
    expect(
      detectPluginSandbox({ platform: 'linux', pathEnv: '/usr/bin', exists: () => false }),
    ).toMatchObject({
      available: false,
      engine: null,
      reason: 'bubblewrap (bwrap) is not installed',
    });
    const denied = detectPluginSandbox({
      platform: 'linux',
      pathEnv: '/usr/bin',
      exists: () => true,
      probe: () => ({ code: 1, stderr: 'bwrap: setting up uid map: Permission denied\n' }),
    });
    expect(denied.available).toBe(false);
    expect(denied.reason).toMatch(/cannot create a sandbox here \(bwrap: setting up uid map/);
  });

  it('darwin: sandbox-exec; other platforms: none', () => {
    expect(
      detectPluginSandbox({ platform: 'darwin', exists: () => true, probe: ok }),
    ).toMatchObject({ available: true, engine: 'sandbox-exec', path: '/usr/bin/sandbox-exec' });
    expect(detectPluginSandbox({ platform: 'darwin', exists: () => false })).toMatchObject({
      available: false,
      reason: 'sandbox-exec is missing',
    });
    expect(detectPluginSandbox({ platform: 'win32' })).toMatchObject({
      available: false,
      reason: 'no plugin sandbox on win32',
    });
  });
});
