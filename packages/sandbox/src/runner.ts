import { spawn } from 'node:child_process';
import type { CommandRunner } from './types';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * A CommandRunner backed by `child_process.spawn` (no shell).
 *
 * @param env the complete base environment for every command. The caller
 *   builds it with `buildChildEnv('tool', process.env)` from @orbit/runtime
 *   (ADR-005); it is never merged with process.env here. Per-call `opts.env`
 *   is merged over it.
 */
export function defaultRunner(env: Record<string, string>): CommandRunner {
  return (file, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd: opts.cwd,
        env: { ...env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let settled = false;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => {
          reject(new Error(`${file} timed out after ${timeoutMs} ms`));
        });
      }, timeoutMs);
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_OUTPUT_BYTES) into.push(chunk);
      };
      child.stdout.on('data', collect(out));
      child.stderr.on('data', collect(err));
      child.on('error', (e) => {
        finish(() => {
          reject(e);
        });
      });
      child.on('close', (code, signal) => {
        finish(() => {
          resolve({
            code: code ?? (signal === null ? 1 : 128),
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8'),
          });
        });
      });
    });
}
