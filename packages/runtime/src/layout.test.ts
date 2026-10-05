import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from './drivers/fixtures';
import { HOOK_SCRIPT } from './drivers/cli';
import { appDir, layoutKind, orbitLayout, resolveLayout } from './layout';
import { builtinPluginsDir, defaultPluginPaths } from './plugins/registry';

const REPO = resolve(import.meta.dirname, '../../..');

describe('asset layout (ADR-017)', () => {
  it('the dev tree: sources run through tsx, assets sit in the checkout', () => {
    const l = resolveLayout('dev', '/src/orbit/packages/runtime/src', () => 'file:///tsx/esm.mjs');
    expect(l).toEqual({
      kind: 'dev',
      root: '/src/orbit',
      appDir: '/src/orbit/apps/orbit-app/dist',
      fixturesDir: '/src/orbit/packages/runtime/fixtures',
      hookScript: '/src/orbit/packages/runtime/bin/orbit-hook.mjs',
      pluginsDir: '/src/orbit/plugins',
      orbitd: {
        entry: '/src/orbit/apps/orbitd/src/bin.ts',
        args: ['--import', 'file:///tsx/esm.mjs', '/src/orbit/apps/orbitd/src/bin.ts'],
      },
      tsx: 'file:///tsx/esm.mjs',
    });
  });

  it('the npm package: bundles in dist/, no tsx anywhere', () => {
    const l = resolveLayout(
      'packaged',
      '/usr/lib/node_modules/orbit-bots/dist',
      () => 'file:///never-asked.mjs',
    );
    expect(l).toEqual({
      kind: 'packaged',
      root: '/usr/lib/node_modules/orbit-bots',
      appDir: '/usr/lib/node_modules/orbit-bots/dist/app',
      fixturesDir: '/usr/lib/node_modules/orbit-bots/dist/fixtures',
      hookScript: '/usr/lib/node_modules/orbit-bots/dist/orbit-hook.mjs',
      pluginsDir: '/usr/lib/node_modules/orbit-bots/dist/plugins',
      orbitd: {
        entry: '/usr/lib/node_modules/orbit-bots/dist/orbitd.mjs',
        args: ['/usr/lib/node_modules/orbit-bots/dist/orbitd.mjs'],
      },
      tsx: null,
    });
  });

  it('ORBIT_APP_DIR still overrides the App folder in either layout', () => {
    const packaged = resolveLayout('packaged', '/opt/orbit-bots/dist');
    expect(appDir({}, packaged)).toBe('/opt/orbit-bots/dist/app');
    expect(appDir({ ORBIT_APP_DIR: '/srv/app' }, packaged)).toBe('/srv/app');
    expect(appDir({ ORBIT_APP_DIR: 'rel' }, packaged)).toBe(resolve('rel'));
  });

  it('this checkout is the dev layout and every asset it names exists', () => {
    // Nothing a user sets switches layouts: only the package's bundler does.
    expect(layoutKind()).toBe('dev');
    const l = orbitLayout();
    expect(l.root).toBe(REPO);
    expect(existsSync(l.hookScript)).toBe(true);
    expect(existsSync(join(l.fixturesDir, 'README.md'))).toBe(true);
    expect(existsSync(join(l.pluginsDir, 'github', 'orbit-plugin.json'))).toBe(true);
    expect(existsSync(l.orbitd.entry)).toBe(true);
    expect(l.tsx).toMatch(/^file:/);
    expect(l.orbitd.args).toEqual(['--import', l.tsx, l.orbitd.entry]);
  });

  it('the hook script, fixtures, plugins and plugin paths all come from the layout', () => {
    const l = orbitLayout();
    expect(HOOK_SCRIPT).toBe(l.hookScript);
    expect(FIXTURES_DIR).toBe(l.fixturesDir);
    expect(builtinPluginsDir()).toBe(l.pluginsDir);
    expect(defaultPluginPaths()).toEqual({ node: process.execPath, tsx: l.tsx });
  });
});
