import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { type Bot, type DriverKind, OrbitError, slugify } from '@orbit/core';
import { engineSandboxSettings, pluginDeniedPaths } from './engine-sandbox';
import { detectSandboxSupport } from './support';
import type {
  CommandResult,
  CommandRunner,
  SandboxSupport,
  SpawnOptions,
  SpawnedProcess,
  Workspace,
} from './types';

/** Where the Bot's workspace is mounted inside its container. */
export const CONTAINER_WORKDIR = '/workspace';
/**
 * HOME of the engine inside the container: on the workspace volume so engine
 * sessions survive container restarts (park-and-resume), and writable by the
 * container user.
 */
export const CONTAINER_HOME = `${CONTAINER_WORKDIR}/.orbit-home`;
export const CONTAINER_PREFIX = 'orbit-bot-';
export const BOT_LABEL = 'orbit.bot';

/** `sh -c` script run as `<script> <pidfile> <command> <args…>`: record PID, then exec. */
const PID_WRAPPER = 'echo $$ > "$0" && exec "$@"';

/** Never forwarded into a container, whatever the caller passes (ADR-005). */
const NEVER_FORWARD: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
]);

/** Host-specific variables that would be wrong (or steer the docker CLI) inside a container. */
const HOST_LOCAL: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'TMPDIR',
  'TEMP',
  'TMP',
  'CLAUDE_CONFIG_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PROGRAMDATA',
  'HOMEDRIVE',
  'HOMEPATH',
]);
const HOST_LOCAL_PREFIXES: readonly string[] = ['XDG_', 'DOCKER_'];

/** Variables the Agent SDK itself adds to the engine env (protocol flags, no secrets). */
const SDK_PROTOCOL_PREFIXES: readonly string[] = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_'];

/** Variables the docker CLI client needs; read individually, never process.env wholesale. */
const DOCKER_CLIENT_VARS: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
];

function forwardable(name: string): boolean {
  return (
    !NEVER_FORWARD.has(name) &&
    !HOST_LOCAL.has(name) &&
    !HOST_LOCAL_PREFIXES.some((p) => name.startsWith(p))
  );
}

function defaultDockerClientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of DOCKER_CLIENT_VARS) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function defaultContainerUser(): string | null {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? `${process.getuid()}:${process.getgid()}`
    : null;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Bot ids name directories, containers and branches: refuse anything but `[a-z0-9_]`. */
function safeBotId(bot: Bot): string {
  if (!/^[a-z0-9_]{1,64}$/.test(bot.id)) {
    throw new OrbitError('invalid_config', `Bot id "${bot.id}" cannot name a workspace`);
  }
  return bot.id;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function detail(r: CommandResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`).slice(0, 2000);
}

export interface SandboxManagerOptions {
  /** Further paths sandboxed commands may never read (e.g. CLAUDE_CONFIG_DIR). */
  extraDenied?: readonly string[];
  /**
   * The name a Bot had when M2 created its workspace (`<home>/workspaces/<slug>`),
   * or null when it never had one. Only those workspaces are adopted, so a new
   * or renamed Bot can never take over another Bot's old files. Default: none.
   */
  legacyName?: (bot: Bot) => string | null;
  /** Orbit's data directory; workspaces live in `<orbitHome>/workspaces`. */
  orbitHome: string;
  /** The user's home directory (credential stores are denied relative to it). */
  home?: string;
  /**
   * Runs git / docker. Build it with `defaultRunner(buildChildEnv('tool',
   * process.env))` so no API credential reaches these children (ADR-005).
   */
  run: CommandRunner;
  /** Pre-computed support (otherwise detected lazily with `run`). */
  support?: SandboxSupport;
  /**
   * Environment of the `docker exec` client that hosts the engine, without
   * any credential (the engine's own variables are layered on top). Defaults
   * to PATH, HOME and DOCKER_* picked individually from the daemon's env.
   */
  dockerClientEnv?: Record<string, string>;
  /**
   * `docker run --user`. Defaults to the host uid:gid so the bind-mounted
   * 0700 workspace is writable inside the container; null keeps the image's
   * user (needed for rootless Docker / Docker Desktop setups that remap ids).
   */
  containerUser?: string | null;
}

export interface EngineSpawnerOptions {
  /** Receives the engine's stderr; by default it is drained and discarded. */
  onStderr?: (chunk: string) => void;
}

/**
 * Creates, reuses and tears down per-Bot workspaces (ADR-004):
 * plain directories and git worktrees confined by Claude Code's native
 * sandbox, or a resource-limited Docker container per Bot (API-key mode only).
 */
export class SandboxManager {
  private readonly orbitHome: string;
  private readonly home: string;
  private readonly run: CommandRunner;
  private readonly dockerClientEnv: Record<string, string>;
  private readonly containerUser: string | null;
  private readonly extraDenied: readonly string[];
  private readonly legacyName: (bot: Bot) => string | null;
  private supportPromise: Promise<SandboxSupport> | undefined;

  constructor(opts: SandboxManagerOptions) {
    this.extraDenied = opts.extraDenied ?? [];
    this.legacyName = opts.legacyName ?? (() => null);
    this.orbitHome = resolve(opts.orbitHome);
    this.home = resolve(opts.home ?? homedir());
    this.run = opts.run;
    this.dockerClientEnv = opts.dockerClientEnv ?? defaultDockerClientEnv();
    this.containerUser =
      opts.containerUser === undefined ? defaultContainerUser() : opts.containerUser;
    if (opts.support) this.supportPromise = Promise.resolve(opts.support);
  }

  /** Host sandbox capabilities (detected once, then cached). */
  support(): Promise<SandboxSupport> {
    this.supportPromise ??= detectSandboxSupport(this.run);
    return this.supportPromise;
  }

  /** Container name for a Bot (keyed by id, so renames keep the container). */
  static containerName(bot: Bot): string {
    return `${CONTAINER_PREFIX}${safeBotId(bot)}`;
  }

  /** A worktree Bot's own branch: commits and pushes happen only there. */
  static botBranch(bot: Bot): string {
    return `orbit/${safeBotId(bot)}`;
  }

  /** Paths plugin processes refuse on a Bot's behalf (see pluginDeniedPaths). */
  pluginDeniedPaths(): string[] {
    return pluginDeniedPaths({
      home: this.home,
      orbitHome: realOrSelf(this.orbitHome),
      extraDenied: this.extraDenied,
    });
  }

  /** Host path of a Bot's workspace (whether or not it exists yet), keyed by Bot id. */
  workspacePath(bot: Bot): string {
    return join(realOrSelf(this.orbitHome), 'workspaces', safeBotId(bot));
  }

  /** Where M2 kept the workspace (by name slug), if this Bot had one. */
  private legacyWorkspacePath(bot: Bot): string | null {
    const name = this.legacyName(bot);
    return name === null ? null : join(realOrSelf(this.orbitHome), 'workspaces', slugify(name));
  }

  async prepare(bot: Bot, driver: DriverKind): Promise<Workspace> {
    const sb = bot.spec.sandbox;
    if (sb.kind === 'docker') {
      if (driver === 'cli') {
        throw new OrbitError(
          'invalid_config',
          `Bot "${bot.spec.name}" uses a docker sandbox, which the CLI (subscription) driver cannot use`,
          {
            hint:
              'Subscription credentials never enter containers (ADR-004): the CLI driver runs your own ' +
              'logged-in `claude` on the host. Use an API key (SDK driver) for docker sandboxes, or set ' +
              'sandbox.kind to "worktree" or "directory".',
          },
        );
      }
      const support = await this.support();
      if (!support.docker.available) {
        throw new OrbitError(
          'driver_unavailable',
          `Docker is not available: ${support.docker.error ?? 'unknown error'}`,
          {
            hint:
              'Start the Docker daemon (or install Docker) and check `docker version`, or set ' +
              'sandbox.kind to "worktree" or "directory" for this Bot.',
          },
        );
      }
    }
    if (sb.kind === 'worktree' && (sb.repo === undefined || !isAbsolute(sb.repo))) {
      throw new OrbitError(
        'invalid_config',
        `Bot "${bot.spec.name}" uses a worktree sandbox but sandbox.repo is ${sb.repo === undefined ? 'not set' : `not absolute (${sb.repo})`}`,
        { hint: 'Set sandbox.repo to the absolute path of a git repository.' },
      );
    }

    ensurePrivateDir(this.orbitHome);
    ensurePrivateDir(join(this.orbitHome, 'workspaces'));
    const path = this.workspacePath(bot);
    await this.adoptLegacyWorkspace(bot, path);

    switch (sb.kind) {
      case 'docker':
        return this.prepareDocker(bot, path);
      case 'worktree': {
        const repo = resolve(sb.repo ?? '');
        await this.prepareWorktree(bot, path, repo);
        const ws = await this.hostWorkspace(bot, 'worktree', path);
        return { ...ws, git: { repo: realOrSelf(repo), branch: SandboxManager.botBranch(bot) } };
      }
      case 'directory':
        ensurePrivateDir(path);
        return this.hostWorkspace(bot, 'directory', path);
    }
  }

  /**
   * Move a workspace created before workspaces were keyed by id (M2 used the
   * name slug) to its id path, keeping the Bot's files. Worktrees are moved
   * with git so the repository's worktree registry stays consistent.
   */
  private async adoptLegacyWorkspace(bot: Bot, path: string): Promise<void> {
    const legacy = this.legacyWorkspacePath(bot);
    if (legacy === null || legacy === path || existsSync(path) || !existsSync(legacy)) return;
    const sb = bot.spec.sandbox;
    if (sb.kind === 'worktree' && sb.repo !== undefined) {
      const repo = resolve(sb.repo);
      if ((await this.listWorktrees(repo)).includes(realOrSelf(legacy))) {
        const r = await this.git(repo, ['worktree', 'move', legacy, path]);
        if (r.code !== 0) {
          throw new OrbitError('invalid_config', `git worktree move failed: ${detail(r)}`, {
            hint: `Move ${legacy} to ${path} by hand (git worktree move), then retry.`,
          });
        }
        return;
      }
    }
    renameSync(legacy, path);
  }

  async destroy(bot: Bot, opts: { purge?: boolean } = {}): Promise<void> {
    const sb = bot.spec.sandbox;
    const path = this.workspacePath(bot);
    if (sb.kind === 'docker') await this.removeContainer(bot);
    if (sb.kind === 'worktree' && sb.repo !== undefined && isAbsolute(sb.repo)) {
      await this.removeWorktree(resolve(sb.repo), path, opts.purge === true);
    }
    if (opts.purge === true) rmSync(path, { recursive: true, force: true });
  }

  /**
   * A `spawnClaudeCodeProcess` implementation for a docker workspace: runs
   * `docker exec -i -w <workdir> -e NAME… <container> sh -c <pid-wrapper>
   * <pidfile> <command> <args>`. The wrapper only records the engine's PID
   * (then `exec`s it) so `kill()` / abort can signal the engine inside the
   * container — `docker exec` itself does not forward signals.
   *
   * `engineEnv` is the SDK engine environment the caller built with
   * `buildChildEnv('sdk-engine', process.env, …)` (ADR-005). Only variable
   * *names* go on the command line; values reach `docker exec` through its own
   * process environment, so secrets never appear in `ps` or `docker inspect`.
   * Host-specific variables (PATH, HOME, CA paths, DOCKER_*) are not forwarded;
   * SDK protocol flags (CLAUDE_CODE_*, CLAUDE_AGENT_SDK_*) set by the SDK on
   * `options.env` are. Set the SDK's `pathToClaudeCodeExecutable` to the
   * engine binary inside the image (`claude`); `options.cwd` is replaced by
   * the container workdir.
   */
  engineSpawner(
    ws: Workspace,
    engineEnv: Record<string, string>,
    opts: EngineSpawnerOptions = {},
  ): (options: SpawnOptions) => SpawnedProcess {
    const target = ws.docker;
    if (target === null) {
      throw new OrbitError(
        'invalid_input',
        `Workspace of Bot ${ws.botId} is not a docker workspace`,
      );
    }
    const clientEnv = this.dockerClientEnv;
    return (options) => {
      const forwarded: Record<string, string> = {};
      for (const [name, value] of Object.entries(engineEnv)) {
        if (forwardable(name)) forwarded[name] = value;
      }
      for (const [name, value] of Object.entries(options.env)) {
        if (
          value !== undefined &&
          !(name in forwarded) &&
          forwardable(name) &&
          SDK_PROTOCOL_PREFIXES.some((p) => name.startsWith(p))
        ) {
          forwarded[name] = value;
        }
      }
      const names = Object.keys(forwarded).sort();
      // `docker exec` does not proxy signals: killing the client leaves the
      // engine running in the container. A tiny sh wrapper records the
      // engine's PID (exec keeps it) so kill() can signal it in place.
      const pidFile = `/tmp/orbit-engine-${randomUUID()}.pid`;
      const args = [
        'exec',
        '-i',
        '-w',
        target.workdir,
        ...names.flatMap((n) => ['-e', n]),
        target.container,
        'sh',
        '-c',
        PID_WRAPPER,
        pidFile,
        options.command,
        ...options.args,
      ];
      const child = spawn('docker', args, {
        env: { ...clientEnv, ...forwarded },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const { onStderr } = opts;
      if (onStderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          onStderr(chunk);
        });
      } else {
        child.stderr.resume();
      }

      const inContainer = (script: string): void => {
        const helper = spawn('docker', ['exec', target.container, 'sh', '-c', script], {
          env: clientEnv,
          stdio: 'ignore',
          windowsHide: true,
        });
        helper.on('error', () => undefined);
      };
      const running = (): boolean => child.exitCode === null && child.signalCode === null;
      const killClient = child.kill.bind(child);
      child.kill = (sig?: NodeJS.Signals | number): boolean => {
        const name = typeof sig === 'string' && /^SIG[A-Z0-9]+$/.test(sig) ? sig.slice(3) : 'TERM';
        if (running()) {
          inContainer(`kill -s ${name} "$(cat ${pidFile})" 2>/dev/null; rm -f ${pidFile}`);
        }
        return killClient(sig);
      };

      const { signal } = options;
      const abort = (): void => {
        if (running()) child.kill('SIGTERM');
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      child.once('exit', () => {
        signal.removeEventListener('abort', abort);
        if (!child.killed) inContainer(`rm -f ${pidFile}`);
      });
      return child;
    };
  }

  // ---------------------------------------------------------------- host

  private async hostWorkspace(
    bot: Bot,
    kind: 'directory' | 'worktree',
    path: string,
  ): Promise<Workspace> {
    const sb = bot.spec.sandbox;
    const support = await this.support();
    const isolation = support.engineSandbox.available ? 'engine-sandbox' : 'none';
    return {
      botId: bot.id,
      kind,
      path,
      isolation,
      // Not trusted until the native sandbox is verified live on a machine with
      // bwrap/socat or macOS (PLAN §7; M2 review H2): Bash stays EXTERNAL.
      shellContained: false,
      // Without a usable native sandbox the settings (failIfUnavailable) would
      // make every Run fail; isolation 'none' instead makes the policy engine
      // treat Bash as EXTERNAL.
      engineSandboxSettings:
        isolation === 'engine-sandbox'
          ? engineSandboxSettings({
              workspace: path,
              home: this.home,
              orbitHome: realOrSelf(this.orbitHome),
              network: sb.network,
              allowedDomains: sb.allowedDomains,
              readRoots: bot.spec.readRoots,
              extraDenied: this.extraDenied,
            })
          : null,
      docker: null,
    };
  }

  private async git(repo: string, args: string[]): Promise<CommandResult> {
    return this.run('git', ['-C', repo, ...args], { timeoutMs: 120_000 });
  }

  private async listWorktrees(repo: string): Promise<string[]> {
    const r = await this.git(repo, ['worktree', 'list', '--porcelain']);
    if (r.code !== 0) {
      throw new OrbitError('invalid_config', `git worktree list failed in ${repo}: ${detail(r)}`);
    }
    return r.stdout
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => realOrSelf(l.slice('worktree '.length)));
  }

  private async prepareWorktree(bot: Bot, path: string, repo: string): Promise<void> {
    const check = await this.git(repo, ['rev-parse', '--git-dir']);
    if (check.code !== 0) {
      throw new OrbitError('invalid_config', `sandbox.repo ${repo} is not a git repository`, {
        hint: `git said: ${detail(check)}`,
      });
    }
    const registered = (await this.listWorktrees(repo)).includes(realOrSelf(path));
    if (registered && existsSync(join(path, '.git'))) return;
    if (registered) await this.git(repo, ['worktree', 'prune']);

    if (existsSync(path) && readdirSync(path).length > 0) {
      throw new OrbitError(
        'invalid_config',
        `Workspace ${path} exists and is not a worktree of ${repo}`,
        {
          hint:
            'It may hold files from an earlier sandbox. Move them away, or destroy the Bot ' +
            'workspace with purge, then prepare again.',
        },
      );
    }
    ensurePrivateDir(path);

    const branch = SandboxManager.botBranch(bot);
    const exists = await this.git(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    // Reattach an existing Bot branch as-is (keeps the Bot's earlier commits);
    // otherwise create it from the repository's HEAD.
    const add =
      exists.code === 0
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', '-B', branch, path];
    const r = await this.git(repo, add);
    if (r.code !== 0) {
      throw new OrbitError('invalid_config', `git worktree add failed: ${detail(r)}`, {
        hint: `Check that ${repo} has at least one commit and that ${branch} is not checked out elsewhere.`,
      });
    }
  }

  private async removeWorktree(repo: string, path: string, purge: boolean): Promise<void> {
    if (!existsSync(repo)) return;
    const registered = (await this.listWorktrees(repo)).includes(realOrSelf(path));
    if (!registered) return;
    if (purge) {
      const r = await this.git(repo, ['worktree', 'remove', '--force', path]);
      if (r.code === 0) return;
    } else {
      // Keep the files (including uncommitted work) as a plain directory and
      // drop only git's registration; the orbit/<bot> branch keeps its commits.
      rmSync(join(path, '.git'), { force: true });
    }
    const r = await this.git(repo, ['worktree', 'prune']);
    if (r.code !== 0) {
      throw new OrbitError('internal', `git worktree prune failed in ${repo}: ${detail(r)}`);
    }
  }

  // -------------------------------------------------------------- docker

  private async inspectContainer(
    name: string,
  ): Promise<{ running: boolean; bot: string | null } | null> {
    const r = await this.run('docker', [
      'inspect',
      '--type',
      'container',
      '--format',
      `{{.State.Running}} {{index .Config.Labels "${BOT_LABEL}"}}`,
      name,
    ]);
    if (r.code !== 0) {
      if (/no such (object|container)/i.test(r.stderr)) return null;
      throw new OrbitError('driver_unavailable', `docker inspect ${name} failed: ${detail(r)}`);
    }
    const [running, label] = r.stdout.trim().split(' ');
    return {
      running: running === 'true',
      bot: label === undefined || label === '' || label === '<no value>' ? null : label,
    };
  }

  private assertOwned(bot: Bot, name: string, owner: string | null): void {
    if (owner !== bot.id) {
      throw new OrbitError(
        'invalid_config',
        `Container ${name} exists but belongs to ${owner === null ? 'no Orbit Bot' : `Bot ${owner}`}`,
        { hint: `Rename one of the Bots, or remove the container with \`docker rm -f ${name}\`.` },
      );
    }
  }

  /** `docker run` arguments for a Bot's container. Never contains secrets. */
  dockerRunArgs(bot: Bot, hostPath: string): string[] {
    const sb = bot.spec.sandbox;
    const args = [
      'run',
      '-d',
      '--name',
      SandboxManager.containerName(bot),
      '--label',
      `${BOT_LABEL}=${bot.id}`,
      '--cpus',
      String(sb.cpus),
      '--memory',
      `${sb.memoryMb}m`,
      '--pids-limit',
      String(sb.pidsLimit),
      '--network',
      sb.network === 'none' ? 'none' : 'bridge',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/tmp:rw,size=256m',
      ...(this.containerUser === null ? [] : ['--user', this.containerUser]),
      '--env',
      `HOME=${CONTAINER_HOME}`,
      '-v',
      `${hostPath}:${CONTAINER_WORKDIR}`,
      '-w',
      CONTAINER_WORKDIR,
    ];
    if (sb.repo !== undefined) args.push('-v', `${resolve(sb.repo)}:/repo:ro`);
    args.push(sb.image, 'sleep', 'infinity');
    return args;
  }

  private async prepareDocker(bot: Bot, path: string): Promise<Workspace> {
    const sb = bot.spec.sandbox;
    ensurePrivateDir(path);
    ensurePrivateDir(join(path, '.orbit-home'));
    const name = SandboxManager.containerName(bot);
    const state = await this.inspectContainer(name);
    if (state !== null) this.assertOwned(bot, name, state.bot);
    if (state === null) {
      const r = await this.run('docker', this.dockerRunArgs(bot, path), { timeoutMs: 300_000 });
      if (r.code !== 0) {
        throw new OrbitError('driver_unavailable', `docker run failed: ${detail(r)}`, {
          hint: `Build the sandbox image with \`docker build -f docker/sandbox.Dockerfile -t ${sb.image} .\` or set sandbox.image.`,
        });
      }
    } else if (!state.running) {
      const r = await this.run('docker', ['start', name]);
      if (r.code !== 0) {
        throw new OrbitError('driver_unavailable', `docker start ${name} failed: ${detail(r)}`);
      }
    }
    return {
      botId: bot.id,
      kind: 'docker',
      path,
      isolation: 'container',
      // The API key in the engine's environment is readable from inside the
      // container (/proc/<pid>/environ) until the key proxy lands (M8): Bash
      // therefore stays EXTERNAL here too (M2 review M3).
      shellContained: false,
      engineSandboxSettings: null,
      docker: { container: name, workdir: CONTAINER_WORKDIR },
    };
  }

  private async removeContainer(bot: Bot): Promise<void> {
    const support = await this.support();
    if (!support.docker.available) {
      throw new OrbitError(
        'driver_unavailable',
        `Docker is not available, cannot remove the container of Bot "${bot.spec.name}"`,
        { hint: support.docker.error ?? 'Start the Docker daemon and retry.' },
      );
    }
    const name = SandboxManager.containerName(bot);
    const state = await this.inspectContainer(name);
    if (state === null) return;
    this.assertOwned(bot, name, state.bot);
    const r = await this.run('docker', ['rm', '-f', name], { timeoutMs: 120_000 });
    if (r.code !== 0 && !/no such container/i.test(r.stderr)) {
      throw new OrbitError('driver_unavailable', `docker rm ${name} failed: ${detail(r)}`);
    }
  }
}
