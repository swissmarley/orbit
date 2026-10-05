import { execFile } from 'node:child_process';
import { basename, isAbsolute, join } from 'node:path';
import type { FileTrigger, GitTrigger } from '@orbit/core';
import { type FSWatcher, watch } from 'chokidar';

export interface FileChange {
  event: 'add' | 'change' | 'unlink';
  path: string;
}

/** `*.tmp`-style patterns on base names (chokidar 4 takes functions, not globs). */
export function ignoreMatcher(patterns: readonly string[]): (path: string) => boolean {
  const res = patterns.map(
    (p) =>
      new RegExp(
        `^${p
          .split('')
          .map((c) =>
            c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\/]/g, '\\$&'),
          )
          .join('')}$`,
      ),
  );
  return (path) => {
    const name = basename(path);
    // Dot-files and dot-folders (.git, editor swap files) never count.
    return name.startsWith('.') || res.some((r) => r.test(name));
  };
}

/** Watches files for a file trigger and reports debounced bursts of changes. */
export class FileWatch {
  private watcher: FSWatcher | null = null;
  private pending: FileChange[] = [];
  private timer: NodeJS.Timeout | undefined;
  error: string | null = null;
  ready = false;

  constructor(
    private readonly trigger: FileTrigger,
    private readonly onChanges: (changes: FileChange[]) => void,
  ) {}

  start(): void {
    const ignored = ignoreMatcher(this.trigger.ignore);
    this.watcher = watch(this.trigger.paths, {
      ignoreInitial: true,
      ignored: (p: string) => ignored(p),
      depth: 8,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    const events = new Set(this.trigger.events);
    for (const event of ['add', 'change', 'unlink'] as const) {
      this.watcher.on(event, (path: string) => {
        if (events.has(event)) this.push({ event, path });
      });
    }
    this.watcher.on('ready', () => {
      this.ready = true;
    });
    this.watcher.on('error', (err: unknown) => {
      this.error = err instanceof Error ? err.message : String(err);
    });
  }

  private push(change: FileChange): void {
    if (this.pending.length < 200) this.pending.push(change);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const batch = this.pending;
      this.pending = [];
      if (batch.length > 0) this.onChanges(batch);
    }, this.trigger.debounceSeconds * 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = null;
  }
}

export interface GitCommit {
  sha: string;
  author: string;
  subject: string;
}

export type GitRunner = (args: string[]) => Promise<string>;

/** git in `repo` with an allowlisted env (never process.env wholesale). */
/**
 * Configuration orbitd forces on the git it runs for a git trigger: nothing
 * in the repository's config may start a program (fsmonitor, signature
 * verification, hooks) inside orbitd (M7 safety review M5).
 */
export const TRIGGER_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['log.showSignature', 'false'],
  ['core.untrackedCache', 'false'],
];

export function gitRunner(repo: string, env: Record<string, string>): GitRunner {
  const forced: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_COUNT: String(TRIGGER_GIT_CONFIG.length),
  };
  TRIGGER_GIT_CONFIG.forEach(([k, v], i) => {
    forced[`GIT_CONFIG_KEY_${i}`] = k;
    forced[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_')));
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', repo, ...args],
        { env: { ...childEnv, ...forced }, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (err, stdout) => (err ? reject(new Error(err.message)) : resolve(stdout)),
      );
    });
}

/** Watches a branch of a local repository and reports new commits (debounced, polled as a backstop). */
export class GitWatch {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private last: string | null = null;
  private checking = false;
  error: string | null = null;
  ready = false;

  constructor(
    private readonly trigger: GitTrigger,
    private readonly git: GitRunner,
    private readonly onCommits: (commits: GitCommit[], head: string) => void,
    private readonly pollMs = 60_000,
  ) {}

  private async head(): Promise<string | null> {
    try {
      return (
        (
          await this.git([
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${this.trigger.branch}^{commit}`,
          ])
        ).trim() || null
      );
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    try {
      const common = (await this.git(['rev-parse', '--git-common-dir'])).trim();
      const dir = isAbsolute(common) ? common : join(this.trigger.repo, common);
      this.last = await this.head();
      this.watcher = watch([join(dir, 'refs', 'heads'), join(dir, 'packed-refs')], {
        ignoreInitial: true,
        depth: 6,
      });
      for (const ev of ['add', 'change', 'unlink'] as const) this.watcher.on(ev, () => this.soon());
      this.watcher.on('ready', () => {
        this.ready = true;
      });
      this.watcher.on('error', (err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
      });
      // The backstop poll checks directly: re-debouncing would postpone forever.
      this.poll = setInterval(() => {
        if (!this.timer) void this.check();
      }, this.pollMs);
      this.poll.unref();
    } catch (err) {
      this.error = `${this.trigger.repo} is not a git repository: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    }
  }

  private soon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, this.trigger.debounceSeconds * 1000);
    this.timer.unref();
  }

  /** Compare the branch head with the last one seen; report the commits in between. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const head = await this.head();
      if (!head || head === this.last) return;
      const range = this.last ? `${this.last}..${head}` : head;
      const out = await this.git([
        'log',
        '--no-show-signature',
        '--format=%h%x09%an%x09%s',
        '-n',
        '20',
        range,
      ]).catch(() => '');
      this.last = head;
      const commits = out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [sha = '', author = '', ...rest] = l.split('\t');
          return { sha, author, subject: rest.join('\t') };
        });
      this.onCommits(commits, head);
    } finally {
      this.checking = false;
    }
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    clearInterval(this.poll);
    await this.watcher?.close();
    this.watcher = null;
  }
}
