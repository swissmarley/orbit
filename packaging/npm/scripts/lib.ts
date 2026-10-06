import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULES, type Violation, scanText } from '../../../tools/guards/scan';

/**
 * Pure pieces of the `orbit-bots` build (ADR-017), unit-tested in
 * `lib.test.ts`; `build.ts` does the file system work around them.
 */

/**
 * Modules the bundles import at run time instead of containing: native
 * addons, the Agent SDK (it locates its own engine binary next to itself),
 * the SDK's peers (one shared copy, so zod schemas and MCP servers Orbit
 * hands the SDK are the SDK's own kind) and Playwright (the Browser plugin;
 * it finds its browsers itself).
 */
export const EXTERNAL = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
  '@napi-rs/keyring',
  'better-sqlite3',
  'playwright-core',
  'zod',
] as const;

/** Where each external is declared in the monorepo (its version must not drift). */
export const EXTERNAL_SOURCES: Record<(typeof EXTERNAL)[number], string> = {
  '@anthropic-ai/claude-agent-sdk': 'packages/runtime',
  '@anthropic-ai/sdk': 'packages/runtime',
  '@modelcontextprotocol/sdk': 'packages/runtime',
  '@napi-rs/keyring': 'packages/policy',
  'better-sqlite3': 'packages/store',
  'playwright-core': 'plugins/browser',
  zod: 'packages/core',
};

interface PackageJson {
  dependencies?: Record<string, string>;
}

const readPackage = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;

/**
 * The package's `dependencies` must be exactly the externals, at the exact
 * versions the workspace packages use. Returns the problems (empty = fine).
 */
export function dependencyDrift(repoRoot: string, published: PackageJson): string[] {
  const problems: string[] = [];
  const deps = published.dependencies ?? {};
  for (const name of Object.keys(deps)) {
    if (!(EXTERNAL as readonly string[]).includes(name)) {
      problems.push(`${name} is a dependency but the bundles do not import it at run time`);
    }
  }
  for (const name of EXTERNAL) {
    const want = readPackage(join(repoRoot, EXTERNAL_SOURCES[name])).dependencies?.[name];
    const have = deps[name];
    if (have === undefined) problems.push(`${name} is external but not a dependency`);
    else if (!/^\d+\.\d+\.\d+$/.test(have))
      problems.push(`${name}@${have} is not an exact version`);
    else if (have !== want) {
      problems.push(`${name}@${have} differs from ${EXTERNAL_SOURCES[name]} (${String(want)})`);
    }
  }
  return problems;
}

/** How the reference plugins start in the dev tree (tools/guards/plugins.test.ts pins it). */
const DEV_SERVER = {
  transport: 'stdio',
  command: '${node}',
  args: ['--import', '${tsx}', '${pluginDir}/src/server.ts'],
};

/** How the packaged reference plugins start: their bundled server, no tsx. */
export const PACKAGED_SERVER = {
  transport: 'stdio',
  command: '${node}',
  args: ['${pluginDir}/server.mjs'],
};

/**
 * A reference plugin's manifest for the package: identical but for the
 * server, which runs the bundled `server.mjs`. Refuses a manifest that does
 * not start the way every reference plugin does (nothing else is rewritten).
 */
export function packagedManifest(text: string): string {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  if (JSON.stringify(manifest.server) !== JSON.stringify(DEV_SERVER)) {
    throw new Error(
      `Unexpected plugin server ${JSON.stringify(manifest.server)}; expected ${JSON.stringify(DEV_SERVER)}`,
    );
  }
  return `${JSON.stringify({ ...manifest, server: PACKAGED_SERVER }, null, 2)}\n`;
}

/** The repository's credential rules (ADR-005), applied to built JavaScript. */
const CREDENTIAL_RULES = RULES.filter((r) =>
  [
    'no-credential-file',
    'no-keychain-entry',
    'no-oauth-token-read',
    'no-oauth-token-property',
  ].includes(r.id),
).map((r) => ({ ...r, allow: () => false }));

/**
 * What must never be in a shipped bundle: a credential read (the source
 * guards scan TypeScript, this scans what esbuild produced, third-party
 * code included) or an absolute path of the build machine.
 */
export function scanBundle(path: string, text: string, buildRoot: string): Violation[] {
  const violations = scanText(path, text, CREDENTIAL_RULES);
  // The root as a whole path (not `/src` inside `packages/core/src/…`).
  const escaped = buildRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const absolute = new RegExp(`(^|[^\\w.~/-])${escaped}(?=$|[/\\\\'"\`\\s])`);
  text.split('\n').forEach((line, i) => {
    if (absolute.test(line)) {
      violations.push({
        rule: 'no-build-path',
        path,
        line: i + 1,
        text: line.trim().slice(0, 200),
      });
    }
  });
  return violations;
}

/**
 * Run at the top of every bundle: esbuild's ESM output has no `require`,
 * `__filename` or `__dirname`, which bundled CommonJS dependencies use.
 */
export const ESM_SHIM = [
  "import { createRequire as __orbitCreateRequire } from 'node:module';",
  "import { fileURLToPath as __orbitFileURLToPath } from 'node:url';",
  "import { dirname as __orbitDirname } from 'node:path';",
  'const require = __orbitCreateRequire(import.meta.url);',
  'const __filename = __orbitFileURLToPath(import.meta.url);',
  'const __dirname = __orbitDirname(__filename);',
].join('\n');

/** What pnpm and npm need from the developer's environment (registry, proxy, locale, temp). */
const TOOL_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'CI',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NPM_CONFIG_REGISTRY',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_CAFILE',
  'PNPM_HOME',
  // Windows essentials
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PROGRAMDATA',
]);
const TOOL_ENV_PREFIXES = ['LC_', 'XDG_', 'COREPACK_'];

/**
 * The environment of the pnpm and npm processes the build and the smoke test
 * start — and so of every install script they run: an allowlist, never the
 * developer's whole environment (an ANTHROPIC_API_KEY or OAuth token there
 * must not reach a dependency's postinstall; M8 review L7).
 */
export function toolEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (TOOL_ENV_NAMES.has(k) || TOOL_ENV_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
