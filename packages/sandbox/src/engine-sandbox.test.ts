import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { engineSandboxSettings, isWithin } from './engine-sandbox';

const home = '/home/alice';
const orbitHome = join(home, '.orbit');
const workspace = join(orbitHome, 'workspaces', 'bot');

interface Settings {
  enabled: boolean;
  failIfUnavailable: boolean;
  autoAllowBashIfSandboxed: boolean;
  allowUnsandboxedCommands: boolean;
  filesystem: { allowWrite: string[]; denyRead: string[]; allowRead: string[] };
  network: { allowedDomains: string[]; strictAllowlist: boolean };
}

const settings = (over: Partial<Parameters<typeof engineSandboxSettings>[0]> = {}) =>
  engineSandboxSettings({
    workspace,
    home,
    orbitHome,
    network: 'none',
    allowedDomains: [],
    readRoots: [],
    ...over,
  }) as unknown as Settings;

describe('engineSandboxSettings', () => {
  it('fails closed: enabled, no unsandboxed escape, no Bash auto-allow', () => {
    const s = settings();
    expect(s.enabled).toBe(true);
    expect(s.failIfUnavailable).toBe(true);
    expect(s.autoAllowBashIfSandboxed).toBe(false);
    expect(s.allowUnsandboxedCommands).toBe(false);
  });

  it('allows writes to exactly the workspace', () => {
    expect(settings().filesystem.allowWrite).toEqual([workspace]);
  });

  it('denies reads of credential stores and orbitHome, never of the workspace', () => {
    const { denyRead, allowRead } = settings().filesystem;
    for (const p of [
      '.claude',
      '.claude.json',
      '.ssh',
      '.aws',
      '.azure',
      '.kube',
      '.docker',
      '.gnupg',
      '.netrc',
      '.config/gcloud',
      '.config/gh',
    ]) {
      expect(denyRead).toContain(join(home, p));
    }
    expect(denyRead).toContain(orbitHome);
    expect(denyRead).not.toContain(workspace);
    // The workspace lives inside orbitHome, so it is re-opened explicitly.
    expect(allowRead).toContain(workspace);
  });

  it('never names the OAuth credential file (the whole ~/.claude dir is denied)', () => {
    expect(JSON.stringify(settings())).not.toMatch(/\.credentials\.json/);
  });

  it('keeps readRoots unless they overlap a denied path', () => {
    const { allowRead } = settings({
      readRoots: [
        '/srv/docs',
        home,
        join(home, '.ssh', 'keys'),
        join(orbitHome, 'workspaces', 'other'),
      ],
    }).filesystem;
    expect(allowRead).toEqual(['/srv/docs', workspace]);
  });

  it('uses a strict, empty network allowlist for network none', () => {
    expect(settings({ allowedDomains: ['example.com'] }).network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
    });
  });

  it('uses a strict allowlist of the given domains for network allowlist', () => {
    expect(
      settings({
        network: 'allowlist',
        allowedDomains: ['api.github.com', 'api.github.com', 'pypi.org'],
      }).network,
    ).toEqual({ allowedDomains: ['api.github.com', 'pypi.org'], strictAllowlist: true });
  });

  it('refuses a workspace inside a credential store', () => {
    expect(() => settings({ workspace: join(home, '.ssh', 'ws') })).toThrow(/credential store/);
  });
});

describe('isWithin', () => {
  it('handles equality, nesting and prefix lookalikes', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b/c', '/a/b')).toBe(true);
    expect(isWithin('/a/bc', '/a/b')).toBe(false);
    expect(isWithin('/a', '/a/b')).toBe(false);
  });
});
