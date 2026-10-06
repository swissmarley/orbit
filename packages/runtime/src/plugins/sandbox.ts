import {
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
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
  type GitBind,
  gitCommonDir,
  worktreeAdminDir,
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

/**
 * System locations an owner folder may never bring into a sandbox: devices,
 * kernel state and runtime sockets (`/run/user/<uid>` holds the session bus
 * and SSH agent sockets, which a bind would make reachable without a
 * network).
 */
export const SANDBOX_FOLDER_DENIED: readonly string[] = [
  '/dev',
  '/proc',
  '/sys',
  '/run',
  '/var/run',
];

/** Folders that overlap a denied path, with the denied path (shown as warnings). */
export function hiddenFolders(
  folders: readonly (SandboxBind & { from: string })[],
  denied: readonly string[],
): { path: string; from: string; overlaps: string }[] {
  const all = [...denied, ...SANDBOX_FOLDER_DENIED];
  return folders.flatMap((f) => {
    const d = all.find((x) => isWithin(f.path, x) || isWithin(x, f.path));
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

/**
 * What of Node's installation a plugin sandbox shows: the install prefix
 * when `node` sits in one (`<prefix>/bin/node` beside `lib/node_modules` or
 * `include/node`: nvm, Volta, Homebrew, the official tarball), otherwise the
 * binary alone — never the parent of an arbitrary folder (`~/.local/bin/node`
 * would otherwise bring in `~/.local`, keyrings and all; M8 review L8).
 */
export function nodeRuntimePath(nodeReal: string): string {
  const prefix = dirname(dirname(nodeReal));
  const isPrefix =
    lstatOrNull(join(prefix, 'lib', 'node_modules'))?.isDirectory() === true ||
    lstatOrNull(join(prefix, 'include', 'node'))?.isDirectory() === true;
  return isPrefix && prefix !== dirname(prefix) ? prefix : nodeReal;
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

/** What a commit and a push write in the common git directory (ADR-019). */
const GIT_WRITABLE = ['objects', 'refs', 'logs', 'reftable'];
/** Inside the Bot's worktree entry: the pointers and config git follows, read-only. */
const WORKTREE_PROTECTED = ['commondir', 'gitdir', 'config.worktree'];

/**
 * A worktree Bot's git directory: the owner's repository's common git dir,
 * and the repository's `.git` file when that is itself a link. With write
 * access only what a commit needs is writable — `objects`, `refs`, `logs`
 * (and `reftable`), and the Bot's own `worktrees/<name>` entry minus its
 * `commondir`, `gitdir` and `config.worktree` — and everything else stays
 * read-only: config, hooks, info, modules (submodules' config and hooks),
 * `commondir`, packed-refs and other worktrees' entries, so a file git would
 * follow cannot be created either (M8 safety review). Creates `logs` and an
 * empty `config.worktree` in the Bot's entry when missing, so they can be
 * bound.
 */
export function gitBind(
  repo: string,
  access: 'read' | 'write',
  workspace?: string | null,
): GitBind | null {
  const found = gitCommonDir(repo);
  if (!found) return null;
  const common = found.dir;
  const writable: string[] = [];
  const protect: string[] = [];
  if (access === 'write') {
    const logs = join(common, 'logs');
    if (!lstatOrNull(logs)) mkdirSync(logs, { mode: 0o755 });
    // Real folders only: a link could point anywhere.
    for (const n of GIT_WRITABLE) {
      if (lstatOrNull(join(common, n))?.isDirectory()) writable.push(join(common, n));
    }
    const entry = workspace ? worktreeAdminDir(common, workspace) : null;
    if (entry) {
      const cfg = join(entry, 'config.worktree');
      if (!lstatOrNull(cfg)) writeFileSync(cfg, '', { flag: 'wx', mode: 0o644 });
      writable.push(entry);
      for (const n of WORKTREE_PROTECTED) {
        if (lstatOrNull(join(entry, n))) protect.push(join(entry, n));
      }
    }
  }
  return {
    dir: common,
    access,
    writable,
    protect,
    ...(found.dotGit ? { dotGit: found.dotGit } : {}),
  };
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
  if (nodeReal) runtime.push(nodeRuntimePath(nodeReal));
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
  const requested = requestedFolders(
    req.manifest,
    { settings: req.settings, env: req.env },
    req.home,
  )
    .filter((f) => existsSync(f.path))
    .map((f) => ({ ...f, path: realOr(f.path) }));
  // Devices and runtime sockets never; credential stores and Orbit's data the spec drops below.
  const hidden = new Set(hiddenFolders(requested, []).map((h) => h.path));
  const folders = requested
    .filter((f) => !hidden.has(f.path))
    .map((f) => ({ path: f.path, access: f.access }));
  const workspace =
    needs.workspace !== 'none' && req.workspace
      ? { path: realOr(req.workspace), access: needs.workspace }
      : null;
  const git =
    workspace && req.git ? gitBind(realOr(req.git.repo), workspace.access, workspace.path) : null;

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
