import { join, resolve } from 'node:path';
import type { Env } from './env';

/**
 * Set to `true` by the npm package's bundler (esbuild `define` in
 * `packaging/npm/build.ts`), never by a user: the bundles in
 * `<package>/dist` know at build time that they are the packaged layout.
 */
declare const __ORBIT_PACKAGED__: boolean | undefined;

export type LayoutKind = 'dev' | 'packaged';

/**
 * Where Orbit's non-code assets live (ADR-017). The dev tree runs the
 * TypeScript sources through tsx; the npm package `orbit-bots` ships its
 * bundles and the same assets under `dist/`:
 *
 * | asset             | dev tree                              | packaged                       |
 * | ----------------- | ------------------------------------- | ------------------------------ |
 * | built App         | `apps/orbit-app/dist`                 | `dist/app`                     |
 * | mock fixtures     | `packages/runtime/fixtures`           | `dist/fixtures`                |
 * | CLI hook script   | `packages/runtime/bin/orbit-hook.mjs` | `dist/orbit-hook.mjs`          |
 * | reference plugins | `plugins/<id>` (TypeScript servers)   | `dist/plugins/<id>/server.mjs` |
 * | orbitd            | `apps/orbitd/src/bin.ts` (with tsx)   | `dist/orbitd.mjs`              |
 */
export interface OrbitLayout {
  kind: LayoutKind;
  /** The checkout root, or the installed package's root. */
  root: string;
  /** The built App orbitd serves, unless `ORBIT_APP_DIR` says otherwise (see `appDir`). */
  appDir: string;
  fixturesDir: string;
  /** The PreToolUse command hook the CliDriver hands Claude Code (ADR-008). */
  hookScript: string;
  /** The reference plugins, one folder with an `orbit-plugin.json` each (ADR-014). */
  pluginsDir: string;
  /** How the CLI starts orbitd: `process.execPath` with these arguments. */
  orbitd: { entry: string; args: string[] };
  /** The tsx loader for `${tsx}` in plugin commands; null where TypeScript is not run (packaged). */
  tsx: string | null;
}

/**
 * The layout for a module directory: `packages/runtime/src` in the dev tree,
 * `<package>/dist` (where every bundle sits) when packaged. Pure, for tests.
 */
export function resolveLayout(
  kind: LayoutKind,
  moduleDir: string,
  resolveTsx: () => string | null = () => null,
): OrbitLayout {
  if (kind === 'packaged') {
    const dist = resolve(moduleDir);
    const entry = join(dist, 'orbitd.mjs');
    return {
      kind,
      root: resolve(dist, '..'),
      appDir: join(dist, 'app'),
      fixturesDir: join(dist, 'fixtures'),
      hookScript: join(dist, 'orbit-hook.mjs'),
      pluginsDir: join(dist, 'plugins'),
      orbitd: { entry, args: [entry] },
      tsx: null,
    };
  }
  const root = resolve(moduleDir, '../../..');
  const entry = join(root, 'apps', 'orbitd', 'src', 'bin.ts');
  const tsx = resolveTsx();
  return {
    kind,
    root,
    appDir: join(root, 'apps', 'orbit-app', 'dist'),
    fixturesDir: join(root, 'packages', 'runtime', 'fixtures'),
    hookScript: join(root, 'packages', 'runtime', 'bin', 'orbit-hook.mjs'),
    pluginsDir: join(root, 'plugins'),
    // The dev tree's orbitd is TypeScript: preload tsx.
    orbitd: { entry, args: tsx ? ['--import', tsx, entry] : [entry] },
    tsx,
  };
}

/** Which layout this code runs in: fixed when the npm package is bundled. */
export function layoutKind(): LayoutKind {
  return typeof __ORBIT_PACKAGED__ !== 'undefined' && __ORBIT_PACKAGED__ ? 'packaged' : 'dev';
}

function devTsx(): string | null {
  try {
    return import.meta.resolve('tsx');
  } catch {
    return null;
  }
}

let cached: OrbitLayout | undefined;

/** This process's layout (computed once). */
export function orbitLayout(): OrbitLayout {
  cached ??= resolveLayout(layoutKind(), import.meta.dirname, devTsx);
  return cached;
}

/** Where the built App lives: `ORBIT_APP_DIR`, else the layout's App folder. */
export function appDir(env: Env, layout: OrbitLayout = orbitLayout()): string {
  return resolve(env.ORBIT_APP_DIR ?? layout.appDir);
}
