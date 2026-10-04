import { ExitCode, type RunEvent, type RunState, OrbitError } from '@orbit/core';
import type { Orchestrator } from '@orbit/runtime';
import type { Context } from '../context';
import { painter } from '../io';
import { renderEvent, renderRunRow } from '../render';
import { doctorExitCode } from './doctor';

export function exitCodeForRun(run: RunState): number {
  switch (run.status) {
    case 'completed':
      return ExitCode.ok;
    case 'waiting_approval':
      return ExitCode.waitingApproval;
    case 'rate_limited':
      return ExitCode.rateLimited;
    case 'cancelled':
      return ExitCode.cancelled;
    default:
      return ExitCode.runFailed;
  }
}

/**
 * Resolve auth, start the engine and run `fn` with a live orchestrator,
 * streaming events to the terminal (or NDJSON). Ctrl-C stops the Run.
 */
export async function withEngine(
  ctx: Context,
  o: { json?: boolean },
  fn: (
    orchestrator: Orchestrator,
    opts: { signal: AbortSignal; onEvent: (e: RunEvent) => void },
  ) => Promise<RunState>,
): Promise<number> {
  const resolution = await ctx.resolveAuth();
  const p = painter(ctx.io);
  if (!resolution.driver) {
    const message =
      resolution.refusal?.message ?? resolution.onboarding?.reason ?? 'No driver available';
    if (o.json) {
      ctx.io.out(
        JSON.stringify({
          error: {
            code: resolution.refusal?.code ?? 'auth_required',
            message,
            onboarding: resolution.onboarding,
          },
        }),
      );
    } else {
      ctx.io.err(`${p('red', '✘')} ${message}`);
      resolution.onboarding?.steps.forEach((s, i) => ctx.io.err(`  ${i + 1}. ${s}`));
    }
    return doctorExitCode(resolution);
  }
  for (const w of resolution.warnings) if (!o.json) ctx.io.err(`${p('yellow', '⚠')} ${w.message}`);

  const handle = await ctx.createDriver(resolution);
  const controller = new AbortController();
  let interrupts = 0;
  const offInterrupt = ctx.io.onInterrupt(() => {
    interrupts += 1;
    if (interrupts === 1) {
      if (!o.json) ctx.io.err(p('yellow', '\nStopping run… (Ctrl-C again to force quit)'));
      controller.abort();
    } else {
      process.exit(ExitCode.cancelled);
    }
  });
  try {
    if (!o.json) ctx.io.out(p('dim', `· ${resolution.label}`));
    let cwd: string | null = null;
    const run = await fn(ctx.orchestrator(handle), {
      signal: controller.signal,
      onEvent: (e) => {
        if (o.json) {
          ctx.io.out(JSON.stringify(e));
          return;
        }
        if (e.type === 'run.started') cwd = e.data.cwd;
        const line = renderEvent(e, p, cwd);
        if (line !== null) ctx.io.out(line);
      },
    });
    if (!o.json) {
      if (run.status === 'waiting_approval') {
        ctx.io.out(`  Review with ${p('bold', 'orbit approvals')}; approving resumes the run.`);
      }
      ctx.io.out(p('dim', `  run ${run.runId} · replay with: orbit logs ${run.runId}`));
    }
    return exitCodeForRun(run);
  } finally {
    offInterrupt();
    await handle.close();
  }
}

export async function runBot(
  ctx: Context,
  botRef: string,
  o: { prompt?: string; fixture?: string; json?: boolean },
): Promise<number> {
  const bot = ctx.bots.get(botRef);
  if (!o.json) ctx.io.out(painter(ctx.io)('bold', `▶ ${bot.spec.name}`));
  return withEngine(ctx, o, (orchestrator, opts) =>
    orchestrator.run(bot, {
      ...(o.prompt ? { prompt: o.prompt } : {}),
      ...(o.fixture ? { mockFixture: o.fixture } : {}),
      ...opts,
    }),
  );
}

export async function resumeRun(
  ctx: Context,
  runId: string,
  o: { json?: boolean; fixture?: string },
): Promise<number> {
  const state = ctx.store.getRun(runId);
  if (!state) throw new OrbitError('not_found', `Run ${runId} not found`);
  if (!o.json) ctx.io.out(painter(ctx.io)('bold', `▶ resuming ${runId}`));
  return withEngine(ctx, o, (orchestrator, opts) =>
    orchestrator.resume(runId, { ...(o.fixture ? { mockFixture: o.fixture } : {}), ...opts }),
  );
}

export function runsList(
  ctx: Context,
  o: { bot?: string; json?: boolean; limit?: string },
): number {
  const botId = o.bot ? ctx.bots.get(o.bot).id : undefined;
  const runs = ctx.store.listRuns({
    ...(botId ? { botId } : {}),
    limit: o.limit ? Number(o.limit) : 20,
  });
  if (o.json) {
    ctx.io.out(JSON.stringify(runs, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  if (runs.length === 0) ctx.io.out('No runs yet.');
  for (const r of runs) ctx.io.out(renderRunRow(r, p));
  return 0;
}

/** Replay a Run from the immutable event log. */
export function logs(ctx: Context, runId: string, o: { json?: boolean }): number {
  const events = ctx.store.listRunEvents(runId);
  if (events.length === 0) throw new OrbitError('not_found', `Run ${runId} not found`);
  const p = painter(ctx.io);
  let cwd: string | null = null;
  for (const e of events) {
    if (o.json) {
      ctx.io.out(JSON.stringify(e));
      continue;
    }
    if (e.type === 'run.started') cwd = e.data.cwd;
    if (e.type === 'run.queued') ctx.io.out(`${p('bold', '▶')} ${p('dim', e.ts)} ${e.data.prompt}`);
    const line = renderEvent(e, p, cwd);
    if (line !== null) ctx.io.out(line);
  }
  return 0;
}
