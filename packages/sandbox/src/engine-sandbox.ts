import { isAbsolute, join, relative, resolve } from 'node:path';
import { OrbitError } from '@orbit/core';

/**
 * Home-relative credential stores a Bot must never read (ADR-005). Denying the
 * whole Claude config directory covers the CLI's OAuth credential file without
 * naming it.
 */
export const DENIED_HOME_PATHS: readonly string[] = [
  '.claude',
  '.claude.json',
  '.ssh',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.gnupg',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.config/gcloud',
  '.config/gh',
];

/** Absolute paths never readable from the sandbox (process environments of other processes). */
export const DENIED_ABSOLUTE_PATHS: readonly string[] = ['/proc', '/sys'];

export interface EngineSandboxOptions {
  /** The Bot's workspace: the only writable path. */
  workspace: string;
  home: string;
  /** Orbit's data directory (database, secrets, other Bots' workspaces). */
  orbitHome: string;
  network: 'none' | 'allowlist';
  allowedDomains: string[];
  /** Extra read-only directories from the Bot spec. */
  readRoots: string[];
  /** Further paths to deny, e.g. a non-default CLAUDE_CONFIG_DIR. */
  extraDenied?: readonly string[];
}

/** True when `child` is `parent` or lies inside it. */
export function isWithin(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Claude Code native-sandbox settings (`sandbox` key of `--settings` / SDK
 * `Options.sandbox`) confining a Bot to its workspace:
 *
 * - writes: only the workspace;
 * - reads: everything except credential stores and Orbit's own data
 *   directory. `allowRead` (which takes precedence over `denyRead`) re-opens
 *   the workspace when it lives inside orbitHome, plus the Bot's readRoots —
 *   except readRoots that overlap a denied path, which are dropped so a broad
 *   root such as `~` can never re-open `~/.ssh` (outside the denied paths
 *   reads are allowed anyway);
 * - network: strict domain allowlist (empty for `none`);
 * - no unsandboxed escape hatch and no auto-approval of Bash; the engine fails
 *   instead of silently running unsandboxed.
 */
export function engineSandboxSettings(opts: EngineSandboxOptions): Record<string, unknown> {
  const workspace = resolve(opts.workspace);
  const credentialStores = DENIED_HOME_PATHS.map((p) => join(resolve(opts.home), p));
  const store = credentialStores.find((p) => isWithin(workspace, p));
  if (store !== undefined) {
    throw new OrbitError(
      'invalid_config',
      `Workspace ${workspace} lies inside credential store ${store}`,
      {
        hint: 'Set ORBIT_HOME to a directory outside your credential stores.',
      },
    );
  }
  const denyRead = [
    ...credentialStores,
    ...DENIED_ABSOLUTE_PATHS,
    ...(opts.extraDenied ?? []).map((p) => resolve(p)),
    resolve(opts.orbitHome),
  ];

  const overlapsDenied = (root: string): boolean =>
    denyRead.some((d) => isWithin(root, d) || isWithin(d, root));
  const allowRead = [
    ...new Set([
      ...opts.readRoots.map((r) => resolve(r)).filter((r) => !overlapsDenied(r)),
      workspace,
    ]),
  ];

  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [workspace],
      denyRead,
      allowRead,
    },
    network: {
      allowedDomains: opts.network === 'none' ? [] : [...new Set(opts.allowedDomains)],
      strictAllowlist: true,
    },
  };
}
