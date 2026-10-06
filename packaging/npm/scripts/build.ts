/**
 * Build the `orbit-bots` npm package (ADR-017) into `packaging/npm/dist`:
 *
 *   dist/orbit.mjs, dist/orbitd.mjs   the CLI/TUI and the daemon (esbuild, ESM)
 *   dist/orbit-hook.mjs               the CliDriver's PreToolUse hook
 *   dist/app/                         the built App (vite build)
 *   dist/fixtures/                    the MockDriver's recordings
 *   dist/plugins/<id>/                each reference plugin: its manifest
 *                                     (server rewritten) and a bundled server.mjs
 *
 * Usage: pnpm --filter orbit-bots build [--no-app-build]
 * (--no-app-build reuses an existing apps/orbit-app/dist).
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { type BuildOptions, type Plugin, build } from 'esbuild';
import { ESM_SHIM, EXTERNAL, dependencyDrift, packagedManifest, scanBundle, toolEnv } from './lib';

const PKG = resolve(import.meta.dirname, '..');
const ROOT = resolve(PKG, '../..');
const DIST = join(PKG, 'dist');

function fail(message: string): never {
  process.stderr.write(`orbit-bots build: ${message}\n`);
  process.exit(1);
}

function step(message: string): void {
  process.stdout.write(`• ${message}\n`);
}

const published = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
  version: string;
  dependencies?: Record<string, string>;
};
const drift = dependencyDrift(ROOT, published);
if (drift.length) fail(`dependencies do not match the workspace:\n  ${drift.join('\n  ')}`);

/**
 * Ink loads React DevTools only when DEV=true, but its devtools module imports
 * `react-devtools-core` statically: give the bundle an inert stand-in.
 */
const noDevtools: Plugin = {
  name: 'no-react-devtools',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'orbit-stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'orbit-stub' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} };',
      loader: 'js',
    }));
  },
};

const common: BuildOptions = {
  absWorkingDir: ROOT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  jsx: 'automatic',
  // Stack traces stay readable; no source maps (they would embed build paths).
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
  external: [...EXTERNAL],
  plugins: [noDevtools],
  define: {
    // The marker `orbitLayout()` reads: these bundles are the packaged layout.
    __ORBIT_PACKAGED__: 'true',
    'process.env.NODE_ENV': '"production"',
  },
  banner: { js: ESM_SHIM },
};

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1. The App (orbitd serves it).
const appDist = join(ROOT, 'apps', 'orbit-app', 'dist');
if (!process.argv.includes('--no-app-build')) {
  step('building the App (vite)');
  const r = spawnSync('pnpm', ['--filter', '@orbit/app', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: toolEnv(process.env),
  });
  if (r.status !== 0) fail('the App build failed');
}
if (!existsSync(join(appDist, 'index.html'))) fail(`no built App in ${appDist}`);
cpSync(appDist, join(DIST, 'app'), { recursive: true });

// 2. orbit and orbitd. The entries carry their own `#!/usr/bin/env node`.
step('bundling orbit and orbitd');
await build({
  ...common,
  entryPoints: {
    orbit: 'apps/orbit-tui/src/bin.ts',
    orbitd: 'apps/orbitd/src/bin.ts',
  },
  outdir: DIST,
  outExtension: { '.js': '.mjs' },
  splitting: false,
});
for (const bin of ['orbit.mjs', 'orbitd.mjs']) chmodSync(join(DIST, bin), 0o755);

// 3. The CliDriver hook (plain JavaScript, copied as is) and the mock fixtures.
copyFileSync(
  join(ROOT, 'packages', 'runtime', 'bin', 'orbit-hook.mjs'),
  join(DIST, 'orbit-hook.mjs'),
);
chmodSync(join(DIST, 'orbit-hook.mjs'), 0o755);
cpSync(join(ROOT, 'packages', 'runtime', 'fixtures'), join(DIST, 'fixtures'), { recursive: true });

// 4. Reference plugins: a self-contained server.mjs each and the manifest that starts it.
step('bundling the reference plugins');
const pluginsSrc = join(ROOT, 'plugins');
for (const id of readdirSync(pluginsSrc).sort()) {
  const src = join(pluginsSrc, id);
  if (!existsSync(join(src, 'orbit-plugin.json'))) continue;
  const out = join(DIST, 'plugins', id);
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'orbit-plugin.json'),
    packagedManifest(readFileSync(join(src, 'orbit-plugin.json'), 'utf8')),
  );
  if (existsSync(join(src, 'README.md')))
    copyFileSync(join(src, 'README.md'), join(out, 'README.md'));
  await build({
    ...common,
    // Plugins run as separate processes: only Playwright stays outside.
    external: ['playwright-core'],
    entryPoints: [relative(ROOT, join(src, 'src', 'server.ts'))],
    outfile: join(out, 'server.mjs'),
  });
}

// 5. License and README sit next to package.json (npm always packs them).
copyFileSync(join(ROOT, 'LICENSE'), join(PKG, 'LICENSE'));

// 6. Nothing shipped may read Claude credentials or name this machine's paths.
const scanned: string[] = [];
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk(DIST);
const violations = files
  .filter((f) => /\.(m?js|json|html|css)$/.test(f))
  .flatMap((f) => {
    scanned.push(f);
    return scanBundle(relative(PKG, f), readFileSync(f, 'utf8'), ROOT);
  });
if (violations.length) fail(`bundle guard:\n${JSON.stringify(violations, null, 2)}`);

const kb = (f: string) => `${(statSync(f).size / 1024).toFixed(0)} KB`;
step(`orbit-bots ${published.version} built in ${relative(ROOT, DIST)}:`);
for (const f of [
  'orbit.mjs',
  'orbitd.mjs',
  ...readdirSync(join(DIST, 'plugins')).map((id) => `plugins/${id}/server.mjs`),
]) {
  process.stdout.write(`    ${f.padEnd(28)} ${kb(join(DIST, f))}\n`);
}
const total = files.reduce((n, f) => n + statSync(f).size, 0);
process.stdout.write(
  `    ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB; bundle guard: ${scanned.length} files clean\n`,
);
