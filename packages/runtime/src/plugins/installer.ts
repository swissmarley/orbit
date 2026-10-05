import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ExactVersion,
  NpmPackageName,
  OrbitError,
  PluginCatalog,
  type PluginCatalogEntry,
  type PluginCatalogListing,
  type PluginInstallPreview,
  type PluginManifest,
  type PluginStatus,
  Sha512Integrity,
  errorMessage,
  pluginSandboxNeeds,
  pluginToolName,
} from '@orbit/core';
import { type AuditSink, effectivePluginTier } from '@orbit/policy';
import { isWithin } from '@orbit/sandbox';
import { z } from 'zod';
import { type LoadedManifest, describeServer, loadManifest } from './manifest';
import type { PluginRegistry } from './registry';
import {
  DEFAULT_EXTRACT_LIMITS,
  type ExtractLimits,
  PACKAGE_DIR,
  readTarball,
  verifyIntegrity,
  writeEntries,
  writeInstallRecord,
} from './store';

/**
 * Installing plugins from the catalog or npm (ADR-019). orbitd downloads the
 * tarball from the configured registry, checks its SRI before reading it,
 * unpacks it with the strict extractor into the plugin store (outside
 * `$ORBIT_HOME`), checks that the manifest starts a server shipped inside the
 * package, and registers it like a folder the owner added: off until enabled.
 * Nothing in the package runs during an install (no scripts, no `npm install`).
 */

export const PluginInstallRequest = z.discriminatedUnion('source', [
  z.object({ source: z.literal('catalog'), id: z.string().min(1).max(64) }),
  z.object({
    source: z.literal('npm'),
    package: NpmPackageName,
    version: ExactVersion,
    integrity: Sha512Integrity,
  }),
]);
export type PluginInstallRequest = z.infer<typeof PluginInstallRequest>;

const MAX_CATALOG_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

export interface PluginInstallerDeps {
  registry: PluginRegistry;
  /** The store folder (outside $ORBIT_HOME). */
  storeDir: string;
  orbitHome: string;
  catalogUrl: string;
  npmRegistry: string;
  fetch?: typeof fetch;
  now?: () => Date;
  audit?: AuditSink;
  limits?: ExtractLimits;
}

/** npm's tarball address: `<registry>/<name>/-/<unscoped name>-<version>.tgz`. */
export function tarballUrl(registry: string, pkg: string, version: string): string {
  const base = registry.replace(/\/+$/, '');
  return `${base}/${pkg}/-/${basename(pkg)}-${version}.tgz`;
}

/** Read a response body, refusing more than `max` bytes. */
async function readCapped(res: Response, max: number, what: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) throw new OrbitError('invalid_input', `${what} is too large`);
  if (!res.body) return Buffer.alloc(0);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value: Uint8Array = chunk.value;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new OrbitError('invalid_input', `${what} is too large`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * The stdio server of an installed package must be Orbit's Node running a
 * JavaScript file inside the package: no other executable, no Node options
 * that load code from elsewhere, no `${tsx}` (Orbit's development loader).
 */
export function checkPackagedServer(m: PluginManifest, pkgDir: string): void {
  const bad = (why: string): never => {
    throw new OrbitError('invalid_input', `The package was refused: ${why}`, {
      hint: 'An installed plugin ships its own server: "command": "${node}", "args": ["${pluginDir}/<file>.js", …].',
    });
  };
  if (m.server.transport !== 'stdio') {
    bad('its server is remote (http); add such plugins by folder');
    return;
  }
  if (m.server.command !== '${node}') bad(`its command is ${m.server.command}, not \${node}`);
  if ([m.server.command, ...m.server.args].some((a) => a.includes('${tsx}'))) {
    bad('it needs ${tsx}, which packaged Orbit does not ship');
  }
  const [script, ...rest] = m.server.args;
  if (!script?.startsWith('${pluginDir}/')) {
    bad('its first argument is not a file inside the package (${pluginDir}/…)');
    return;
  }
  if (rest.some((a) => a.includes('${node}'))) bad('it passes ${node} as an argument');
  const rel = script.slice('${pluginDir}/'.length);
  if (rel.includes('${')) bad(`${script} uses another placeholder`);
  const abs = resolve(pkgDir, rel);
  if (!isWithin(abs, pkgDir) || abs === resolve(pkgDir)) bad(`${script} leaves the package`);
  if (!/\.(m|c)?js$/.test(abs)) bad(`${script} is not a JavaScript file`);
  let isFile: boolean;
  try {
    isFile = statSync(abs).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) bad(`${script} is not in the package`);
}

export class PluginInstaller {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly deps: PluginInstallerDeps) {
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
    if (isWithin(resolve(deps.storeDir), resolve(deps.orbitHome))) {
      throw new OrbitError(
        'invalid_config',
        `The plugin store ${deps.storeDir} is inside Orbit's data folder, where Bots can write`,
        { hint: 'Set plugins.storeDir (ORBIT_PLUGIN_STORE) to a folder outside $ORBIT_HOME.' },
      );
    }
  }

  get storeDir(): string {
    return resolve(this.deps.storeDir);
  }

  // ── the catalog ────────────────────────────────────────────────────────────

  async readCatalog(): Promise<PluginCatalog> {
    const url = this.deps.catalogUrl;
    let text: string;
    try {
      if (url.startsWith('file:')) {
        const path = fileURLToPath(url);
        if (statSync(path).size > MAX_CATALOG_BYTES) throw new Error('the catalog is too large');
        text = readFileSync(path, 'utf8');
      } else {
        const res = await this.fetchFn(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = (await readCapped(res, MAX_CATALOG_BYTES, 'The catalog')).toString('utf8');
      }
    } catch (err) {
      throw new OrbitError(
        'engine_error',
        `Could not read the plugin catalog at ${url}: ${errorMessage(err)}`,
        {
          hint: 'Check plugins.catalogUrl (ORBIT_PLUGIN_CATALOG_URL), or install by package: orbit plugin install npm:<package>@<version> --integrity sha512-…',
        },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new OrbitError('engine_error', `The plugin catalog at ${url} is not JSON`);
    }
    const parsed = PluginCatalog.safeParse(json);
    if (!parsed.success) {
      throw new OrbitError(
        'engine_error',
        `The plugin catalog at ${url} is not valid: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  /** The catalog with what is already known here; a catalog that cannot be read is an `error`. */
  async listing(): Promise<PluginCatalogListing> {
    let catalog: PluginCatalog;
    try {
      catalog = await this.readCatalog();
    } catch (err) {
      return { url: this.deps.catalogUrl, description: '', entries: [], error: errorMessage(err) };
    }
    const known = new Map(this.deps.registry.list().map((p) => [p.id, p]));
    return {
      url: this.deps.catalogUrl,
      description: catalog.description,
      entries: catalog.plugins.map((e) => {
        // A known plugin whose manifest cannot be read has no version ('').
        const version = known.get(e.id)?.version ?? '';
        return {
          ...e,
          installed: known.has(e.id),
          installedVersion: version === '' ? null : version,
        };
      }),
      error: null,
    };
  }

  // ── installing ─────────────────────────────────────────────────────────────

  private async resolveRequest(req: PluginInstallRequest): Promise<{
    pkg: string;
    version: string;
    integrity: string;
    entry: PluginCatalogEntry | null;
  }> {
    if (req.source === 'npm') {
      return { pkg: req.package, version: req.version, integrity: req.integrity, entry: null };
    }
    const catalog = await this.readCatalog();
    const entry = catalog.plugins.find((p) => p.id === req.id);
    if (!entry) {
      throw new OrbitError('not_found', `The catalog lists no plugin "${req.id}"`, {
        hint: 'See `orbit plugin catalog`.',
      });
    }
    return { pkg: entry.package, version: entry.version, integrity: entry.integrity, entry };
  }

  private async download(pkg: string, version: string, integrity: string): Promise<Buffer> {
    const url = tarballUrl(this.deps.npmRegistry, pkg, version);
    let res: Response;
    try {
      res = await this.fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      throw new OrbitError(
        'engine_error',
        `Could not download ${pkg}@${version}: ${errorMessage(err)}`,
      );
    }
    if (res.status === 404) {
      throw new OrbitError('not_found', `The registry has no ${pkg}@${version}`, {
        hint: `Looked at ${url}`,
      });
    }
    if (!res.ok) {
      throw new OrbitError(
        'engine_error',
        `The registry answered HTTP ${res.status} for ${pkg}@${version}`,
      );
    }
    const limits = this.deps.limits ?? DEFAULT_EXTRACT_LIMITS;
    const bytes = await readCapped(res, limits.maxCompressedBytes, `${pkg}@${version}`);
    // The SRI is checked before a byte of the tarball is interpreted.
    verifyIntegrity(bytes, integrity);
    return bytes;
  }

  private preview(
    loaded: LoadedManifest,
    meta: { pkg: string; version: string; integrity: string; fromCatalog: boolean },
    counts: { files: number; bytes: number },
  ): PluginInstallPreview {
    const m = loaded.manifest;
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      package: meta.pkg,
      packageVersion: meta.version,
      integrity: meta.integrity,
      manifestHash: loaded.hash,
      fromCatalog: meta.fromCatalog,
      server: describeServer(m.server),
      tools: m.tools.map((t) => {
        const engineName = pluginToolName(m.id, t.name);
        return {
          name: t.name,
          engineName,
          description: t.description,
          declaredTier: t.tier,
          tier: effectivePluginTier(engineName, t.tier).tier,
          egress: t.egress,
        };
      }),
      secrets: m.secrets
        .filter((s) => s.scope === 'plugin')
        .map((s) => ({ name: s.name, description: s.description, required: s.required })),
      settings: m.settings.map((s) => ({ name: s.name, description: s.description })),
      env: m.env,
      sandbox: pluginSandboxNeeds(m),
      files: counts.files,
      bytes: counts.bytes,
    };
  }

  /**
   * Download, verify and unpack a package; with `dryRun` only report what it
   * would install (and keep nothing). Otherwise store it and register it,
   * disabled, like a folder the owner added.
   */
  async install(
    req: PluginInstallRequest,
    by: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<{ preview: PluginInstallPreview; plugin: PluginStatus | null }> {
    const { pkg, version, integrity, entry } = await this.resolveRequest(req);
    const known = new Set(this.deps.registry.list().map((p) => p.id));
    if (entry && known.has(entry.id) && !opts.dryRun) {
      throw new OrbitError('conflict', `A plugin named "${entry.id}" is already known`, {
        hint: `Remove it first (orbit plugin rm ${entry.id}) to install another version.`,
      });
    }
    const bytes = await this.download(pkg, version, integrity);
    const entries = readTarball(bytes, this.deps.limits ?? DEFAULT_EXTRACT_LIMITS);

    const store = this.storeDir;
    mkdirSync(store, { recursive: true, mode: 0o700 });
    const staging = join(store, `.staging-${randomBytes(8).toString('hex')}`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      const pkgDir = join(staging, PACKAGE_DIR);
      const counts = writeEntries(entries, pkgDir);
      const loaded = loadManifest(pkgDir);
      const m = loaded.manifest;
      checkPackageJson(pkgDir, pkg, version);
      if (entry && m.id !== entry.id) {
        throw new OrbitError(
          'invalid_input',
          `The package's manifest names "${m.id}", but the catalog lists it as "${entry.id}"`,
        );
      }
      if (entry?.manifestHash && entry.manifestHash !== loaded.hash) {
        throw new OrbitError(
          'invalid_input',
          `The package's manifest is not the one the catalog vouches for (hash ${loaded.hash}, expected ${entry.manifestHash})`,
          { hint: 'Nothing was installed.' },
        );
      }
      checkPackagedServer(m, pkgDir);
      const preview = this.preview(
        loaded,
        { pkg, version, integrity, fromCatalog: entry !== null },
        counts,
      );
      if (opts.dryRun) return { preview, plugin: null };
      if (known.has(m.id)) {
        throw new OrbitError('conflict', `A plugin named "${m.id}" is already known`, {
          hint: `Remove it first (orbit plugin rm ${m.id}) to install another version.`,
        });
      }
      const final = join(store, `${m.id}@${version}`);
      // A leftover from an install that never registered: it is ours to replace.
      if (existsSync(final)) rmSync(final, { recursive: true, force: true });
      renameSync(staging, final);
      writeInstallRecord(final, {
        id: m.id,
        package: pkg,
        version,
        integrity,
        manifestHash: loaded.hash,
        installedAt: this.now().toISOString(),
      });
      let plugin: PluginStatus;
      try {
        plugin = this.deps.registry.registerInstalled(join(final, PACKAGE_DIR), by);
      } catch (err) {
        rmSync(final, { recursive: true, force: true });
        throw err;
      }
      this.deps.audit?.append({
        actor: by,
        action: 'plugin.installed',
        subject: m.id,
        data: { package: pkg, version, integrity, hash: loaded.hash, catalog: entry !== null },
      });
      return { preview, plugin };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

/** The package's own package.json must name what was asked for. */
function checkPackageJson(pkgDir: string, pkg: string, version: string): void {
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    throw new OrbitError('invalid_input', 'The package was refused: it has no valid package.json');
  }
  const m = meta as { name?: unknown; version?: unknown };
  if (m.name !== pkg || m.version !== version) {
    throw new OrbitError(
      'invalid_input',
      `The package was refused: its package.json names ${String(m.name)}@${String(m.version)}, not ${pkg}@${version}`,
    );
  }
}
