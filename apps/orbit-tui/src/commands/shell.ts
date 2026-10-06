import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname } from 'node:path';
import { OrbitError, errorMessage } from '@orbit/core';
import { buildChildEnv } from '@orbit/runtime';
import type { Context } from '../context';
import { painter } from '../io';
import { scrubControls } from '../render';

/** The owner's shell on this terminal; resolves with its exit code. */
export function spawnInteractiveShell(o: {
  shell: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(o.shell, [], { cwd: o.cwd, env: o.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      resolve(code ?? (signal ? 128 + constants.signals[signal] : 0)),
    );
  });
}

/**
 * The take-over shell's environment: the `tool` allowlist plus
 * ORBIT_TAKEOVER=1, GIT_CEILING_DIRECTORIES at the workspace's parent (git
 * never walks up out of it) and, for a worktree Bot, the GIT_DIR and
 * GIT_WORK_TREE orbitd named, so a git-aware prompt never follows a `.git`
 * (or a nested repository) the Bot wrote. Inherited GIT_DIR, GIT_WORK_TREE
 * and GIT_COMMON_DIR are dropped for a directory Bot.
 */
/**
 * GIT_DIR for a directory Bot's take-over: a path that can never exist (no
 * one can create anything under /dev/null), so git finds no repository at
 * all — not one the Bot nested in a subfolder (M8 safety re-review).
 */
export const NO_GIT_DIR = '/dev/null/orbit-no-repository';

export function takeoverShellEnv(
  source: Readonly<Record<string, string | undefined>>,
  t: { workspace: string; git: { dir: string; workTree: string } | null },
): Record<string, string> {
  const env = buildChildEnv('tool', source, {
    ORBIT_TAKEOVER: '1',
    GIT_CEILING_DIRECTORIES: dirname(t.workspace),
    ...(t.git ? { GIT_DIR: t.git.dir, GIT_WORK_TREE: t.git.workTree } : { GIT_DIR: NO_GIT_DIR }),
  });
  const drop = t.git ? ['GIT_COMMON_DIR'] : ['GIT_WORK_TREE', 'GIT_COMMON_DIR'];
  for (const k of drop) Reflect.deleteProperty(env, k);
  return env;
}

/**
 * `orbit shell <bot>` (ADR-016): orbitd holds the Bot (no Run of it starts)
 * and hands over its workspace; the owner's `$SHELL` runs there with the
 * `tool` env allowlist (no API key, no Orbit token) plus ORBIT_TAKEOVER=1.
 * Orbit's policy does not see what happens in this shell; that is why only
 * the local CLI may do it, never the browser. When the shell exits, the
 * take-over ends and the hold is released (unless the Bot was paused before).
 */
export async function shell(ctx: Context, botRef: string): Promise<number> {
  const client = await ctx.client();
  const p = painter(ctx.io);
  const t = await client.bots.takeover(botRef, process.pid);
  const name = scrubControls(t.botName);
  ctx.io.out(
    `${p('yellow', '⏸')} Holding ${p('bold', name)} while you work: none of its Runs start or resume until you exit this shell.`,
  );
  ctx.io.out(`  workspace ${t.workspace}`);
  // git in this shell never reads a repository the Bot could have written (ADR-016).
  ctx.io.out(
    t.git
      ? `  git       GIT_DIR=${t.git.dir} (Orbit's worktree entry; the workspace's .git is not used${t.git.restored ? '; a changed .git was put back' : ''})`
      : `  git       GIT_DIR=${NO_GIT_DIR}: git sees no repository here, not even one in a subfolder (unset GIT_DIR to use git yourself)`,
  );
  ctx.io.out(
    p(
      'dim',
      "  Orbit's policy does not see what you do here; files you change are yours (no taint).",
    ),
  );
  if (t.waiting.length > 0) {
    ctx.io.out(p('dim', `  waiting: ${t.waiting.join(', ')}`));
  }
  if (t.replacedStale !== null) {
    ctx.io.out(p('dim', `  ended a stale take-over (pid ${t.replacedStale} is gone)`));
  }
  // Ctrl-C belongs to the shell: the CLI must outlive it to end the take-over.
  const offInterrupt = ctx.io.onInterrupt(() => undefined);
  // An unset or empty SHELL falls back to /bin/sh.
  const userShell = ctx.io.env.SHELL?.trim() ?? '';
  let code: number;
  try {
    code = await (ctx.io.spawnShell ?? spawnInteractiveShell)({
      shell: userShell === '' ? '/bin/sh' : userShell,
      cwd: t.workspace,
      env: takeoverShellEnv(ctx.io.env, t),
    });
  } catch (err) {
    ctx.io.err(`${p('red', '✘')} Could not start your shell: ${errorMessage(err)}`);
    code = 1;
  } finally {
    offInterrupt();
  }
  try {
    const bot = await client.bots.endTakeover(t.botId);
    ctx.io.out(
      bot.pausedAt
        ? `${p('yellow', '⏸')} Take-over ended; ${name} stays paused (it was paused before). orbit bot resume to let it run.`
        : `${p('green', '▶')} Take-over ended; ${name} may run again.`,
    );
  } catch (err) {
    // Already ended elsewhere (`orbit bot resume`): say so, keep the shell's exit code.
    if (!(err instanceof OrbitError && err.code === 'not_found')) throw err;
    ctx.io.out(p('dim', `Take-over of ${name} was already ended (orbit bot resume).`));
  }
  return code;
}
