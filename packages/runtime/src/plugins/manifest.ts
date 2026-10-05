import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  OrbitError,
  PluginManifest,
  canonicalJson,
  isAllowedPluginVar,
  pluginSecretKey,
  sha256Hex,
} from '@orbit/core';
import { z } from 'zod';
import { type Env, buildChildEnv } from '../env';

export const MANIFEST_FILE = 'orbit-plugin.json';
const MAX_MANIFEST_BYTES = 256 * 1024;

export interface LoadedManifest {
  manifest: PluginManifest;
  /** Canonical directory (symlinks resolved). */
  dir: string;
  /** sha256 of the canonical manifest: a change means the owner looks again. */
  hash: string;
}

/** Read and validate `<dir>/orbit-plugin.json`. Throws `invalid_config` with the reasons. */
export function loadManifest(dir: string): LoadedManifest {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new OrbitError('invalid_config', `Plugin directory ${dir} does not exist`);
  }
  const path = join(real, MANIFEST_FILE);
  let text: string;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) {
      throw new OrbitError('invalid_config', `${path} is not a plugin manifest`);
    }
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err instanceof OrbitError) throw err;
    throw new OrbitError('invalid_config', `No ${MANIFEST_FILE} in ${real}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OrbitError('invalid_config', `${path} is not valid JSON`);
  }
  const parsed = PluginManifest.safeParse(json);
  if (!parsed.success) {
    throw new OrbitError(
      'invalid_config',
      `${path} is not a valid plugin manifest: ${z.prettifyError(parsed.error)}`,
    );
  }
  return {
    manifest: parsed.data,
    dir: real,
    hash: sha256Hex(canonicalJson(parsed.data)),
  };
}

export interface ServerCommand {
  command: string;
  args: string[];
}

/** `${node}`, `${tsx}` and `${pluginDir}` are the only placeholders (no env expansion, no shell). */
export function expandCommand(
  server: Extract<PluginManifest['server'], { transport: 'stdio' }>,
  dir: string,
  paths: { node: string; tsx: string },
): ServerCommand {
  const sub = (s: string) =>
    s
      .replaceAll('${node}', paths.node)
      .replaceAll('${tsx}', paths.tsx)
      .replaceAll('${pluginDir}', dir);
  return { command: sub(server.command), args: server.args.map(sub) };
}

/** One line describing the server, for the owner. */
export function describeServer(server: PluginManifest['server']): string {
  if (server.transport === 'http') return `http: ${server.url}`;
  const short = (s: string) => s.replace(/^.*[\\/]/, '');
  return `stdio: ${[server.command, ...server.args].map(short).join(' ')}`.slice(0, 200);
}

export interface PluginEnvInput {
  manifest: PluginManifest;
  /** orbitd's own environment: only allowlisted names and the manifest's `env` are read. */
  source: Env;
  settings: Readonly<Record<string, string>>;
  /** Vault lookup (by the full vault name). */
  secret: (vaultName: string) => string | undefined;
  workspace: string | null;
}

/**
 * The environment of a plugin server (ADR-014): the base allowlist (PATH,
 * HOME, locale, temp, proxies), the manifest's passthrough names, its
 * settings and its own secrets — never an API key, OAuth token, hook token or
 * another plugin's secret. `buildChildEnv('tool', …)` refuses denied names as
 * a second line of defence.
 */
export function buildPluginEnv(input: PluginEnvInput): Record<string, string> {
  const { manifest } = input;
  const extra: Record<string, string> = {};
  for (const name of manifest.env) {
    const v = input.source[name];
    if (v !== undefined && isAllowedPluginVar(name)) extra[name] = v;
  }
  for (const s of manifest.settings) {
    const v = input.settings[s.name] ?? s.default;
    if (v !== undefined && isAllowedPluginVar(s.name)) extra[s.name] = v;
  }
  for (const s of manifest.secrets) {
    const v = input.secret(pluginSecretKey(manifest.id, s.name));
    if (v !== undefined && isAllowedPluginVar(s.name)) extra[s.name] = v;
  }
  if (input.workspace) extra.ORBIT_WORKSPACE = input.workspace;
  return buildChildEnv('tool', input.source, extra);
}

/** Header values with `${secret:NAME}` filled from this plugin's own secrets. */
export function resolveHeaders(
  manifest: PluginManifest,
  secret: (vaultName: string) => string | undefined,
): Record<string, string> {
  if (manifest.server.transport !== 'http') return {};
  const declared = new Set(manifest.secrets.map((s) => s.name));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(manifest.server.headers)) {
    out[k] = v.replace(/\$\{secret:([A-Z0-9_]+)\}/g, (_, name: string) =>
      declared.has(name) ? (secret(pluginSecretKey(manifest.id, name)) ?? '') : '',
    );
  }
  return out;
}
