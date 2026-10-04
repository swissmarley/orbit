import { execFile } from 'node:child_process';
import { constants, accessSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { OrbitConfig } from '@orbit/core';
import { type Env, buildChildEnv } from '../env';
import type { AuthProbes, CliStatus } from './resolver';

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findExecutable(name: string, pathEnv: string | undefined): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function run(file: string, args: string[], env: Record<string, string>, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      file,
      args,
      { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // `claude auth status` exits non-zero when logged out but still prints JSON.
        if (err && !stdout.trim().startsWith('{')) reject(new Error(stderr.trim() || err.message));
        else resolve({ stdout, stderr });
      },
    );
  });
}

export function parseVersion(stdout: string): string | null {
  return /(\d+\.\d+\.\d+[\w.-]*)/.exec(stdout)?.[1] ?? null;
}

/**
 * Real probes. `claude` is queried with the same scrubbed environment the
 * CliDriver will use, so the answer reflects the CLI's own login — never an
 * API key from Orbit's environment.
 */
export function systemProbes(config: OrbitConfig, env: Env, timeoutMs = 15_000): AuthProbes {
  const childEnv = buildChildEnv('cli-engine', env);
  return {
    findClaude() {
      if (config.claudePath) {
        return Promise.resolve(isExecutable(config.claudePath) ? config.claudePath : null);
      }
      return Promise.resolve(findExecutable('claude', env.PATH));
    },
    async cliStatus(path): Promise<CliStatus> {
      const [status, version] = await Promise.all([
        run(path, ['auth', 'status', '--json'], childEnv, timeoutMs),
        run(path, ['--version'], childEnv, timeoutMs).catch(() => ({ stdout: '', stderr: '' })),
      ]);
      const parsed = JSON.parse(status.stdout) as {
        loggedIn?: unknown;
        authMethod?: unknown;
        apiProvider?: unknown;
      };
      return {
        path,
        version: parseVersion(version.stdout),
        loggedIn: parsed.loggedIn === true,
        authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
        apiProvider: typeof parsed.apiProvider === 'string' ? parsed.apiProvider : null,
        error: null,
      };
    },
  };
}
