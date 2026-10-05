import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Bot,
  OrbitError,
  type PluginManifest,
  type PluginState,
  type PluginStatus,
  errorMessage,
  pluginSecretKey,
  pluginToolName,
} from '@orbit/core';
import { type AuditSink, type ToolTierOverride, effectivePluginTier } from '@orbit/policy';
import type { OrbitDb } from '@orbit/store';
import type { Env } from '../env';
import { HttpMcpClient, type McpClient, type McpToolDef, StdioMcpClient } from './client';
import {
  type LoadedManifest,
  MANIFEST_FILE,
  buildPluginEnv,
  describeServer,
  expandCommand,
  loadManifest,
  resolveHeaders,
} from './manifest';

/** The reference plugins shipped with Orbit (`plugins/*` in the repository); null if unknown. */
export function builtinPluginsDir(): string | null {
  try {
    return fileURLToPath(new URL('../../../../plugins', import.meta.url));
  } catch {
    // Not loaded from a file (a bundled or browser-hosted test build).
    return null;
  }
}

/** Node and tsx for `${node}` / `${tsx}` in stdio commands (the dev tree runs TypeScript). */
export function defaultPluginPaths(): { node: string; tsx: string } {
  let tsx = 'tsx';
  try {
    tsx = import.meta.resolve('tsx');
  } catch {
    // Packaged builds ship JavaScript plugin servers.
  }
  return { node: process.execPath, tsx };
}

interface Row {
  id: string;
  dir: string;
  built_in: number;
  enabled: number;
  manifest_hash: string | null;
  enabled_at: string | null;
  tools: string | null;
  undeclared: string | null;
  checked_at: string | null;
  error: string | null;
  settings: string;
  updated_at: string;
}

export interface SecretStore {
  get(name: string): string | undefined;
  has(name: string): boolean;
  set(name: string, value: string): unknown;
  remove(name: string): boolean;
}

export interface ClientSpec {
  manifest: PluginManifest;
  dir: string;
  /** cwd of a stdio server: the Bot's workspace, or the plugin's scratch dir for checks. */
  cwd: string;
  workspace: string | null;
}

export interface PluginRegistryDeps {
  db: OrbitDb;
  vault: SecretStore;
  /** orbitd's own environment (read through the allowlist only). */
  env: Env;
  /** Where plugins keep check scratch space ($ORBIT_HOME/plugins). */
  home: string;
  builtInDir?: string | null;
  bots: () => Bot[];
  now?: () => Date;
  /** Redacts plugin error text (stderr may quote a token). */
  redact?: (s: string) => string;
  audit?: AuditSink;
  paths?: { node: string; tsx: string };
  /** Tests: a fake server instead of a process. */
  clientFactory?: (spec: ClientSpec, defaultClient: () => McpClient) => McpClient;
}

/** A plugin that is enabled, set up and checked: what a Run may use. */
export interface ReadyPlugin {
  manifest: PluginManifest;
  dir: string;
  /** Declared tools the server offers, with their input schemas. */
  tools: McpToolDef[];
}

/** One line, no control characters. */
function settingValueOk(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

/**
 * Known plugins and their state (ADR-014): the reference plugins in
 * `plugins/*` plus directories the owner added. Nothing is offered to a Bot
 * until the owner enables it; a manifest that changed afterwards is held back
 * until it is enabled again.
 */
export class PluginRegistry {
  private readonly now: () => Date;
  private readonly builtInDir: string | null;

  constructor(private readonly deps: PluginRegistryDeps) {
    this.now = deps.now ?? (() => new Date());
    this.builtInDir = deps.builtInDir === undefined ? builtinPluginsDir() : deps.builtInDir;
  }

  // ── discovery ──────────────────────────────────────────────────────────────

  private rows(): Map<string, Row> {
    const rows = this.deps.db.sqlite.prepare('SELECT * FROM plugins').all() as Row[];
    return new Map(rows.map((r) => [r.id, r]));
  }

  private row(id: string): Row | undefined {
    return this.deps.db.sqlite.prepare('SELECT * FROM plugins WHERE id = ?').get(id) as
      Row | undefined;
  }

  /** Reference plugins: every `plugins/<dir>/orbit-plugin.json`. */
  private builtIns(): Map<string, LoadedManifest | { error: string; dir: string }> {
    const out = new Map<string, LoadedManifest | { error: string; dir: string }>();
    const base = this.builtInDir;
    if (!base) return out;
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      return out;
    }
    for (const name of entries.sort()) {
      const dir = join(base, name);
      try {
        if (!statSync(join(dir, MANIFEST_FILE)).isFile()) continue;
      } catch {
        continue;
      }
      try {
        const loaded = loadManifest(dir);
        out.set(loaded.manifest.id, loaded);
      } catch (err) {
        out.set(name, { error: errorMessage(err), dir });
      }
    }
    return out;
  }

  /** Every known plugin: id → manifest (or why it could not be read). */
  private known(): Map<
    string,
    { loaded: LoadedManifest | null; error: string | null; dir: string; builtIn: boolean }
  > {
    const out = new Map<
      string,
      { loaded: LoadedManifest | null; error: string | null; dir: string; builtIn: boolean }
    >();
    for (const [id, b] of this.builtIns()) {
      out.set(
        id,
        'manifest' in b
          ? { loaded: b, error: null, dir: b.dir, builtIn: true }
          : { loaded: null, error: b.error, dir: b.dir, builtIn: true },
      );
    }
    for (const r of this.rows().values()) {
      if (r.built_in === 1 || out.has(r.id)) continue;
      try {
        const loaded = loadManifest(r.dir);
        out.set(
          r.id,
          loaded.manifest.id === r.id
            ? { loaded, error: null, dir: loaded.dir, builtIn: false }
            : {
                loaded: null,
                error: `The manifest in ${r.dir} now names "${loaded.manifest.id}"`,
                dir: r.dir,
                builtIn: false,
              },
        );
      } catch (err) {
        out.set(r.id, { loaded: null, error: errorMessage(err), dir: r.dir, builtIn: false });
      }
    }
    return out;
  }

  private manifestOf(id: string): { loaded: LoadedManifest; builtIn: boolean } {
    const k = this.known().get(id);
    if (!k)
      throw new OrbitError('not_found', `No plugin "${id}"`, { hint: 'See `orbit plugins`.' });
    if (!k.loaded) throw new OrbitError('invalid_config', k.error ?? `Plugin ${id} is unreadable`);
    return { loaded: k.loaded, builtIn: k.builtIn };
  }

  // ── status ─────────────────────────────────────────────────────────────────

  private settingsOf(row: Row | undefined): Record<string, string> {
    if (!row) return {};
    try {
      const v = JSON.parse(row.settings) as unknown;
      return typeof v === 'object' && v !== null ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private missing(manifest: PluginManifest, row: Row | undefined): string[] {
    const settings = this.settingsOf(row);
    return [
      ...manifest.secrets
        .filter((s) => s.required && !this.deps.vault.has(pluginSecretKey(manifest.id, s.name)))
        .map((s) => `secret ${s.name}`),
      ...manifest.settings
        .filter((s) => s.required && settings[s.name] === undefined && s.default === undefined)
        .map((s) => `setting ${s.name}`),
    ];
  }

  private stateOf(loaded: LoadedManifest, row: Row | undefined): PluginState {
    if (row?.enabled !== 1) return 'disabled';
    if (row.manifest_hash !== loaded.hash) return 'changed';
    if (this.missing(loaded.manifest, row).length > 0) return 'needs_setup';
    if (row.error) return 'error';
    return 'ready';
  }

  list(): PluginStatus[] {
    const rows = this.rows();
    const bots = this.deps.bots();
    return [...this.known()].map(([id, k]) => this.status(id, k, rows.get(id), bots));
  }

  get(id: string): PluginStatus {
    const k = this.known().get(id);
    if (!k)
      throw new OrbitError('not_found', `No plugin "${id}"`, { hint: 'See `orbit plugins`.' });
    return this.status(id, k, this.row(id), this.deps.bots());
  }

  private status(
    id: string,
    k: { loaded: LoadedManifest | null; error: string | null; dir: string; builtIn: boolean },
    row: Row | undefined,
    bots: Bot[],
  ): PluginStatus {
    const using = bots
      .filter((b) => b.spec.plugins.includes(id))
      .map((b) => ({ id: b.id, name: b.spec.name }));
    if (!k.loaded) {
      return {
        id,
        name: id,
        version: '',
        description: '',
        homepage: null,
        builtIn: k.builtIn,
        dir: k.dir,
        enabled: row?.enabled === 1,
        state: 'error',
        server: '',
        tools: [],
        secrets: [],
        settings: [],
        env: [],
        undeclaredTools: [],
        bots: using,
        warnings: [],
        error: k.error,
        checkedAt: row?.checked_at ?? null,
        enabledAt: row?.enabled_at ?? null,
      };
    }
    const m = k.loaded.manifest;
    const discovered = row?.tools ? (JSON.parse(row.tools) as McpToolDef[]) : null;
    const available = discovered ? new Set(discovered.map((t) => t.name)) : null;
    const settings = this.settingsOf(row);
    const warnings: string[] = [];
    const tools = m.tools.map((t) => {
      const engineName = pluginToolName(m.id, t.name);
      const eff = effectivePluginTier(engineName, t.tier);
      if (eff.raised) {
        warnings.push(
          `${t.name} is declared ${t.tier}, but its name says it sends or pays: Orbit treats it as ${eff.tier}.`,
        );
      }
      return {
        name: t.name,
        engineName,
        description: t.description,
        declaredTier: t.tier,
        tier: eff.tier,
        egress: t.egress,
        available: available ? available.has(t.name) : null,
      };
    });
    for (const t of tools) {
      if (t.available === false) warnings.push(`The server does not offer ${t.name}.`);
    }
    const state = this.stateOf(k.loaded, row);
    const missing = this.missing(m, row);
    if (state === 'changed') {
      warnings.push(
        'The manifest changed since you enabled this plugin: review it and enable it again.',
      );
    }
    if (missing.length > 0) warnings.push(`Needs ${missing.join(', ')}.`);
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      homepage: m.homepage ?? null,
      builtIn: k.builtIn,
      dir: k.dir,
      enabled: row?.enabled === 1,
      state,
      server: describeServer(m.server),
      tools,
      secrets: m.secrets.map((s) => ({
        name: s.name,
        description: s.description,
        required: s.required,
        set: this.deps.vault.has(pluginSecretKey(m.id, s.name)),
        vaultName: pluginSecretKey(m.id, s.name),
      })),
      settings: m.settings.map((s) => ({
        name: s.name,
        description: s.description,
        required: s.required,
        value: settings[s.name] ?? null,
        default: s.default ?? null,
      })),
      env: m.env,
      undeclaredTools: row?.undeclared ? (JSON.parse(row.undeclared) as string[]) : [],
      bots: using,
      warnings,
      error: row?.error ?? null,
      checkedAt: row?.checked_at ?? null,
      enabledAt: row?.enabled_at ?? null,
    };
  }

  // ── owner actions ──────────────────────────────────────────────────────────

  private upsert(id: string, dir: string, builtIn: boolean, patch: Partial<Row>): void {
    const existing = this.row(id);
    const base: Row = existing ?? {
      id,
      dir,
      built_in: builtIn ? 1 : 0,
      enabled: 0,
      manifest_hash: null,
      enabled_at: null,
      tools: null,
      undeclared: null,
      checked_at: null,
      error: null,
      settings: '{}',
      updated_at: this.now().toISOString(),
    };
    const r: Row = { ...base, ...patch, dir, updated_at: this.now().toISOString() };
    this.deps.db.sqlite
      .prepare(
        `INSERT INTO plugins (id, dir, built_in, enabled, manifest_hash, enabled_at, tools, undeclared, checked_at, error, settings, updated_at)
         VALUES (@id, @dir, @built_in, @enabled, @manifest_hash, @enabled_at, @tools, @undeclared, @checked_at, @error, @settings, @updated_at)
         ON CONFLICT(id) DO UPDATE SET dir=@dir, enabled=@enabled, manifest_hash=@manifest_hash,
           enabled_at=@enabled_at, tools=@tools, undeclared=@undeclared, checked_at=@checked_at,
           error=@error, settings=@settings, updated_at=@updated_at`,
      )
      .run(r);
  }

  /** Add a plugin from a directory with an `orbit-plugin.json` (disabled until enabled). */
  install(dir: string, by: string): PluginStatus {
    const loaded = loadManifest(dir);
    const id = loaded.manifest.id;
    if (this.known().has(id)) {
      throw new OrbitError('conflict', `A plugin named "${id}" is already known`);
    }
    this.upsert(id, loaded.dir, false, {});
    this.deps.audit?.append({
      actor: by,
      action: 'plugin.added',
      subject: id,
      data: { dir: loaded.dir, hash: loaded.hash },
    });
    return this.get(id);
  }

  /** Forget an added plugin and its secrets (reference plugins can only be disabled). */
  remove(id: string, by: string): void {
    const { loaded, builtIn } = this.manifestOf(id);
    if (builtIn) {
      throw new OrbitError('invalid_input', `${id} ships with Orbit; disable it instead`);
    }
    for (const s of loaded.manifest.secrets) this.deps.vault.remove(pluginSecretKey(id, s.name));
    this.deps.db.sqlite.prepare('DELETE FROM plugins WHERE id = ?').run(id);
    this.deps.audit?.append({ actor: by, action: 'plugin.removed', subject: id, data: {} });
  }

  /** Start the server once, list its tools and keep the declared ones' schemas. */
  async check(id: string, by: string): Promise<PluginStatus> {
    const { loaded, builtIn } = this.manifestOf(id);
    const m = loaded.manifest;
    const missing = this.missing(m, this.row(id));
    if (missing.length > 0) {
      const hints = [
        ...m.secrets
          .filter((s) => s.required && !this.deps.vault.has(pluginSecretKey(id, s.name)))
          .map((s) => `orbit plugin secret ${id} ${s.name} < file`),
        ...m.settings
          .filter((s) => missing.includes(`setting ${s.name}`))
          .map((s) => `orbit plugin setting ${id} ${s.name} <value>`),
      ];
      throw new OrbitError('invalid_input', `${m.name} needs ${missing.join(', ')} first`, {
        hint: `Set ${missing.length === 1 ? 'it' : 'them'} in Settings → Integrations, or: ${hints.join('; ')}`,
      });
    }
    const scratch = join(this.deps.home, 'plugins', id);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const client = this.client({ manifest: m, dir: loaded.dir, cwd: scratch, workspace: null });
    let patch: Partial<Row>;
    try {
      const offered = await client.listTools();
      const declared = new Set(m.tools.map((t) => t.name));
      patch = {
        tools: JSON.stringify(offered.filter((t) => declared.has(t.name))),
        undeclared: JSON.stringify(offered.filter((t) => !declared.has(t.name)).map((t) => t.name)),
        error: null,
        checked_at: this.now().toISOString(),
      };
    } catch (err) {
      patch = {
        error: (this.deps.redact ?? ((s) => s))(errorMessage(err)).slice(0, 1000),
        checked_at: this.now().toISOString(),
      };
    } finally {
      await client.close();
    }
    this.upsert(id, loaded.dir, builtIn, patch);
    this.deps.audit?.append({
      actor: by,
      action: 'plugin.checked',
      subject: id,
      data: { ok: patch.error === null },
    });
    return this.get(id);
  }

  /** Enable a plugin: check it, then record the manifest the owner saw. */
  async enable(id: string, by: string): Promise<PluginStatus> {
    const { loaded, builtIn } = this.manifestOf(id);
    const checked = await this.check(id, by);
    if (checked.error) {
      throw new OrbitError(
        'engine_error',
        `${loaded.manifest.name} did not start: ${checked.error}`,
      );
    }
    this.upsert(id, loaded.dir, builtIn, {
      enabled: 1,
      manifest_hash: loaded.hash,
      enabled_at: this.now().toISOString(),
    });
    this.deps.audit?.append({
      actor: by,
      action: 'plugin.enabled',
      subject: id,
      data: {
        hash: loaded.hash,
        tools: checked.tools.map((t) => `${t.name}:${t.tier}`),
        secrets: loaded.manifest.secrets.map((s) => s.name),
        env: loaded.manifest.env,
      },
    });
    return this.get(id);
  }

  disable(id: string, by: string): PluginStatus {
    const { loaded, builtIn } = this.manifestOf(id);
    this.upsert(id, loaded.dir, builtIn, { enabled: 0 });
    this.deps.audit?.append({ actor: by, action: 'plugin.disabled', subject: id, data: {} });
    return this.get(id);
  }

  setSetting(id: string, name: string, value: string | null, by: string): PluginStatus {
    const { loaded, builtIn } = this.manifestOf(id);
    if (!loaded.manifest.settings.some((s) => s.name === name)) {
      throw new OrbitError('invalid_input', `${id} has no setting ${name}`);
    }
    if (value !== null && (value.length > 2000 || !settingValueOk(value))) {
      throw new OrbitError('invalid_input', 'A setting is one line of at most 2000 characters');
    }
    const settings = Object.fromEntries(
      Object.entries(this.settingsOf(this.row(id))).filter(([k]) => k !== name),
    );
    if (value !== null) settings[name] = value;
    this.upsert(id, loaded.dir, builtIn, { settings: JSON.stringify(settings) });
    // Settings are not secret: the audit log may hold the value.
    this.deps.audit?.append({
      actor: by,
      action: 'plugin.setting',
      subject: id,
      data: { name, value },
    });
    return this.get(id);
  }

  /** Store a plugin secret under its namespaced vault name; returns that name. */
  setSecret(id: string, name: string, value: string, by: string): string {
    const { loaded } = this.manifestOf(id);
    if (!loaded.manifest.secrets.some((s) => s.name === name)) {
      throw new OrbitError('invalid_input', `${id} declares no secret ${name}`);
    }
    const key = pluginSecretKey(id, name);
    this.deps.vault.set(key, value);
    this.deps.audit?.append({
      actor: by,
      action: 'plugin.secret_set',
      subject: id,
      data: { name },
    });
    return key;
  }

  removeSecret(id: string, name: string, by: string): void {
    const { loaded } = this.manifestOf(id);
    if (!loaded.manifest.secrets.some((s) => s.name === name)) {
      throw new OrbitError('invalid_input', `${id} declares no secret ${name}`);
    }
    if (!this.deps.vault.remove(pluginSecretKey(id, name))) {
      throw new OrbitError('not_found', `${id} has no ${name} set`);
    }
    this.deps.audit?.append({
      actor: by,
      action: 'plugin.secret_removed',
      subject: id,
      data: { name },
    });
  }

  // ── what Runs use ──────────────────────────────────────────────────────────

  /**
   * Tier overrides for every known plugin's declared tools: exact names only
   * (never globs), raised to the floor their names set. The orchestrator puts
   * them after ORBIT_TOOL_TIERS, so they cannot reach Orbit's own tools.
   */
  toolTiers(): ToolTierOverride[] {
    const out: ToolTierOverride[] = [];
    for (const k of this.known().values()) {
      const m = k.loaded?.manifest;
      if (!m) continue;
      for (const t of m.tools) {
        const name = pluginToolName(m.id, t.name);
        out.push({
          pattern: name,
          tier: effectivePluginTier(name, t.tier).tier,
          untrusted: true,
          ...(t.egress ? { egress: true } : {}),
        });
      }
    }
    return out;
  }

  /** The plugin if a Run may use it now, else why not. */
  ready(id: string): ReadyPlugin | { reason: string } {
    const k = this.known().get(id);
    if (!k) return { reason: `plugin ${id} is not installed` };
    if (!k.loaded) return { reason: `plugin ${id} cannot be read: ${k.error ?? 'unknown error'}` };
    const row = this.row(id);
    const state = this.stateOf(k.loaded, row);
    if (state !== 'ready') {
      const why: Record<Exclude<PluginState, 'ready'>, string> = {
        disabled: 'is not enabled',
        changed: 'changed since it was enabled',
        needs_setup: 'needs setup (a secret or setting is missing)',
        error: 'failed its last check',
      };
      return { reason: `plugin ${id} ${why[state]}` };
    }
    return {
      manifest: k.loaded.manifest,
      dir: k.loaded.dir,
      tools: row?.tools ? (JSON.parse(row.tools) as McpToolDef[]) : [],
    };
  }

  /** A client for a plugin server: a child process with the plugin's own env, or HTTP. */
  client(spec: ClientSpec): McpClient {
    const secret = (name: string) => this.deps.vault.get(name);
    const make = (): McpClient => {
      const { manifest } = spec;
      if (manifest.server.transport === 'http') {
        return new HttpMcpClient({
          url: manifest.server.url,
          headers: resolveHeaders(manifest, secret),
        });
      }
      const cmd = expandCommand(manifest.server, spec.dir, this.deps.paths ?? defaultPluginPaths());
      return new StdioMcpClient({
        ...cmd,
        cwd: spec.cwd,
        env: buildPluginEnv({
          manifest,
          source: this.deps.env,
          settings: this.settingsOf(this.row(manifest.id)),
          secret,
          workspace: spec.workspace,
        }),
        ...(this.deps.redact ? { redact: this.deps.redact } : {}),
      });
    };
    return this.deps.clientFactory ? this.deps.clientFactory(spec, make) : make();
  }
}
