import type { Readable, Writable } from 'node:stream';

/**
 * How strongly a Bot's shell is isolated from the host.
 * - none:           no OS-level isolation; Orbit's policy engine is the only guard.
 * - engine-sandbox: Claude Code's native sandbox (bubblewrap / Seatbelt).
 * - container:      a Docker container per Bot (API-key mode only, ADR-004).
 */
export type IsolationLevel = 'none' | 'engine-sandbox' | 'container';

export interface Workspace {
  botId: string;
  kind: 'directory' | 'worktree' | 'docker';
  /** Host path of the Bot's workspace directory (always exists after prepare). */
  path: string;
  isolation: IsolationLevel;
  /**
   * True only when shell commands cannot touch the network or anything outside
   * the workspace — the policy engine then treats Bash as WRITE_LOCAL instead
   * of EXTERNAL.
   */
  shellContained: boolean;
  /** Claude Code `sandbox` settings for the engine (native sandbox), or null. */
  engineSandboxSettings: Record<string, unknown> | null;
  /** Docker only: how the engine is run inside the container. */
  docker: { container: string; workdir: string } | null;
}

export interface SandboxSupport {
  docker: { available: boolean; version: string | null; error: string | null };
  engineSandbox: { available: boolean; missing: string[]; platform: string };
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  /** Replaces (is merged over) the runner's base environment for this call. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Runs a host command. Resolves with the exit code on any exit (never rejects
 * on a non-zero exit); rejects only when the process cannot be spawned or
 * times out. Injected so tests can record calls without touching the host.
 */
export type CommandRunner = (
  file: string,
  args: string[],
  opts?: CommandOptions,
) => Promise<CommandResult>;

/**
 * Structural copies of the Agent SDK's `SpawnOptions` / `SpawnedProcess`
 * (`@anthropic-ai/claude-agent-sdk`, `spawnClaudeCodeProcess`). The SDK is a
 * dependency of @orbit/runtime, not of this package, so the types are mirrored
 * here; TypeScript checks compatibility structurally where the runtime passes
 * `SandboxManager.engineSpawner()` to the SDK.
 */
export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export interface SpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}
