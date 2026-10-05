import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { errorMessage } from '@orbit/core';
import { DARWIN_SANDBOX_EXEC, isExecutableFile } from './support';
import { isWithin } from './engine-sandbox';

/**
 * OS sandboxes for plugin server processes (ADR-019): bubblewrap on Linux,
 * a generated Seatbelt profile for macOS `sandbox-exec`. Everything here is
 * pure except detection: the runtime resolves the manifest, settings and
 * file system into a `PluginSandboxSpec`, and these functions turn it into
 * the wrapper's command line. The plugin never contributes to the profile at
 * run time; it comes from the hash-pinned manifest and Orbit's own context.
 */

export type PluginSandboxEngine = 'bwrap' | 'sandbox-exec';

/** Read-only system locations a Linux sandbox shows (only those that exist on the host). */
export const LINUX_SYSTEM_PATHS: readonly string[] = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/etc',
  '/nix/store',
];

/** Seatbelt global names every process needs (directory lookups, logging, notifications). */
const DARWIN_MACH_SERVICES: readonly string[] = [
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.logger',
  'com.apple.system.notification_center',
  'com.apple.logd',
];
/** Extra global names for name resolution and network configuration. */
const DARWIN_NETWORK_MACH_SERVICES: readonly string[] = [
  'com.apple.dnssd.service',
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration',
];

export interface SandboxBind {
  path: string;
  access: 'read' | 'write';
}

/** A host path that exists, and whether it is a directory or a file. */
export interface HostPath {
  path: string;
  kind: 'dir' | 'file';
}

/** A system location: bound read-only, or recreated as the symlink it is on the host. */
export interface SystemPath {
  path: string;
  symlink?: string | undefined;
}

export interface PluginSandboxInput {
  platform: 'linux' | 'darwin';
  /** The owner's home: replaced by an empty private directory. */
  home: string;
  /** Orbit's data directory: never visible (the Bot's own workspace is bound back on purpose). */
  orbitHome: string;
  /** Credential stores, $ORBIT_HOME, the plugin store, … that exist on the host. */
  denied: readonly HostPath[];
  /** The plugin's own directory (read-only). */
  pluginDir: string;
  /** Node's install prefix, module roots, a resolver file: read-only. */
  runtime: readonly string[];
  /** Linux: the system locations that exist. */
  system: readonly SystemPath[];
  /** Owner folders from the plugin's settings, already resolved. */
  folders: readonly SandboxBind[];
  workspace: SandboxBind | null;
  /**
   * A worktree Bot's git directory (the common dir with `worktrees/`), bound
   * with the workspace's access; `protect` (config, hooks, info) stay
   * read-only so a plugin cannot plant a hook or filter for the owner's git.
   * `dotGit` is the repository's `.git` file when the repository is itself a
   * linked worktree.
   */
  git: {
    dir: string;
    access: 'read' | 'write';
    protect: readonly string[];
    dotGit?: string;
  } | null;
  network: boolean;
  /** macOS: the private directory holding the plugin's HOME and TMPDIR (created by the caller). */
  privateDir?: string | undefined;
  /** macOS: shared temporary folders other processes write to (denied except privateDir). */
  tempRoots?: readonly string[] | undefined;
}

export interface PluginSandboxSpec extends PluginSandboxInput {
  /** Folders and runtime roots left out because they overlap a denied path, with why. */
  dropped: { path: string; reason: string }[];
  /** Working directory inside the sandbox. */
  cwd: string;
}

const overlaps = (a: string, b: string) => isWithin(a, b) || isWithin(b, a);

/**
 * Normalise a sandbox request: resolve paths, drop folders and runtime roots
 * that overlap a denied location (so a broad folder such as `~` can never
 * re-open `~/.ssh`), and pick the working directory.
 */
export function pluginSandboxSpec(input: PluginSandboxInput): PluginSandboxSpec {
  const dropped: { path: string; reason: string }[] = [];
  const deniedOverlap = (p: string): string | undefined =>
    input.denied.find((d) => overlaps(p, d.path))?.path;
  const keep = (p: string, what: string): boolean => {
    const d = deniedOverlap(p);
    if (d === undefined) return true;
    dropped.push({ path: p, reason: `${what} overlaps ${d}, which plugins never see` });
    return false;
  };
  const folders = dedupe(
    input.folders
      .map((f) => ({ path: resolve(f.path), access: f.access }))
      .filter((f) => keep(f.path, 'folder')),
  );
  const runtime = [...new Set(input.runtime.map((r) => resolve(r)))].filter((r) =>
    keep(r, 'runtime folder'),
  );
  const workspace = input.workspace
    ? { path: resolve(input.workspace.path), access: input.workspace.access }
    : null;
  return {
    ...input,
    home: resolve(input.home),
    orbitHome: resolve(input.orbitHome),
    pluginDir: resolve(input.pluginDir),
    runtime,
    folders,
    workspace,
    dropped,
    cwd:
      workspace?.path ??
      (input.platform === 'darwin' && input.privateDir
        ? join(input.privateDir, 'home')
        : resolve(input.home)),
  };
}

/** The same folder twice: the wider access wins. */
function dedupe(binds: SandboxBind[]): SandboxBind[] {
  const out = new Map<string, SandboxBind>();
  for (const b of binds) {
    const prev = out.get(b.path);
    if (!prev || (prev.access === 'read' && b.access === 'write')) out.set(b.path, b);
  }
  return [...out.values()];
}

/** Every path bound from the host, for masking denied paths that lie inside one. */
function hostBinds(spec: PluginSandboxSpec): string[] {
  return [
    ...spec.system.filter((s) => s.symlink === undefined).map((s) => s.path),
    ...spec.runtime,
    spec.pluginDir,
    ...spec.folders.map((f) => f.path),
  ];
}

/**
 * bubblewrap arguments (before the plugin's own command): new user, pid,
 * ipc, uts, cgroup and — unless a tool needs it — network namespaces; the
 * system read-only; a fresh /proc (own pid namespace), /dev and /tmp; the
 * owner's home replaced by an empty tmpfs; the Node runtime and the plugin
 * read-only; owner folders and the workspace as declared; denied paths that
 * lie inside a bind masked; the process dies with orbitd.
 */
export function bwrapArgs(spec: PluginSandboxSpec): string[] {
  const a: string[] = ['--unshare-all'];
  if (spec.network) a.push('--share-net');
  a.push('--die-with-parent', '--new-session', '--cap-drop', 'ALL');
  for (const s of spec.system) {
    if (s.symlink !== undefined) a.push('--symlink', s.symlink, s.path);
    else a.push('--ro-bind', s.path, s.path);
  }
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', spec.home);
  for (const r of spec.runtime) a.push('--ro-bind', r, r);
  a.push('--ro-bind', spec.pluginDir, spec.pluginDir);
  for (const f of spec.folders)
    a.push(f.access === 'write' ? '--bind' : '--ro-bind', f.path, f.path);
  // Masks go after the binds they cover and before the workspace, which may lie inside $ORBIT_HOME.
  const binds = hostBinds(spec);
  for (const d of spec.denied) {
    if (!binds.some((b) => isWithin(d.path, b))) continue;
    if (d.kind === 'dir') a.push('--tmpfs', d.path);
    else a.push('--ro-bind', '/dev/null', d.path);
  }
  if (spec.workspace) {
    const ws = spec.workspace;
    a.push(ws.access === 'write' ? '--bind' : '--ro-bind', ws.path, ws.path);
  }
  if (spec.git) {
    const g = spec.git;
    a.push(g.access === 'write' ? '--bind' : '--ro-bind', g.dir, g.dir);
    for (const p of g.protect) a.push('--ro-bind', p, p);
    if (g.dotGit) a.push('--ro-bind', g.dotGit, g.dotGit);
  }
  a.push('--chdir', spec.cwd);
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) a.push('--setenv', name, '/tmp');
  a.push('--');
  return a;
}

/** A string literal in Seatbelt's profile language. */
export function sbplString(s: string): string {
  if (/[\0\n\r]/.test(s)) throw new Error('Sandbox paths may not contain control characters');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `(subpath P)` minus the denied paths inside P. */
function subpathExcept(path: string, except: readonly string[]): string {
  const inside = except.filter((d) => d !== path && isWithin(d, path));
  const sub = `(subpath ${sbplString(path)})`;
  if (inside.length === 0) return sub;
  return `(require-all ${sub} ${inside.map((d) => `(require-not (subpath ${sbplString(d)}))`).join(' ')})`;
}

/**
 * A Seatbelt profile for `sandbox-exec -p`. Only allow rules over a default
 * deny, written so that no two rules conflict (no reliance on rule order):
 *
 * - reads: everything outside the owner's home, `$ORBIT_HOME`, the denied
 *   paths and shared temporary folders; plus the plugin, its runtime, its
 *   folders, the workspace and its private directory (metadata everywhere,
 *   which path resolution needs);
 * - writes: the private directory, and the workspace and folders declared
 *   writable (a git directory without its config, hooks and info);
 * - network only when a tool needs it; a short list of system services.
 *
 * macOS cannot replace $HOME in place: the caller points HOME and TMPDIR at
 * `privateDir`.
 */
export function seatbeltProfile(spec: PluginSandboxSpec): string {
  const priv = spec.privateDir;
  if (!priv) throw new Error('A macOS plugin sandbox needs a private directory');
  const denied = [
    spec.home,
    spec.orbitHome,
    ...spec.denied.map((d) => d.path),
    ...(spec.tempRoots ?? []),
  ];
  const readable = [
    spec.pluginDir,
    ...spec.runtime,
    ...spec.folders.map((f) => f.path),
    ...(spec.workspace ? [spec.workspace.path] : []),
    ...(spec.git ? [spec.git.dir, ...(spec.git.dotGit ? [spec.git.dotGit] : [])] : []),
  ];
  const writable = [
    ...spec.folders.filter((f) => f.access === 'write').map((f) => f.path),
    ...(spec.workspace?.access === 'write' ? [spec.workspace.path] : []),
  ];
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow user-preference-read)',
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(allow file-read-metadata)',
    `(allow mach-lookup ${[...DARWIN_MACH_SERVICES, ...(spec.network ? DARWIN_NETWORK_MACH_SERVICES : [])].map((n) => `(global-name ${sbplString(n)})`).join(' ')})`,
    `(allow file-read* (require-all (subpath "/") ${[...new Set(denied)].map((d) => `(require-not (subpath ${sbplString(d)}))`).join(' ')}))`,
    `(allow file-read* ${readable.map((p) => subpathExcept(p, denied)).join(' ')} (subpath ${sbplString(priv)}))`,
    `(allow file-write* (subpath ${sbplString(priv)}) (literal ${sbplString('/dev/null')})${writable.map((p) => ` ${subpathExcept(p, denied)}`).join('')})`,
  ];
  if (spec.git?.access === 'write') {
    lines.push(`(allow file-write* ${subpathExcept(spec.git.dir, spec.git.protect)})`);
  }
  if (spec.network) lines.push('(allow network*)');
  return `${lines.join('\n')}\n`;
}

export interface WrappedCommand {
  command: string;
  args: string[];
}

/** The plugin's command wrapped in the sandbox. */
export function wrapPluginCommand(
  engine: { kind: PluginSandboxEngine; path: string },
  spec: PluginSandboxSpec,
  cmd: WrappedCommand,
): WrappedCommand {
  if (engine.kind === 'bwrap') {
    return { command: engine.path, args: [...bwrapArgs(spec), cmd.command, ...cmd.args] };
  }
  return {
    command: engine.path,
    args: ['-p', seatbeltProfile(spec), cmd.command, ...cmd.args],
  };
}

// ── detection ────────────────────────────────────────────────────────────────

export interface PluginSandboxSupport {
  available: boolean;
  engine: PluginSandboxEngine | null;
  /** The wrapper binary. */
  path: string | null;
  /** Why it is unavailable (null when available). */
  reason: string | null;
  platform: string;
}

export interface DetectPluginSandboxOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  exists?: (path: string) => boolean;
  /** Runs a probe (the wrapper with a trivial profile); default spawnSync with `env`. */
  probe?: (command: string, args: string[]) => { code: number | null; stderr: string };
  /** Environment for the probe (already allowlisted). */
  env?: Record<string, string>;
}

/**
 * Can this host sandbox plugin servers? bwrap must be on PATH and actually
 * build namespaces (a container or an AppArmor policy may forbid them), or
 * macOS must have sandbox-exec. Never throws.
 */
export function detectPluginSandbox(opts: DetectPluginSandboxOptions = {}): PluginSandboxSupport {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? isExecutableFile;
  const probe =
    opts.probe ??
    ((command: string, args: string[]) => {
      const r = spawnSync(command, args, {
        env: opts.env ?? {},
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return {
        code: r.error ? null : r.status,
        stderr: r.error ? errorMessage(r.error) : r.stderr,
      };
    });
  const unavailable = (reason: string): PluginSandboxSupport => ({
    available: false,
    engine: null,
    path: null,
    reason,
    platform,
  });
  let engine: PluginSandboxEngine;
  let path: string | undefined;
  let probeArgs: string[];
  if (platform === 'linux') {
    const dirs = (opts.pathEnv ?? process.env.PATH ?? '').split(delimiter).filter(Boolean);
    path = dirs.map((d) => join(d, 'bwrap')).find((p) => exists(p));
    if (!path) return unavailable('bubblewrap (bwrap) is not installed');
    engine = 'bwrap';
    probeArgs = [
      '--unshare-all',
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--',
      'true',
    ];
  } else if (platform === 'darwin') {
    if (!exists(DARWIN_SANDBOX_EXEC)) return unavailable('sandbox-exec is missing');
    path = DARWIN_SANDBOX_EXEC;
    engine = 'sandbox-exec';
    probeArgs = ['-p', '(version 1)(allow default)', '/usr/bin/true'];
  } else {
    return unavailable(`no plugin sandbox on ${platform}`);
  }
  const r = probe(path, probeArgs);
  if (r.code !== 0) {
    const detail = r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
    return unavailable(
      `${engine} is installed but cannot create a sandbox here${detail ? ` (${detail})` : ''}`,
    );
  }
  return { available: true, engine, path, reason: null, platform };
}
