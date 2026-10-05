import {
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OrbitError,
  type PluginManifest,
  type PluginSandboxMode,
  type PluginSandboxStatus,
  pluginSandboxNeeds,
} from '@orbit/core';
import {
  type HostPath,
  LINUX_SYSTEM_PATHS,
  type PluginSandboxSupport,
  type SandboxBind,
  type SystemPath,
  type WrappedCommand,
  isWithin,
  pluginSandboxSpec,
  wrapPluginCommand,
} from '@orbit/sandbox';
import type { Env } from '../env';

/**
 * Plugin servers in an OS sandbox (ADR-019): what the manifest declares plus
 * Orbit's own context becomes a bubblewrap command line or a Seatbelt
 * profile. This file does the file-system lookups; `@orbit/sandbox` builds
 * the arguments.
 */

export interface PluginSandboxConfig {
  mode: PluginSandboxMode;
  /** What this host can do (detected once, cached by the caller). */
  support: () => PluginSandboxSupport;
}

/** How a plugin will run here, and why (shown in Integrations, `plugin show`, doctor). */
export function sandboxStatus(
  manifest: PluginManifest,
  mode: PluginSandboxMode,
  support: PluginSandboxSupport | null,
): PluginSandboxStatus {
  const needs = pluginSandboxNeeds(manifest);
  if (manifest.server.transport === 'http') {
    return { state: 'remote', engine: null, reason: null, needs };
  }
  if (mode === 'off') {
    return { state: 'off', engine: null, reason: 'plugins.sandbox is off', needs };
  }
  let reason: string | null = null;
  if (!support?.available) reason = support?.reason ?? 'no OS sandbox on this computer';
  else if (needs.nestedSandbox && support.engine === 'sandbox-exec') {
    // Seatbelt profiles do not nest: Chromium's own sandbox cannot start inside sandbox-exec.
    reason = `${manifest.name} starts a program with its own sandbox (a browser), which cannot run inside macOS sandbox-exec`;
  }
  if (reason !== null) {
    return { state: mode === 'required' ? 'refused' : 'unsandboxed', engine: null, reason, needs };
  }
  return { state: 'sandboxed', engine: support?.engine ?? null, reason: null, needs };
}

/** `~/…` in a manifest default is the owner's home. */
function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/**
 * The owner folders a plugin's sandbox binds: the values of the settings or
 * env names its manifest lists in `sandbox.paths` (several separated by the
 * platform's path delimiter), else the declared defaults. Absolute paths
 * only; nothing is checked against the disk here.
 */
export function requestedFolders(
  manifest: PluginManifest,
  values: { settings: Readonly<Record<string, string>>; env: Env },
  home: string,
): (SandboxBind & { from: string })[] {
  const out: (SandboxBind & { from: string })[] = [];
  const declaredSettings = new Map(manifest.settings.map((s) => [s.name, s.default]));
  for (const p of pluginSandboxNeeds(manifest).paths) {
    const raw = declaredSettings.has(p.name)
      ? (values.settings[p.name] ?? declaredSettings.get(p.name))
      : manifest.env.includes(p.name)
        ? values.env[p.name]
        : undefined;
    const list =
      raw !== undefined && raw.trim() !== ''
        ? raw.split(delimiter).map((s) => s.trim())
        : p.default.map((d) => expandHome(d, home));
    for (const entry of list) {
      if (!entry || !isAbsolute(entry)) continue;
      const path = resolve(p.parent ? dirname(entry) : entry);
      out.push({ path, access: p.access, from: p.name });
    }
  }
  return out;
}

/** Folders that overlap a denied path, with the denied path (shown as warnings). */
export function hiddenFolders(
  folders: readonly (SandboxBind & { from: string })[],
  denied: readonly string[],
): { path: string; from: string; overlaps: string }[] {
  return folders.flatMap((f) => {
    const d = denied.find((x) => isWithin(f.path, x) || isWithin(x, f.path));
    return d === undefined ? [] : [{ path: f.path, from: f.from, overlaps: d }];
  });
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** The outermost `node_modules` folder in a path (a package store), or null. */
export function outermostNodeModules(p: string): string | null {
  const parts = resolve(p).split(sep);
  const i = parts.indexOf('node_modules');
  return i <= 0 ? null : parts.slice(0, i + 1).join(sep) || null;
}

/**
 * Folders the plugin's code loads from besides its own directory: package
 * stores its `node_modules` links point into (pnpm workspaces link to the
 * repository's store) and sibling workspace packages, followed a few levels
 * deep. A link target counts only if it is a package store or a folder with
 * a package.json.
 */
export function moduleRoots(pluginDir: string, maxDepth = 3): string[] {
  const roots = new Set<string>();
  const seen = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth || seen.has(dir)) return;
    seen.add(dir);
    const nm = join(dir, 'node_modules');
    let names: string[];
    try {
      names = readdirSync(nm);
    } catch {
      return;
    }
    const entries = names.flatMap((n) => {
      if (n.startsWith('.')) return [];
      if (!n.startsWith('@')) return [join(nm, n)];
      try {
        return readdirSync(join(nm, n)).map((m) => join(nm, n, m));
      } catch {
        return [];
      }
    });
    for (const e of entries) {
      if (!lstatOrNull(e)?.isSymbolicLink()) continue; // inside the plugin dir already
      const target = realOrNull(e);
      if (!target || isWithin(target, dir)) continue;
      const store = outermostNodeModules(target);
      if (store) roots.add(store);
      else if (existsSync(join(target, 'package.json'))) {
        roots.add(target);
        visit(target, depth + 1);
      }
    }
  };
  visit(realOrNull(pluginDir) ?? pluginDir, 0);
  return [...roots];
}

/** Linux system locations that exist, as binds or symlinks (merged /usr). */
export function linuxSystemPaths(paths: readonly string[] = LINUX_SYSTEM_PATHS): SystemPath[] {
  return paths.flatMap((p) => {
    const st = lstatOrNull(p);
    if (!st) return [];
    if (st.isSymbolicLink()) {
      try {
        return [{ path: p, symlink: readlinkSync(p) }];
      } catch {
        return [];
      }
    }
    return st.isDirectory() ? [{ path: p }] : [];
  });
}

/** Denied paths that exist (masks are only needed for those), with their kind. */
export function existingDenied(paths: readonly string[]): HostPath[] {
  return paths.flatMap((p) => {
    try {
      const st = statSync(p);
      return [{ path: resolve(p), kind: st.isDirectory() ? ('dir' as const) : ('file' as const) }];
    } catch {
      return [];
    }
  });
}

/**
 * A worktree Bot's git directory: the owner's repository's common git dir
 * (it holds `worktrees/<name>`, objects and refs), its config, hooks and info
 * protected, and the repository's `.git` file when that is itself a link.
 */
export function gitBind(
  repo: string,
  access: 'read' | 'write',
): { dir: string; access: 'read' | 'write'; protect: string[]; dotGit?: string } | null {
  const dotGit = join(repo, '.git');
  const st = lstatOrNull(dotGit);
  if (!st) return null;
  let dir: string | null = null;
  let link: string | undefined;
  if (st.isDirectory()) dir = realOrNull(dotGit);
  else if (st.isFile()) {
    link = dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    const gitdir = m?.[1] ? resolve(repo, m[1].trim()) : null;
    if (gitdir) {
      let common = gitdir;
      try {
        common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
      } catch {
        // Not a linked worktree: the gitdir is the common dir.
      }
      dir = realOrNull(common);
    }
  }
  if (!dir) return null;
  const protect = ['config', 'hooks', 'info']
    .map((n) => join(dir, n))
    .filter((p) => lstatOrNull(p) !== null);
  return { dir, access, protect, ...(link ? { dotGit: link } : {}) };
}

export interface SandboxRequest {
  manifest: PluginManifest;
  /** The plugin's (canonical) directory. */
  dir: string;
  command: WrappedCommand;
  settings: Readonly<Record<string, string>>;
  env: Env;
  home: string;
  orbitHome: string;
  /** Paths plugins never see (pluginDeniedPaths plus the plugin store). */
  denied: readonly string[];
  workspace: string | null;
  git?: { repo: string; branch: string } | undefined;
  /** Orbit's Node and tsx (their install folders are bound read-only). */
  paths: { node: string; tsx: string };
  platform?: NodeJS.Platform;
}

export interface SandboxedCommand extends WrappedCommand {
  /** macOS: HOME and TMPDIR for the plugin (a private directory). */
  envPaths?: { home: string; tmp: string };
  /** Removes what preparing the sandbox created. */
  cleanup?: () => void;
}

/**
 * The plugin's command, wrapped in the sandbox its manifest declares, or the
 * command itself when the sandbox is off or (in `auto`) unavailable. In
 * `required` mode a plugin that cannot be sandboxed is refused.
 */
export function prepareSandboxedCommand(
  config: PluginSandboxConfig,
  req: SandboxRequest,
): SandboxedCommand {
  const support = config.mode === 'off' ? null : config.support();
  const status = sandboxStatus(req.manifest, config.mode, support);
  if (status.state === 'refused') {
    throw new OrbitError(
      'blocked',
      `${req.manifest.name} cannot be sandboxed here: ${status.reason ?? 'unknown reason'}`,
      {
        hint: 'Install bubblewrap (Linux), or set plugins.sandbox to auto to let it run without an OS sandbox.',
      },
    );
  }
  if (status.state !== 'sandboxed' || !support?.path || !support.engine) return req.command;

  const needs = status.needs;
  const platform = req.platform ?? process.platform;
  const realOr = (p: string) => realOrNull(p) ?? resolve(p);
  const server = req.manifest.server;
  const usesTsx =
    server.transport === 'stdio' &&
    [server.command, ...server.args].some((a) => a.includes('${tsx}'));
  const system = platform === 'linux' ? linuxSystemPaths() : [];
  const underSystem = (p: string) =>
    system.some((s) => s.symlink === undefined && isWithin(p, s.path));
  const runtime: string[] = [];
  const nodeReal = realOrNull(req.paths.node);
  if (nodeReal) runtime.push(dirname(dirname(nodeReal)));
  if (usesTsx && req.paths.tsx.startsWith('file:')) {
    const store = outermostNodeModules(fileURLToPath(req.paths.tsx));
    if (store) runtime.push(store);
  }
  runtime.push(...moduleRoots(req.dir));
  if (platform === 'linux' && needs.network) {
    // /etc/resolv.conf is often a link into /run (systemd-resolved, NetworkManager).
    const resolver = realOrNull('/etc/resolv.conf');
    if (resolver && !underSystem(resolver)) runtime.push(resolver);
  }
  const folders = requestedFolders(req.manifest, { settings: req.settings, env: req.env }, req.home)
    .filter((f) => existsSync(f.path))
    .map((f) => ({ path: realOr(f.path), access: f.access }));
  const workspace =
    needs.workspace !== 'none' && req.workspace
      ? { path: realOr(req.workspace), access: needs.workspace }
      : null;
  const git = workspace && req.git ? gitBind(realOr(req.git.repo), workspace.access) : null;

  let privateDir: string | undefined;
  let cleanup: (() => void) | undefined;
  if (support.engine === 'sandbox-exec') {
    privateDir = realOr(mkdtempSync(join(tmpdir(), 'orbit-plugin-')));
    mkdirSync(join(privateDir, 'home'), { mode: 0o700 });
    mkdirSync(join(privateDir, 'tmp'), { mode: 0o700 });
    const dirToRemove = privateDir;
    cleanup = () => rmSync(dirToRemove, { recursive: true, force: true });
  }
  const spec = pluginSandboxSpec({
    platform: platform === 'darwin' ? 'darwin' : 'linux',
    home: realOr(req.home),
    orbitHome: realOr(req.orbitHome),
    denied: existingDenied(req.denied.map(realOr)),
    pluginDir: realOr(req.dir),
    runtime: runtime.map(realOr).filter((r) => !underSystem(r)),
    system,
    folders,
    workspace,
    git,
    network: needs.network,
    privateDir,
    tempRoots:
      platform === 'darwin'
        ? ['/private/tmp', '/private/var/tmp', '/private/var/folders'].filter((p) => existsSync(p))
        : undefined,
  });
  const wrapped = wrapPluginCommand(
    { kind: support.engine, path: support.path },
    spec,
    req.command,
  );
  return {
    ...wrapped,
    ...(privateDir
      ? { envPaths: { home: join(privateDir, 'home'), tmp: join(privateDir, 'tmp') } }
      : {}),
    ...(cleanup ? { cleanup } : {}),
  };
}
