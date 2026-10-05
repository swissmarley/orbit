import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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
  ['log.showSignature', 'false'],
  // A nested repository the Bot made in its workspace has a Bot-written config
  // (filters, fsmonitor…); git must never look inside it (re-review H1).
  ['diff.ignoreSubmodules', 'all'],
  ['status.submoduleSummary', 'false'],
  ['submodule.recurse', 'false'],
  ['push.recurseSubmodules', 'no'],
];

export const DEFAULT_AUTHOR_NAME = 'Orbit Bot';
export const DEFAULT_AUTHOR_EMAIL = 'orbit-bot@localhost';

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

/**
 * The Bot's repository as Orbit named it: the worktree's administrative
 * directory inside the owner's repository (`<repo>/.git/worktrees/<name>`),
 * the workspace as the work tree, and the Bot's own branch.
 */
export interface BotRepo {
  gitDir: string;
  workTree: string;
  branch: string;
}

interface RunOptions {
  config?: GitConfig;
  timeoutMs?: number;
  /** Run against the Bot's repository (explicit GIT_DIR / GIT_WORK_TREE). */
  repo?: BotRepo;
  /** Otherwise: the directory git runs in. */
  cwd?: string;
}

/**
 * Run git (never a shell). Against a BotRepo, git gets GIT_DIR and
 * GIT_WORK_TREE explicitly, so the `.git` file in the workspace (which the Bot
 * can rewrite to point at a repository and configuration of its own) is never
 * consulted.
 */
export function runGit(
  ctx: ToolContext,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<GitResult> {
  const cwd = opts.repo?.workTree ?? opts.cwd ?? ctx.workspace;
  if (!existsSync(cwd)) {
    return Promise.reject(new ToolError('The workspace folder does not exist'));
  }
  const env = gitEnv(ctx, opts.config ?? []);
  if (opts.repo) {
    env.GIT_DIR = opts.repo.gitDir;
    env.GIT_WORK_TREE = opts.repo.workTree;
  }
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env,
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeoutMs ?? 60_000,
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

const BOT_BRANCH = /^orbit\/[a-z0-9_]{1,64}$/;

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

const NOT_WORKTREE =
  "git runs only for worktree Bots (sandbox.kind 'worktree'), whose repository Orbit names";

/**
 * The Bot's repository, from what Orbit passed (ORBIT_GIT_REPO,
 * ORBIT_GIT_BRANCH) — never from the workspace's `.git` file. The worktree's
 * administrative directory is found in the owner's repository by its
 * `gitdir` back-pointer to this workspace (ADR-014; M7 safety review H1).
 */
export async function botRepo(ctx: ToolContext): Promise<BotRepo> {
  const repoPath = ctx.env.ORBIT_GIT_REPO?.trim();
  const branch = ctx.env.ORBIT_GIT_BRANCH?.trim();
  if (!repoPath || !branch) throw new ToolError(NOT_WORKTREE);
  if (!BOT_BRANCH.test(branch)) {
    throw new ToolError(`Orbit named an unexpected branch for this Bot: "${cleanText(branch)}"`);
  }
  if (!existsSync(ctx.workspace)) throw new ToolError('The workspace folder does not exist');
  const ws = real(ctx.workspace);
  const repo = real(repoPath);
  if (within(repo, ws)) {
    throw new ToolError(NOT_WORKTREE);
  }
  const r = await runGit(ctx, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repo,
  });
  const common = r.stdout.trim();
  if (r.code !== 0 || !common) {
    throw new ToolError(`The Bot's repository (${cleanText(repoPath)}) is not a git repository`);
  }
  const commonDir = real(common);
  if (within(commonDir, ws)) throw new ToolError(NOT_WORKTREE);
  const worktrees = join(commonDir, 'worktrees');
  let names: string[];
  try {
    names = readdirSync(worktrees);
  } catch {
    names = [];
  }
  const gitDir = names
    .map((n) => join(worktrees, n))
    .find((dir) => {
      try {
        const target = readFileSync(join(dir, 'gitdir'), 'utf8').trim();
        return target !== '' && real(dirname(resolve(dir, target))) === ws;
      } catch {
        return false;
      }
    });
  if (!gitDir) {
    throw new ToolError(
      `The workspace is not a git worktree of the Bot's repository (${cleanText(repoPath)})`,
    );
  }
  return { gitDir, workTree: ws, branch };
}

/** The checked-out branch, or null when HEAD is detached. */
export async function currentBranch(ctx: ToolContext, repo: BotRepo): Promise<string | null> {
  const r = await runGit(ctx, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { repo });
  const b = r.stdout.trim();
  return r.code === 0 && b ? b : null;
}

/** The Bot's repository, checked out on exactly the Bot's own branch, or a clear refusal. */
export async function requireBotBranch(ctx: ToolContext): Promise<BotRepo> {
  const repo = await botRepo(ctx);
  const branch = await currentBranch(ctx, repo);
  if (!branch) {
    throw new ToolError(
      `HEAD is detached; commits and pushes happen only on the Bot's own branch ${repo.branch}`,
    );
  }
  if (branch !== repo.branch) {
    throw new ToolError(
      `The workspace is on branch "${cleanText(branch)}"; this plugin commits and pushes only on the Bot's own branch ${repo.branch}`,
    );
  }
  return repo;
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

/**
 * Refuse to commit when the workspace holds a nested git repository or the
 * index has a submodule: git would look inside it (`git add` included), and
 * its config is the Bot's own — filters and fsmonitor run outside the
 * sandbox (re-review H1). Listing them runs nothing inside them.
 */
async function refuseNestedRepositories(ctx: ToolContext, repo: BotRepo): Promise<void> {
  const index = await runGit(ctx, ['ls-files', '-s', '-z'], { repo });
  if (index.code !== 0) throw new ToolError(`git ls-files failed:\n${gitMessage(index, ctx)}`);
  const gitlinks = index.stdout
    .split('\0')
    .filter((l) => l.startsWith('160000 '))
    .map((l) => l.slice(l.indexOf('\t') + 1));
  // Untracked nested repositories are listed as one entry ending in "/".
  const others = await runGit(ctx, ['ls-files', '--others', '--exclude-standard', '-z'], { repo });
  if (others.code !== 0) throw new ToolError(`git ls-files failed:\n${gitMessage(others, ctx)}`);
  const nested = others.stdout.split('\0').filter((p) => p.endsWith('/'));
  const found = [...gitlinks, ...nested].map((p) => cleanText(p)).slice(0, 10);
  if (found.length > 0) {
    throw new ToolError(
      `Not committed: the workspace holds nested git repositories or submodules (${found.join(', ')}), which this plugin never touches. Remove their own .git folders, or commit them by hand.`,
    );
  }
}

const Sha = z.string().regex(/^[0-9a-f]{7,40}$/, 'a commit sha (7 to 40 lowercase hex characters)');

export const gitTools = [
  defineTool({
    name: 'git_status',
    description:
      "Show the workspace's git status: the current branch, staged, unstaged and untracked files.",
    input: z.object({}),
    run: async (_args, ctx) => {
      const repo = await botRepo(ctx);
      const r = await runGit(
        ctx,
        ['status', '--short', '--branch', '--untracked-files=all', '--ignore-submodules=all'],
        {
          repo,
        },
      );
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
      const repo = await botRepo(ctx);
      const spec = ['--', ...(paths ?? [])];
      const diffArgs = [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-submodules=all',
      ];
      const staged = await runGit(ctx, [...diffArgs, '--cached', ...spec], { repo });
      const unstaged = await runGit(ctx, [...diffArgs, ...spec], { repo });
      const untracked = await runGit(ctx, ['ls-files', '--others', '--exclude-standard', ...spec], {
        repo,
      });
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
      const repo = await botRepo(ctx);
      const r = await runGit(
        ctx,
        [
          'log',
          `--max-count=${limit}`,
          '--no-color',
          '--no-show-signature',
          '--date=short',
          '--format=%h%x09%ad%x09%an%x09%s',
          '--',
        ],
        { repo },
      );
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
      const repo = await requireBotBranch(ctx);
      const { branch } = repo;
      await refuseNestedRepositories(ctx, repo);
      const add = await runGit(ctx, ['add', '-A', '--', ...(paths ?? [])], { repo });
      if (add.code !== 0) throw new ToolError(`git add failed:\n${gitMessage(add, ctx)}`);
      const staged = await runGit(ctx, ['diff', '--cached', '--quiet', '--no-ext-diff'], { repo });
      if (staged.code === 0) {
        return `Nothing to commit on ${branch}: no changes${paths ? ' in the given paths' : ''}.`;
      }
      if (staged.code !== 1) throw new ToolError(`git diff failed:\n${gitMessage(staged, ctx)}`);
      const commit = await runGit(ctx, ['commit', '--no-verify', '--quiet', '-m', message], {
        repo,
      });
      if (commit.code !== 0) {
        if (/nothing (added )?to commit/.test(commit.stdout + commit.stderr)) {
          return `Nothing to commit on ${branch}.`;
        }
        throw new ToolError(`git commit failed:\n${gitMessage(commit, ctx)}`);
      }
      const head = await runGit(
        ctx,
        ['log', '-1', '--no-show-signature', '--format=%h%x09%s', '--shortstat', 'HEAD'],
        { repo },
      );
      const [first = '', ...rest] = cleanText(head.stdout).trim().split('\n');
      const [sha = '', subject = ''] = first.split('\t');
      const stat = rest.join(' ').trim();
      return `Committed ${sha} on ${branch}: ${subject}${stat ? `\n${stat}` : ''}`;
    },
  }),
  defineTool({
    name: 'git_push',
    description:
      "Push the Bot's own orbit/<bot> branch to a remote (default origin). Name the branch and the commit being pushed (its sha from git_log) so your owner approves exactly that. Never forces and never pushes another branch.",
    input: z.object({
      branch: z.string().max(100).describe("The Bot's own branch (orbit/<bot>)"),
      head: Sha.describe('The commit at the tip of the branch, as git_log shows it'),
      remote: RemoteName.default('origin'),
    }),
    run: async ({ branch: named, head, remote }, ctx) => {
      const repo = await requireBotBranch(ctx);
      const { branch } = repo;
      if (named !== branch) {
        throw new ToolError(
          `Only the Bot's own branch ${branch} can be pushed (the call named "${cleanText(named)}")`,
        );
      }
      const tip = await runGit(ctx, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
        repo,
      });
      const sha = tip.stdout.trim();
      if (tip.code !== 0 || !sha) throw new ToolError(`${branch} has no commits to push`);
      if (!sha.startsWith(head)) {
        throw new ToolError(
          `${branch} is at ${sha.slice(0, 12)}, not ${head}: the branch changed after this push was approved. Nothing was pushed.`,
        );
      }
      const url = await runGit(ctx, ['config', '--get', `remote.${remote}.url`], { repo });
      if (url.code !== 0 || !url.stdout.trim()) {
        throw new ToolError(`There is no remote named "${remote}" in this repository`);
      }
      const token = githubToken(ctx);
      const auth = pushAuthConfig(url.stdout.trim(), token);
      const r = await runGit(
        ctx,
        ['push', '--no-verify', '--porcelain', remote, `${sha}:refs/heads/${branch}`],
        { repo, config: auth, timeoutMs: 120_000 },
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
      const remoteNote = cleanText(scrubSecret(r.stderr, token))
        .split('\n')
        .filter((l) => l.startsWith('remote:') && l.replace('remote:', '').trim())
        .join('\n')
        .slice(0, 1000);
      return `Pushed ${branch} (${sha.slice(0, 12)}) to ${remote}.${remoteNote ? `\n${remoteNote}` : ''}`;
    },
  }),
];
