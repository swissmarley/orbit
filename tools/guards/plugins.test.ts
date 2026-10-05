import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PluginCatalog, PluginManifest, isAllowedPluginVar } from '../../packages/core/src/plugin';
import { effectivePluginTier } from '../../packages/policy/src/tiers';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const PLUGINS = join(ROOT, 'plugins');

/**
 * What each reference plugin's sandbox may get (ADR-019): only GitHub sees the
 * workspace (git), only Filesystem binds owner folders and has no network.
 */
const EXPECTED_SANDBOX: Record<string, unknown> = {
  github: { workspace: 'write', network: true, paths: [], nestedSandbox: false },
  slack: { workspace: 'none', network: true, paths: [], nestedSandbox: false },
  google: { workspace: 'none', network: true, paths: [], nestedSandbox: false },
  filesystem: {
    workspace: 'none',
    network: false,
    paths: [{ name: 'FS_ROOTS', access: 'write', parent: false, default: [] }],
    nestedSandbox: false,
  },
  browser: {
    workspace: 'none',
    network: true,
    paths: [
      { name: 'BROWSER_EXECUTABLE', access: 'read', parent: true, default: [] },
      {
        name: 'PLAYWRIGHT_BROWSERS_PATH',
        access: 'read',
        parent: false,
        default: ['~/.cache/ms-playwright', '~/Library/Caches/ms-playwright'],
      },
    ],
    nestedSandbox: true,
  },
};

/** Why a raw manifest's sandbox section is not explicit enough (workspace and network spelled out). */
function sandboxProblems(raw: Record<string, unknown>): string[] {
  const sb = raw.sandbox as Record<string, unknown> | undefined;
  if (!sb) return ['no sandbox section'];
  return ['workspace', 'network'].filter((k) => !(k in sb)).map((k) => `sandbox.${k} not stated`);
}

/** Every reference plugin (a plugins/<dir> with an orbit-plugin.json). */
const dirs = readdirSync(PLUGINS).filter((d) => existsSync(join(PLUGINS, d, 'orbit-plugin.json')));

describe('reference plugins (ADR-014)', () => {
  it('ships the five reference plugins', () => {
    expect(dirs.sort()).toEqual(['browser', 'filesystem', 'github', 'google', 'slack']);
  });

  describe.each(dirs)('%s', (dir) => {
    const manifest = PluginManifest.parse(
      JSON.parse(readFileSync(join(PLUGINS, dir, 'orbit-plugin.json'), 'utf8')) as unknown,
    );

    it('has a valid manifest whose id is its directory', () => {
      expect(manifest.id).toBe(dir);
      for (const v of [
        ...manifest.env,
        ...manifest.secrets.map((s) => s.name),
        ...manifest.settings.map((s) => s.name),
      ]) {
        expect(isAllowedPluginVar(v), v).toBe(true);
      }
    });

    it('declares exactly the tools its server offers, at tiers Orbit does not have to raise', async () => {
      const mod = (await import(join(PLUGINS, dir, 'src', 'tools.ts'))) as {
        tools: { name: string }[];
      };
      expect(mod.tools.map((t) => t.name).sort()).toEqual(manifest.tools.map((t) => t.name).sort());
      for (const t of manifest.tools) {
        expect(effectivePluginTier(`mcp__${manifest.id}__${t.name}`, t.tier).raised, t.name).toBe(
          false,
        );
      }
    });

    it('declares its OS sandbox needs explicitly (ADR-019), asking for no more than it uses', () => {
      const raw = JSON.parse(
        readFileSync(join(PLUGINS, dir, 'orbit-plugin.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(sandboxProblems(raw)).toEqual([]);
      expect(manifest.sandbox).toEqual(EXPECTED_SANDBOX[dir]);
    });

    it("starts through Orbit's own Node and tsx, never a shell", () => {
      expect(manifest.server).toEqual({
        transport: 'stdio',
        command: '${node}',
        args: ['--import', '${tsx}', '${pluginDir}/src/server.ts'],
      });
    });
  });

  it('sending tools are EXTERNAL and drafting is WRITE_LOCAL (drafting ≠ sending)', () => {
    const tier = (id: string, tool: string) =>
      PluginManifest.parse(
        JSON.parse(readFileSync(join(PLUGINS, id, 'orbit-plugin.json'), 'utf8')) as unknown,
      ).tools.find((t) => t.name === tool)?.tier;
    expect(tier('google', 'create_draft')).toBe('WRITE_LOCAL');
    expect(tier('google', 'send_draft')).toBe('EXTERNAL');
    expect(tier('slack', 'post_message')).toBe('EXTERNAL');
    expect(tier('github', 'git_commit')).toBe('WRITE_LOCAL');
    expect(tier('github', 'git_push')).toBe('EXTERNAL');
    expect(tier('github', 'create_pull_request')).toBe('EXTERNAL');
    expect(tier('filesystem', 'write_file')).toBe('EXTERNAL');
    expect(tier('browser', 'click')).toBe('EXTERNAL');
  });

  it('positive control: the sandbox check fires on a manifest that leaves its needs implicit', () => {
    expect(sandboxProblems({})).toEqual(['no sandbox section']);
    expect(sandboxProblems({ sandbox: { network: true } })).toEqual([
      'sandbox.workspace not stated',
    ]);
  });

  it('the shipped catalog parses and lists only exact, integrity-pinned packages', () => {
    const catalog = PluginCatalog.parse(
      JSON.parse(readFileSync(join(PLUGINS, 'catalog.json'), 'utf8')) as unknown,
    );
    for (const p of catalog.plugins) {
      expect(p.integrity, p.id).toMatch(/^sha512-/);
      expect(p.manifestHash, p.id).toBeDefined();
    }
  });
});
