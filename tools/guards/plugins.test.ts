import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PluginManifest, isAllowedPluginVar } from '../../packages/core/src/plugin';
import { effectivePluginTier } from '../../packages/policy/src/tiers';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const PLUGINS = join(ROOT, 'plugins');

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
});
