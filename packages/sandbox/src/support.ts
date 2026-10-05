import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { errorMessage } from '@orbit/core';
import type { CommandRunner, SandboxSupport } from './types';

/** macOS ships Seatbelt's front end here; Claude Code's sandbox requires it. */
export const DARWIN_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Tools Claude Code's Linux sandbox needs on PATH. */
export const LINUX_SANDBOX_TOOLS: readonly string[] = ['bwrap', 'socat'];

/** An executable regular file (sandbox tool probes). */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  /** PATH to search for sandbox tools; defaults to the daemon's PATH. */
  pathEnv?: string;
  /** Executable-file probe (injected by tests). */
  exists?: (path: string) => boolean;
}

/** What isolation this host can offer. Never throws. */
export async function detectSandboxSupport(
  run: CommandRunner,
  opts: DetectOptions = {},
): Promise<SandboxSupport> {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? isExecutableFile;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';

  let missing: string[];
  if (platform === 'linux') {
    const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0);
    missing = LINUX_SANDBOX_TOOLS.filter((tool) => !dirs.some((d) => exists(join(d, tool))));
  } else if (platform === 'darwin') {
    missing = exists(DARWIN_SANDBOX_EXEC) ? [] : ['sandbox-exec'];
  } else {
    missing = [`native sandbox is not supported on ${platform}`];
  }

  return {
    docker: await detectDocker(run),
    engineSandbox: { available: missing.length === 0, missing, platform },
  };
}

async function detectDocker(run: CommandRunner): Promise<SandboxSupport['docker']> {
  try {
    const r = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 15_000,
    });
    const version = r.stdout.trim();
    if (r.code === 0 && version.length > 0) return { available: true, version, error: null };
    const detail = r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`;
    return { available: false, version: null, error: `Docker daemon not reachable: ${detail}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      available: false,
      version: null,
      error: code === 'ENOENT' ? 'docker CLI not found on PATH' : errorMessage(err),
    };
  }
}
