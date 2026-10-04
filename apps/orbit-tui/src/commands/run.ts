import { ExitCode, type RunState, OrbitError } from '@orbit/core';
import { baselinePolicy } from '@orbit/policy';
import { Orchestrator } from '@orbit/runtime';
import type { Context } from '../context';
import { painter } from '../io';
import { renderEvent, renderRunRow } from '../render';
import { doctorExitCode } from './doctor';

export function exitCodeForRun(run: RunState): number {
  switch (run.status) {
    case 'completed':
      return ExitCode.ok;
    case 'rate_limited':
      return ExitCode.rateLimited;
    case 'cancelled':
      return ExitCode.cancelled;
    default:
      return ExitCode.runFailed;
  }
}

export async function runBot(
  ctx: Context,
  botRef: string,
  o: { prompt?: string; fixture?: string; json?: boolean },
): Promise<number> {
  const bot = ctx.bots.get(botRef);
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
    if (!o.json)
      ctx.io.out(`${p('bold', `▶ ${bot.spec.name}`)} ${p('dim', `· ${resolution.label}`)}`);
    const orchestrator = new Orchestrator({
      config: ctx.config,
      store: ctx.store,
      driver: handle.driver,
      permissionFor: (_bot, workspace) => baselinePolicy({ workspace, orbitHome: ctx.config.home }),
    });
    let cwd: string | null = null;
    const run = await orchestrator.run(bot, {
      ...(o.prompt ? { prompt: o.prompt } : {}),
      ...(o.fixture ? { mockFixture: o.fixture } : {}),
      signal: controller.signal,
      onEvent: (e) => {
        if (o.json) return ctx.io.out(JSON.stringify(e));
        if (e.type === 'run.started') cwd = e.data.cwd;
        const line = renderEvent(e, p, cwd);
        if (line !== null) ctx.io.out(line);
      },
    });
    if (!o.json) ctx.io.out(p('dim', `  run ${run.runId} · replay with: orbit logs ${run.runId}`));
    return exitCodeForRun(run);
  } finally {
    offInterrupt();
    await handle.close();
  }
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
