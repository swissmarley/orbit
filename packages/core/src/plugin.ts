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

export const PluginStatus = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  homepage: z.string().nullable(),
  /** Shipped with Orbit (plugins/*) or added by the owner. */
  builtIn: z.boolean(),
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
