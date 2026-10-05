import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { ToolError, type ToolContext, defineTool } from '@orbit/plugin-kit';
import { z } from 'zod';

/**
 * Git for worktree Bots (ADR-014, closes the M2 deferral): a worktree's `.git`
 * lives outside the engine sandbox, so commits and pushes run here, in the
 * plugin process, with hooks disabled, configuration passed only through
 * `GIT_CONFIG_*` environment variables, the push credential never on a
 * command line, and only on the Bot's own `orbit/<bot>` branch.
 */

export type GitConfig = readonly (readonly [key: string, value: string])[];

/** Always applied: nothing the Bot wrote may execute, nothing may prompt or sign. */
export const BASE_GIT_CONFIG: GitConfig = [
  ['core.hooksPath', '/dev/null'],
  ['commit.gpgSign', 'false'],
  ['core.fsmonitor', 'false'],
  ['protocol.ext.allow', 'never'],
];

export const DEFAULT_AUTHOR_NAME = 'Orbit Bot';
export const DEFAULT_AUTHOR_EMAIL = 'orbit-bot@localhost';
/** The Bot's own branches; commits and pushes happen only there. */
export const BOT_BRANCH_PREFIX = 'orbit/';

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Text for a tool result: control characters removed (keeps newlines and tabs). */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(CONTROL, '');
}

function setting(ctx: ToolContext, name: string, fallback: string): string {
  const v = (ctx.env[name] ?? '')
    .replace(CONTROL, '')
    .replace(/[\r\n\t<>]/g, ' ')
    .trim();
  return v ? v.slice(0, 200) : fallback;
}

/** The author/committer identity from the plugin's settings. */
export function gitIdentity(ctx: ToolContext): { name: string; email: string } {
  return {
    name: setting(ctx, 'GIT_AUTHOR_NAME', DEFAULT_AUTHOR_NAME),
    email: setting(ctx, 'GIT_AUTHOR_EMAIL', DEFAULT_AUTHOR_EMAIL),
  };
}

/**
 * The environment git runs with: the server's own (already allowlisted by
 * Orbit) minus any inherited `GIT_*` variables and the GitHub token, plus a
 * fixed identity, no prompts, and configuration as `GIT_CONFIG_COUNT` /
 * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` (never `-c` on the command line).
 */
export function gitEnv(ctx: ToolContext, config: GitConfig = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env)) {
    if (v === undefined || k.startsWith('GIT_') || k === 'GITHUB_TOKEN') continue;
    env[k] = v;
  }
  const { name, email } = gitIdentity(ctx);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.GIT_LITERAL_PATHSPECS = '1';
  env.GIT_AUTHOR_NAME = name;
  env.GIT_AUTHOR_EMAIL = email;
  env.GIT_COMMITTER_NAME = name;
  env.GIT_COMMITTER_EMAIL = email;
  const all = [...BASE_GIT_CONFIG, ...config];
  env.GIT_CONFIG_COUNT = String(all.length);
  all.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The GitHub token, if one is set (never echoed; refused when it could inject a header). */
export function githubToken(ctx: ToolContext): string | undefined {
  const t = ctx.env.GITHUB_TOKEN?.trim();
  if (!t) return undefined;
  if (!/^[\x21-\x7e]+$/.test(t)) {
    throw new ToolError('GITHUB_TOKEN is malformed; ask your owner to set it again');
  }
  return t;
}

/**
 * Push credentials for an https github.com remote: an `http.<url>.extraheader`
 * (reset first, so a header already in the repository's config is not sent
 * as well). git scopes it to https://github.com/ itself, so a rewritten URL
 * never carries it elsewhere. Nothing for other remotes or without a token.
 */
export function pushAuthConfig(remoteUrl: string, token: string | undefined): GitConfig {
  if (!token) return [];
  let u: URL;
  try {
    u = new URL(remoteUrl);
  } catch {
    return [];
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const key = 'http.https://github.com/.extraheader';
  return [
    [key, ''],
    [key, `AUTHORIZATION: basic ${basic}`],
  ];
}

/** Remove the token (and its encodings) from text that could be shown. */
export function scrubSecret(text: string, token: string | undefined): string {
  if (!token) return text;
  const forms = [
    token,
    encodeURIComponent(token),
    Buffer.from(`x-access-token:${token}`).toString('base64'),
  ];
  let out = text;
  for (const f of forms) out = out.split(f).join('[redacted]');
  return out;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Output was larger than the buffer and cut. */
  truncated: boolean;
}

const MAX_BUFFER = 8 * 1024 * 1024;

/** Run git (never a shell) in the workspace. */
export function runGit(
  ctx: ToolContext,
  args: readonly string[],
  config: GitConfig = [],
  timeoutMs = 60_000,
): Promise<GitResult> {
  if (!existsSync(ctx.workspace)) {
    return Promise.reject(new ToolError('The workspace folder does not exist'));
  }
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: ctx.workspace,
        env: gitEnv(ctx, config),
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
        encoding: 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr, truncated: false });
          return;
        }
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        if (code === 'ENOENT') {
          reject(new ToolError('git is not installed on this computer'));
          return;
        }
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ code: 0, stdout, stderr, truncated: true });
          return;
        }
        if (err.killed) {
          reject(new ToolError(`git ${args[0] ?? ''} took too long and was stopped`));
          return;
        }
        resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr, truncated: false });
      },
    );
  });
}

/** The last lines of git's message, cleaned and without the token. */
export function gitMessage(r: GitResult, ctx: ToolContext): string {
  let token: string | undefined;
  try {
    token = githubToken(ctx);
  } catch {
    token = undefined;
  }
  const text = cleanText(scrubSecret(`${r.stderr}\n${r.stdout}`, token)).trim();
  return text.split('\n').slice(-12).join('\n').slice(0, 2000);
}

/**
 * The workspace must be the top of a git work tree whose repository lives
 * outside it (a worktree Bot: `.git` is in the owner's repository). A `.git`
 * inside the workspace is Bot-writable, so its config (filter drivers,
 * textconv, fsmonitor…) could run commands through git: refused. A workspace
 * that is merely somewhere below another repository is refused too.
 */
export async function requireWorkTree(ctx: ToolContext): Promise<void> {
  const r = await runGit(ctx, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
  ]);
  const [top = '', common = ''] = r.stdout.trim().split('\n');
  if (r.code !== 0 || !top || !common) {
    throw new ToolError('The workspace is not inside a git work tree');
  }
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const ws = real(ctx.workspace);
  if (real(top) !== ws) {
    throw new ToolError(
      "The workspace is not the top of a git work tree; give the Bot a worktree sandbox (sandbox.kind 'worktree')",
    );
  }
  const repo = real(common);
  if (repo === ws || repo.startsWith(ws.endsWith(sep) ? ws : ws + sep)) {
    throw new ToolError(
      "This workspace keeps its own .git, which the Bot can edit; git runs only for worktree Bots (sandbox.kind 'worktree'), whose repository lives outside the workspace",
    );
  }
}

/** The checked-out branch, or null when HEAD is detached. */
export async function currentBranch(ctx: ToolContext): Promise<string | null> {
  const r = await runGit(ctx, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const b = r.stdout.trim();
  return r.code === 0 && b ? b : null;
}

/** The Bot's own branch (`orbit/…`), or a clear refusal. */
export async function requireBotBranch(ctx: ToolContext): Promise<string> {
  await requireWorkTree(ctx);
  const branch = await currentBranch(ctx);
  if (!branch) {
    throw new ToolError(
      `HEAD is detached; commits and pushes happen only on the Bot's own ${BOT_BRANCH_PREFIX}<bot> branch`,
    );
  }
  if (!branch.startsWith(BOT_BRANCH_PREFIX) || branch.length <= BOT_BRANCH_PREFIX.length) {
    throw new ToolError(
      `The workspace is on branch "${cleanText(branch)}"; this plugin commits and pushes only on the Bot's own ${BOT_BRANCH_PREFIX}<bot> branch`,
    );
  }
  return branch;
}

/** Why a path the Bot named is refused, or null when it is a safe relative path. */
export function pathProblem(p: string): string | null {
  if (p.length === 0) return 'is empty';
  if (p.includes('\0')) return 'contains a NUL character';
  if (p.startsWith('-')) return 'starts with "-"';
  if (p.startsWith(':')) return 'starts with ":" (pathspec magic)';
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return 'is absolute';
  if (p.split(/[/\\]/).includes('..')) return 'contains a ".." segment';
  return null;
}

export const RelPath = z
  .string()
  .max(1000)
  .superRefine((p, ctx) => {
    const problem = pathProblem(p);
    if (problem) ctx.addIssue({ code: 'custom', message: `path ${problem}` });
  });

const RemoteName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, 'letters, digits, ".", "_" and "-"')
  .refine((r) => !r.startsWith('-') && r !== '.' && r !== '..', 'not a remote name');

function cap(text: string, max: number, hint: string): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (truncated at ${max} characters; ${hint})`;
}

export const gitTools = [
  defineTool({
    name: 'git_status',
    description:
      "Show the workspace's git status: the current branch, staged, unstaged and untracked files.",
    input: z.object({}),
    run: async (_args, ctx) => {
      await requireWorkTree(ctx);
      const r = await runGit(ctx, ['status', '--short', '--branch', '--untracked-files=all']);
      if (r.code !== 0) throw new ToolError(`git status failed:\n${gitMessage(r, ctx)}`);
      const lines = cleanText(r.stdout).trimEnd().split('\n');
      const body =
        lines.length <= 1 ? `${lines[0] ?? ''}\n(clean: nothing to commit)` : lines.join('\n');
      return cap(body, 20_000, 'commit or narrow the changes');
    },
  }),
  defineTool({
    name: 'git_diff',
    description:
      'Show the uncommitted changes in the workspace (staged and unstaged diffs, and untracked file names), optionally for some paths only.',
    input: z.object({
      paths: z.array(RelPath).max(100).optional(),
      maxChars: z.int().min(1000).max(50_000).default(30_000),
    }),
    run: async ({ paths, maxChars }, ctx) => {
      await requireWorkTree(ctx);
      const spec = ['--', ...(paths ?? [])];
      const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
      const staged = await runGit(ctx, [...diffArgs, '--cached', ...spec]);
      const unstaged = await runGit(ctx, [...diffArgs, ...spec]);
      const untracked = await runGit(ctx, ['ls-files', '--others', '--exclude-standard', ...spec]);
      for (const r of [staged, unstaged, untracked]) {
        if (r.code !== 0) throw new ToolError(`git diff failed:\n${gitMessage(r, ctx)}`);
      }
      const section = (title: string, r: GitResult) =>
        `${title}:\n${cleanText(r.stdout).trimEnd() || '(none)'}${r.truncated ? '\n… (cut: too large)' : ''}`;
      const out = [
        section('Staged changes', staged),
        section('Unstaged changes', unstaged),
        section('Untracked files', untracked),
      ].join('\n\n');
      return cap(out, maxChars, 'pass paths to narrow it');
    },
  }),
  defineTool({
    name: 'git_log',
    description: 'Show the last commits on the current branch (short sha, date, author, subject).',
    input: z.object({ limit: z.int().min(1).max(100).default(10) }),
    run: async ({ limit }, ctx) => {
      await requireWorkTree(ctx);
      const r = await runGit(ctx, [
        'log',
        `--max-count=${limit}`,
        '--no-color',
        '--date=short',
        '--format=%h%x09%ad%x09%an%x09%s',
        '--',
      ]);
      if (r.code !== 0) {
        if (/does not have any commits|bad default revision/.test(r.stderr))
          return 'No commits yet.';
        throw new ToolError(`git log failed:\n${gitMessage(r, ctx)}`);
      }
      const lines = cleanText(r.stdout)
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [sha = '', date = '', author = '', ...subject] = l.split('\t');
          return `${sha} ${date} ${author}: ${subject.join('\t')}`;
        });
      return lines.length ? lines.join('\n') : 'No commits yet.';
    },
  }),
  defineTool({
    name: 'git_commit',
    description:
      "Commit changes in the workspace on the Bot's own orbit/<bot> branch (all changes, or only the given paths). Hooks never run.",
    input: z.object({
      message: z
        .string()
        .min(1)
        .max(5000)
        .refine((m) => !m.includes('\0') && m.trim().length > 0, 'must not be blank'),
      paths: z.array(RelPath).min(1).max(500).optional(),
    }),
    run: async ({ message, paths }, ctx) => {
      const branch = await requireBotBranch(ctx);
      const add = await runGit(ctx, ['add', '-A', '--', ...(paths ?? [])]);
      if (add.code !== 0) throw new ToolError(`git add failed:\n${gitMessage(add, ctx)}`);
      const staged = await runGit(ctx, ['diff', '--cached', '--quiet', '--no-ext-diff']);
      if (staged.code === 0) {
        return `Nothing to commit on ${branch}: no changes${paths ? ' in the given paths' : ''}.`;
      }
      if (staged.code !== 1) throw new ToolError(`git diff failed:\n${gitMessage(staged, ctx)}`);
      const commit = await runGit(ctx, ['commit', '--no-verify', '--quiet', '-m', message]);
      if (commit.code !== 0) {
        if (/nothing (added )?to commit/.test(commit.stdout + commit.stderr)) {
          return `Nothing to commit on ${branch}.`;
        }
        throw new ToolError(`git commit failed:\n${gitMessage(commit, ctx)}`);
      }
      const head = await runGit(ctx, ['log', '-1', '--format=%h%x09%s', '--shortstat', 'HEAD']);
      const [first = '', ...rest] = cleanText(head.stdout).trim().split('\n');
      const [sha = '', subject = ''] = first.split('\t');
      const stat = rest.join(' ').trim();
      return `Committed ${sha} on ${branch}: ${subject}${stat ? `\n${stat}` : ''}`;
    },
  }),
  defineTool({
    name: 'git_push',
    description:
      "Push the Bot's own orbit/<bot> branch to a remote (default origin). Never forces and never pushes another branch.",
    input: z.object({ remote: RemoteName.default('origin') }),
    run: async ({ remote }, ctx) => {
      const branch = await requireBotBranch(ctx);
      const url = await runGit(ctx, ['config', '--get', `remote.${remote}.url`]);
      if (url.code !== 0 || !url.stdout.trim()) {
        throw new ToolError(`There is no remote named "${remote}" in this repository`);
      }
      const token = githubToken(ctx);
      const auth = pushAuthConfig(url.stdout.trim(), token);
      const r = await runGit(
        ctx,
        ['push', '--no-verify', '--porcelain', remote, `HEAD:refs/heads/${branch}`],
        auth,
        120_000,
      );
      if (r.code !== 0) {
        const text = r.stdout + r.stderr;
        if (/non-fast-forward|fetch first|\[rejected\]/.test(text)) {
          throw new ToolError(
            `The push of ${branch} to ${remote} was rejected: the remote branch has commits this workspace does not have (non-fast-forward). Orbit never force-pushes; ask your owner how to reconcile the branches.`,
          );
        }
        throw new ToolError(`git push to ${remote} failed:\n${gitMessage(r, ctx)}`);
      }
      const sha = await runGit(ctx, ['rev-parse', '--short', 'HEAD']);
      const remoteNote = cleanText(scrubSecret(r.stderr, token))
        .split('\n')
        .filter((l) => l.startsWith('remote:') && l.replace('remote:', '').trim())
        .join('\n')
        .slice(0, 1000);
      return `Pushed ${branch} (${sha.stdout.trim()}) to ${remote}.${remoteNote ? `\n${remoteNote}` : ''}`;
    },
  }),
];
