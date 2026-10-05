import { z } from 'zod';
import { Tier } from './enums';

/**
 * Plugin manifests (`orbit-plugin.json`, ADR-014). A plugin is an MCP server
 * orbitd starts and proxies to the engine; the manifest says what it may do:
 * its tools and their fixed tiers, the secrets and settings it needs and the
 * environment variable names it may see. Browser-safe (the App shows it).
 */

/** Lowercase, no `_` (the engine names tools `mcp__<id>__<tool>`), never `orbit`. */
export const PLUGIN_ID = /^[a-z][a-z0-9-]{1,31}$/;
export const RESERVED_PLUGIN_IDS: readonly string[] = ['orbit', 'mcp', 'plugins', 'claude'];
export const PLUGIN_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Environment-style names for secrets, settings and env passthrough. */
export const PLUGIN_VAR_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Names a plugin may never receive, declare or set: credentials Orbit itself
 * holds and variables that change how a process loads code.
 */
const FORBIDDEN_EXACT = new Set([
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_AUTH_SOCK',
  'BASH_ENV',
  'ENV',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'RUBYOPT',
]);
const FORBIDDEN_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'ORBIT_',
  'AWS_',
  'AZURE_',
  'VERTEX_',
  'CLOUD_ML_',
  'LD_',
  'DYLD_',
  'GIT_CONFIG',
  'NPM_CONFIG_',
];

/** True when a plugin may use `name` for an env passthrough, a secret or a setting. */
export function isAllowedPluginVar(name: string): boolean {
  if (!PLUGIN_VAR_NAME.test(name)) return false;
  if (FORBIDDEN_EXACT.has(name)) return false;
  return !FORBIDDEN_PREFIXES.some((p) => name.startsWith(p));
}

const VarName = z
  .string()
  .refine(isAllowedPluginVar, 'must be UPPER_SNAKE_CASE and not a reserved or credential name');

export const PluginTool = z.object({
  name: z.string().regex(PLUGIN_TOOL_NAME, 'lowercase letters, digits and _'),
  /** Fixed risk tier (ADR-009). Orbit may raise it (money or send verbs), never lower it. */
  tier: Tier,
  /** What it does, for the owner. */
  description: z.string().trim().max(500).default(''),
  /** Sends Bot-chosen data to arbitrary hosts (like WebFetch): asks in a tainted Run. */
  egress: z.boolean().default(false),
});
export type PluginTool = z.infer<typeof PluginTool>;

export const PluginSecret = z.object({
  name: VarName,
  description: z.string().trim().max(300).default(''),
  required: z.boolean().default(true),
  /**
   * `plugin` (default): passed to the plugin's server. `orbit`: used by orbitd
   * itself (e.g. the Slack trigger's app-level token) and never given to the
   * plugin's process.
   */
  scope: z.enum(['plugin', 'orbit']).default('plugin'),
});
export type PluginSecret = z.infer<typeof PluginSecret>;

export const PluginSetting = z.object({
  name: VarName,
  description: z.string().trim().max(300).default(''),
  default: z.string().max(2000).optional(),
  required: z.boolean().default(false),
});
export type PluginSetting = z.infer<typeof PluginSetting>;

export const PluginServer = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    /** Executable; `${node}` is Orbit's own Node. */
    command: z.string().min(1).max(500),
    /** `${pluginDir}`, `${tsx}` and `${node}` are replaced; nothing else is. */
    args: z.array(z.string().max(1000)).max(30).default([]),
  }),
  z.object({
    transport: z.literal('http'),
    /** https, or http on a loopback host. */
    url: z.url().refine(isAllowedPluginUrl, 'must be https, or http on a loopback host'),
    /** Header values may contain `${secret:NAME}` (a secret this plugin declares). */
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(2000)).default({}),
  }),
]);
export type PluginServer = z.infer<typeof PluginServer>;

/** A default folder in a sandbox path entry: absolute or `~/…`, no `..`, no NUL or newline. */
function isSandboxDefaultPath(p: string): boolean {
  if (!(p.startsWith('/') || p.startsWith('~/'))) return false;
  if (/[\0\n\r]/.test(p)) return false;
  return !p.split('/').includes('..');
}

/**
 * A folder the plugin's sandbox binds (ADR-019): the value of one of the
 * manifest's own settings or env passthroughs (several folders separated by
 * `:`, `;` on Windows), or the listed defaults when it is unset. Orbit never
 * binds a folder that overlaps a credential store or `$ORBIT_HOME`.
 */
export const PluginSandboxPath = z.object({
  /** A setting or env passthrough this manifest declares. */
  name: VarName,
  access: z.enum(['read', 'write']).default('read'),
  /** The value names a file: bind the folder holding it (a browser binary and its libraries). */
  parent: z.boolean().default(false),
  /** Folders used when the value is unset: absolute or `~/…` (the owner's home). */
  default: z
    .array(z.string().max(500).refine(isSandboxDefaultPath, 'absolute or ~/…, without ..'))
    .max(4)
    .default([]),
});
export type PluginSandboxPath = z.infer<typeof PluginSandboxPath>;

/**
 * What a stdio plugin needs from its OS sandbox (ADR-019). Orbit derives the
 * sandbox from this and its own context, never from anything the plugin says
 * at run time; the manifest hash pins it. Absent = the defaults below.
 */
export const PluginSandboxNeeds = z.object({
  /** The Bot's workspace (and a worktree Bot's git directory): not bound, read-only, or read-write. */
  workspace: z.enum(['none', 'read', 'write']).default('none'),
  /** Any of its tools needs the network (else it gets a network namespace of its own). */
  network: z.boolean().default(false),
  paths: z.array(PluginSandboxPath).max(8).default([]),
  /**
   * It starts a program that sets up an OS sandbox of its own (Chromium): it
   * needs nested user namespaces under bwrap, and cannot run inside macOS
   * sandbox-exec.
   */
  nestedSandbox: z.boolean().default(false),
});
export type PluginSandboxNeeds = z.infer<typeof PluginSandboxNeeds>;

/** An owner-added manifest without a `sandbox` section: no workspace, no network, no folders. */
export const DEFAULT_SANDBOX_NEEDS: PluginSandboxNeeds = Object.freeze({
  workspace: 'none',
  network: false,
  paths: [],
  nestedSandbox: false,
});

/** `plugins.sandbox`: `auto` sandboxes when the host can, `required` refuses otherwise, `off` never. */
export const PluginSandboxMode = z.enum(['auto', 'required', 'off']);
export type PluginSandboxMode = z.infer<typeof PluginSandboxMode>;

export function isAllowedPluginUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export const PluginManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: z
      .string()
      .regex(PLUGIN_ID, 'lowercase letters, digits and dashes')
      .refine((id) => !RESERVED_PLUGIN_IDS.includes(id), 'is reserved'),
    name: z.string().trim().min(1).max(80),
    version: z.string().trim().min(1).max(40),
    description: z.string().trim().max(1000).default(''),
    homepage: z.url().optional(),
    server: PluginServer,
    tools: z.array(PluginTool).min(1).max(100),
    secrets: z.array(PluginSecret).max(10).default([]),
    settings: z.array(PluginSetting).max(20).default([]),
    /** Variables copied from orbitd's own environment (non-secret config such as API base URLs). */
    env: z.array(VarName).max(20).default([]),
    /**
     * OS sandbox needs (ADR-019). Optional so that manifests written before
     * it keep their hash; absent means `DEFAULT_SANDBOX_NEEDS`.
     */
    sandbox: PluginSandboxNeeds.optional(),
  })
  .superRefine((m, ctx) => {
    const dup = (list: string[], what: string) => {
      const seen = new Set<string>();
      for (const n of list) {
        if (seen.has(n)) ctx.addIssue({ code: 'custom', message: `duplicate ${what} ${n}` });
        seen.add(n);
      }
    };
    dup(
      m.tools.map((t) => t.name),
      'tool',
    );
    // One namespace: a secret, a setting and a passthrough can never shadow each other.
    dup([...m.secrets.map((s) => s.name), ...m.settings.map((s) => s.name), ...m.env], 'variable');
    if (m.sandbox) {
      // A sandbox folder comes from the plugin's own (non-secret) settings or env names only.
      const folders = new Set([...m.settings.map((s) => s.name), ...m.env]);
      for (const p of m.sandbox.paths) {
        if (!folders.has(p.name)) {
          ctx.addIssue({
            code: 'custom',
            message: `sandbox path ${p.name} is not a declared setting or env name`,
          });
        }
      }
      dup(
        m.sandbox.paths.map((p) => p.name),
        'sandbox path',
      );
    }
    if (m.server.transport === 'http') {
      const declared = new Set(m.secrets.map((s) => s.name));
      for (const v of Object.values(m.server.headers)) {
        for (const ref of v.matchAll(/\$\{secret:([^}]*)\}/g)) {
          if (!declared.has(ref[1] ?? '')) {
            ctx.addIssue({ code: 'custom', message: `header names undeclared secret ${ref[1]}` });
          }
        }
      }
    }
  });
export type PluginManifest = z.infer<typeof PluginManifest>;
export type PluginManifestInput = z.input<typeof PluginManifest>;

/** The engine-side name of a plugin tool. */
export function pluginToolName(pluginId: string, tool: string): string {
  return `mcp__${pluginId}__${tool}`;
}

/** Vault entry holding a plugin's secret: the namespace keeps plugins apart (ADR-014). */
export function pluginSecretKey(pluginId: string, name: string): string {
  return `plugin_${pluginId.replace(/-/g, '_')}_${name}`;
}

/** What a plugin declared it needs from its sandbox, or the defaults. */
export function pluginSandboxNeeds(m: Pick<PluginManifest, 'sandbox'>): PluginSandboxNeeds {
  return m.sandbox ?? DEFAULT_SANDBOX_NEEDS;
}

/** What a plugin's sandbox gets, in words (Integrations, `orbit plugin show`, the TUI). */
export function describeSandboxNeeds(n: PluginSandboxNeeds): string {
  const parts = [
    n.workspace === 'none'
      ? 'no workspace'
      : `the workspace ${n.workspace === 'read' ? 'read-only' : 'read-write'}`,
    n.network ? 'the network' : 'no network',
    ...n.paths.map((f) => `${f.name} folders ${f.access === 'write' ? 'read-write' : 'read-only'}`),
  ];
  if (n.nestedSandbox) parts.push('a browser with its own sandbox');
  return parts.join(' · ');
}

// ── the plugin catalog (ADR-019) ───────────────────────────────────────────

/** npm package names: lowercase, URL-safe, optionally scoped. */
export const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** An exact semver version (no ranges, tags or `latest`). */
export const EXACT_VERSION =
  /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;
/** Subresource Integrity with one SHA-512 digest, as npm writes it. */
export const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

export const NpmPackageName = z
  .string()
  .max(214)
  .regex(NPM_PACKAGE_NAME, 'not an npm package name');
export const ExactVersion = z
  .string()
  .max(160)
  .regex(EXACT_VERSION, 'an exact version such as 1.2.3 (no ranges or tags)');
export const Sha512Integrity = z.string().regex(SRI_SHA512, 'sha512-… (Subresource Integrity)');

export const PluginCatalogEntry = z.object({
  id: z
    .string()
    .regex(PLUGIN_ID, 'lowercase letters, digits and dashes')
    .refine((id) => !RESERVED_PLUGIN_IDS.includes(id), 'is reserved'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).default(''),
  homepage: z.url().optional(),
  package: NpmPackageName,
  version: ExactVersion,
  /** SRI of the npm tarball: checked before a byte of it is read. */
  integrity: Sha512Integrity,
  /** sha256 of the canonical manifest inside: a different manifest refuses the install. */
  manifestHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type PluginCatalogEntry = z.infer<typeof PluginCatalogEntry>;

/** The catalog index (`plugins.catalogUrl`); the repository ships `plugins/catalog.json`. */
export const PluginCatalog = z
  .object({
    schemaVersion: z.literal(1),
    description: z.string().trim().max(2000).default(''),
    plugins: z.array(PluginCatalogEntry).max(500).default([]),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    for (const p of c.plugins) {
      if (seen.has(p.id)) ctx.addIssue({ code: 'custom', message: `duplicate plugin ${p.id}` });
      seen.add(p.id);
    }
  });
export type PluginCatalog = z.infer<typeof PluginCatalog>;

// ── status shown to the owner (API, App, CLI, TUI) ─────────────────────────

export const PluginState = z.enum([
  /** Known but not enabled by the owner. */
  'disabled',
  /** Enabled, checked, offered to the Bots that list it. */
  'ready',
  /** A required secret or setting is missing. */
  'needs_setup',
  /** The manifest changed since the owner enabled it: not offered until re-enabled. */
  'changed',
  /** The last check failed (server did not start or list its tools). */
  'error',
]);
export type PluginState = z.infer<typeof PluginState>;

export const PluginToolStatus = z.object({
  name: z.string(),
  /** Engine-side name: mcp__<plugin>__<tool>. */
  engineName: z.string(),
  description: z.string(),
  declaredTier: Tier,
  /** The tier Orbit applies (raised when the name moves money or sends). */
  tier: Tier,
  egress: z.boolean(),
  /** The server offered it at the last check (null = never checked). */
  available: z.boolean().nullable(),
});
export type PluginToolStatus = z.infer<typeof PluginToolStatus>;

/** How a plugin's server runs on this computer (ADR-019). */
export const PluginSandboxState = z.enum([
  /** Inside an OS sandbox derived from its manifest. */
  'sandboxed',
  /** `plugins.sandbox` is `auto` and this host (or this plugin) cannot be sandboxed. */
  'unsandboxed',
  /** `plugins.sandbox` is `required` and it cannot be sandboxed: it does not start. */
  'refused',
  /** `plugins.sandbox` is `off`. */
  'off',
  /** An http server elsewhere: nothing starts on this computer. */
  'remote',
]);
export type PluginSandboxState = z.infer<typeof PluginSandboxState>;

export const PluginSandboxStatus = z.object({
  state: PluginSandboxState,
  engine: z.enum(['bwrap', 'sandbox-exec']).nullable(),
  /** Why it is not sandboxed (null when it is). */
  reason: z.string().nullable(),
  /** What the manifest declares (or the defaults). */
  needs: PluginSandboxNeeds,
});
export type PluginSandboxStatus = z.infer<typeof PluginSandboxStatus>;

/** Where a plugin came from. */
export const PluginSource = z.object({
  kind: z.enum(['builtin', 'folder', 'npm']),
  /** npm installs: the package, its exact version and the SRI it was verified against. */
  package: z.string().nullable(),
  version: z.string().nullable(),
  integrity: z.string().nullable(),
});
export type PluginSource = z.infer<typeof PluginSource>;

export const PluginStatus = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  homepage: z.string().nullable(),
  /** Shipped with Orbit (plugins/*) or added by the owner. */
  builtIn: z.boolean(),
  source: PluginSource,
  dir: z.string(),
  enabled: z.boolean(),
  state: PluginState,
  /** One line on the server: "stdio: node server.ts" / "http: https://…". */
  server: z.string(),
  tools: z.array(PluginToolStatus),
  secrets: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      required: z.boolean(),
      set: z.boolean(),
      /** The vault entry (plugin_<id>_<NAME>). */
      vaultName: z.string(),
    }),
  ),
  settings: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      required: z.boolean(),
      value: z.string().nullable(),
      default: z.string().nullable(),
    }),
  ),
  env: z.array(z.string()),
  sandbox: PluginSandboxStatus,
  /** Tools the server offers that the manifest does not declare (never shown to Bots). */
  undeclaredTools: z.array(z.string()),
  /** Bots whose spec lists this plugin. */
  bots: z.array(z.object({ id: z.string(), name: z.string() })),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  checkedAt: z.string().nullable(),
  enabledAt: z.string().nullable(),
});
export type PluginStatus = z.infer<typeof PluginStatus>;

// ── installing from the catalog or npm (ADR-019) ───────────────────────────

/** What a package would install, shown to the owner before anything is stored. */
export const PluginInstallPreview = z.object({
  id: z.string(),
  name: z.string(),
  /** The manifest's version (normally the package version). */
  version: z.string(),
  description: z.string(),
  package: z.string(),
  packageVersion: z.string(),
  /** The SRI the tarball matched. */
  integrity: z.string(),
  manifestHash: z.string(),
  /** Listed in the configured catalog (whose manifest hash, when it names one, matched). */
  fromCatalog: z.boolean(),
  server: z.string(),
  tools: z.array(PluginToolStatus.omit({ available: true })),
  secrets: z.array(z.object({ name: z.string(), description: z.string(), required: z.boolean() })),
  settings: z.array(z.object({ name: z.string(), description: z.string() })),
  env: z.array(z.string()),
  sandbox: PluginSandboxNeeds,
  files: z.int(),
  bytes: z.int(),
});
export type PluginInstallPreview = z.infer<typeof PluginInstallPreview>;

export const PluginCatalogListing = z.object({
  url: z.string(),
  description: z.string(),
  entries: z.array(
    PluginCatalogEntry.extend({
      /** The id is already known here (installed, added by folder or a reference plugin). */
      installed: z.boolean(),
      installedVersion: z.string().nullable(),
    }),
  ),
  /** Why the catalog could not be read (the listing is then empty). */
  error: z.string().nullable(),
});
export type PluginCatalogListing = z.infer<typeof PluginCatalogListing>;
