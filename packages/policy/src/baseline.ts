import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PermissionHandler, ToolPermissionDecision } from '@orbit/core';

/** Built-in engine tools that only read (confined to the workspace + read roots). */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
]);

/** Tools with no filesystem target. */
export const SAFE_TOOLS: ReadonlySet<string> = new Set(['TodoWrite']);

/** Subagent delegation; the subagent's own tool calls are checked separately. */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** Built-in engine tools that write files (allowed only inside the workspace). */
export const LOCAL_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * Files inside a workspace that the engine may load as configuration or
 * standing instructions. A Bot must not be able to rewrite its own setup.
 */
const PROTECTED_WORKSPACE_NAMES: ReadonlySet<string> = new Set([
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.mcp.json',
]);
const PROTECTED_WORKSPACE_DIRS: readonly string[] = ['.claude', '.git'];

export interface BaselinePolicyOptions {
  /** The Bot's workspace: reads and writes are confined to it. */
  workspace: string;
  /** Extra directories the Bot may read (never write). */
  readRoots?: readonly string[];
  /** Home directory used for the sensitive-path deny list (tests override it). */
  home?: string;
  /** Orbit's data directory; never readable except the Bot's own workspace. */
  orbitHome?: string;
}

/** Resolve symlinks of the longest existing prefix so links cannot escape a root. */
function realish(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/** Absolute, symlink-resolved path, or null for paths Orbit refuses to interpret (`~…`). */
export function resolveTarget(root: string, target: string): string | null {
  if (target.startsWith('~')) return null; // the engine expands ~ to $HOME
  return realish(isAbsolute(target) ? target : resolve(root, target));
}

export function isInside(root: string, target: string): boolean {
  const abs = resolveTarget(root, target);
  if (abs === null) return false;
  const rel = relative(realish(resolve(root)), abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sensitiveRoots(home: string, orbitHome: string | undefined): string[] {
  const roots = [
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
  ].map((p) => join(home, p));
  roots.push('/proc', '/sys', '/etc/shadow');
  if (orbitHome) roots.push(orbitHome);
  return roots.map((r) => realish(r));
}

function within(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Every path-like argument of a file tool (Glob/Grep patterns included). */
function targetsOf(toolName: string, input: Record<string, unknown>): string[] {
  const keys = ['file_path', 'notebook_path', 'path'];
  if (toolName === 'Glob') keys.push('pattern');
  if (toolName === 'Grep') keys.push('glob');
  return keys.flatMap((k) => {
    const v = input[k];
    return typeof v === 'string' && v.length > 0 ? [v] : [];
  });
}

const allow = (reason: string): ToolPermissionDecision => ({ behavior: 'allow', reason });
const deny = (reason: string): ToolPermissionDecision => ({ behavior: 'deny', reason });

export interface FileAccessContext {
  workspace: string;
  readRoots: readonly string[];
  sensitive: readonly string[];
}

export function fileAccessContext(o: BaselinePolicyOptions): FileAccessContext {
  const workspace = realish(resolve(o.workspace));
  return {
    workspace,
    readRoots: [workspace, ...(o.readRoots ?? []).map((r) => realish(resolve(r)))],
    sensitive: sensitiveRoots(o.home ?? homedir(), o.orbitHome),
  };
}

/**
 * Path confinement for built-in file tools. Returns a deny reason, or null
 * when every path argument is acceptable (or the tool has no path).
 */
export function checkFileAccess(
  toolName: string,
  input: Record<string, unknown>,
  ctx: FileAccessContext,
): string | null {
  const { workspace, readRoots, sensitive } = ctx;
  const isSensitive = (abs: string) =>
    !within(workspace, abs) && sensitive.some((s) => within(s, abs));
  if (READ_TOOLS.has(toolName)) {
    for (const t of targetsOf(toolName, input)) {
      if (t.includes('..')) return `Path traversal is not allowed (${t})`;
      const abs = resolveTarget(workspace, t);
      if (abs === null) return `Home-relative paths are not allowed (${t})`;
      if (isSensitive(abs)) return `Reading credential or system paths is not allowed (${t})`;
      // Glob patterns: check the literal prefix before the first wildcard.
      const literal = abs.split(/[*?[{]/)[0] ?? abs;
      if (!readRoots.some((r) => within(r, literal) || within(r, dirname(literal)))) {
        return `Reads outside the Bot workspace are not allowed (${t})`;
      }
    }
    return null;
  }
  if (LOCAL_WRITE_TOOLS.has(toolName)) {
    const targets = targetsOf(toolName, input);
    if (targets.length === 0) return 'File write without a path';
    for (const t of targets) {
      const abs = resolveTarget(workspace, t);
      if (abs === null) return `Home-relative paths are not allowed (${t})`;
      if (!within(workspace, abs)) return `Writes outside the Bot workspace are not allowed (${t})`;
      const rel = relative(workspace, abs);
      const first = rel.split(sep)[0] ?? '';
      if (
        PROTECTED_WORKSPACE_NAMES.has(basename(abs)) ||
        PROTECTED_WORKSPACE_DIRS.includes(first)
      ) {
        return `Bots may not edit engine configuration or instructions (${rel})`;
      }
    }
  }
  return null;
}

/**
 * Baseline default-deny policy (M1, kept for tests and demos):
 * - read tools may only look inside the workspace (plus explicit read roots),
 *   never at credential stores, /proc or Orbit's own data;
 * - file writes only inside the workspace, never to engine config files;
 * - `~` paths, shell, network, MCP and unknown tools are denied.
 * The tiered PolicyEngine (engine.ts) supersedes it for real Runs.
 */
export function baselinePolicy(options: BaselinePolicyOptions | string): PermissionHandler {
  const o: BaselinePolicyOptions = typeof options === 'string' ? { workspace: options } : options;
  const ctx = fileAccessContext(o);
  return (request) => {
    const { toolName, input } = request;
    if (SAFE_TOOLS.has(toolName)) return Promise.resolve(allow('No filesystem or network access'));
    if (DELEGATION_TOOLS.has(toolName)) {
      return Promise.resolve(allow('Delegation to a subagent (its tool calls are checked too)'));
    }
    if (READ_TOOLS.has(toolName) || LOCAL_WRITE_TOOLS.has(toolName)) {
      const denied = checkFileAccess(toolName, input, ctx);
      if (denied) return Promise.resolve(deny(denied));
      return Promise.resolve(
        allow(
          READ_TOOLS.has(toolName)
            ? 'Read inside the Bot workspace'
            : 'File write inside the Bot workspace',
        ),
      );
    }
    return Promise.resolve(
      deny(`${toolName || 'unnamed tool'} is not permitted by the default-deny policy`),
    );
  };
}
