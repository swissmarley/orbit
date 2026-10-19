import {
  ExitCode,
  OrbitError,
  type RunEvent,
  type RunState,
  formatLocalTime,
  formatWhen,
  pauseNextStep,
} from '@orbit/core';
import type { OrbitClient } from '@orbit/sdk-client';
import type { Context } from '../context';
import { painter } from '../io';
import { renderEvent, renderRunRow, scrubControls } from '../render';

export function exitCodeForRun(run: RunState): number {
  switch (run.status) {
    case 'completed':
      return ExitCode.ok;
    // Parked: on your approval, or until the Bots it delegated to answer.
    case 'waiting_approval':
    case 'delegating':
      return ExitCode.waitingApproval;
    case 'rate_limited':
      return ExitCode.rateLimited;
    case 'paused':
      return ExitCode.paused;
    case 'cancelled':
      return ExitCode.cancelled;
    default:
      return ExitCode.runFailed;
  }
}

/** Events that end a driver segment: the CLI stops following there. */
const SEGMENT_END = new Set<RunEvent['type']>([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.parked',
  'run.paused',
  'run.rate_limited',
]);

/**
 * Stream a Run's events (from orbitd's SSE feed) until its current segment
 * ends, then report and map the outcome to an exit code. Ctrl-C asks orbitd
 * to stop the Run; a second Ctrl-C just detaches.
 */
export async function follow(
  ctx: Context,
  client: OrbitClient,
  runId: string,
  after: number,
  o: { json?: boolean },
): Promise<number> {
  const p = painter(ctx.io);
  const controller = new AbortController();
  let interrupts = 0;
  const offInterrupt = ctx.io.onInterrupt(() => {
    interrupts += 1;
    if (interrupts === 1) {
      if (!o.json) ctx.io.err(p('yellow', '\nStopping run… (Ctrl-C again to detach)'));
      void client.runs.stop(runId).catch(() => undefined);
    } else {
      controller.abort();
    }
  });
  let cwd: string | null = null;
  try {
    for await (const e of client.events({ run: runId, after, signal: controller.signal })) {
      if (o.json) ctx.io.out(JSON.stringify(e));
      else {
        if (e.type === 'run.started') cwd = e.data.cwd;
        const line = renderEvent(e, p, cwd);
        if (line !== null) ctx.io.out(line);
      }
      // A Run that parks only to wait for its delegations resumes by itself: keep following.
      const waitsOnPeers =
        e.type === 'run.parked' && e.data.approvalIds.length === 0 && e.data.delegations.length > 0;
      if (SEGMENT_END.has(e.type) && !waitsOnPeers) break;
    }
  } finally {
    offInterrupt();
  }
  const run = await client.runs.get(runId);
  if (!o.json) {
    if (controller.signal.aborted) {
      ctx.io.out(p('dim', `  detached; the run continues in orbitd · orbit logs ${runId}`));
      return ExitCode.ok;
    }
    if (run.status === 'waiting_approval') {
      ctx.io.out(`  Review with ${p('bold', 'orbit approvals')}; approving resumes the run.`);
    }
    if (run.status === 'paused' && run.pause) {
      ctx.io.out(
        `  ${pauseNextStep(run.pause)}${run.pause.autoResume ? '' : ` ${p('bold', `orbit resume ${runId}`)} · ${p('bold', `orbit stop ${runId}`)}`}`,
      );
    }
    if (run.status === 'rate_limited') {
      ctx.io.out(
        run.resumeAt
          ? `  It resumes by itself at ${p('bold', formatLocalTime(run.resumeAt))} (or: orbit resume ${runId}).`
          : `  Resume it later with ${p('bold', `orbit resume ${runId}`)}.`,
      );
    }
    ctx.io.out(p('dim', `  run ${run.runId} · replay with: orbit logs ${run.runId}`));
  }
  return exitCodeForRun(run);
}

export async function runBot(
  ctx: Context,
  botRef: string,
  o: { prompt?: string; continue?: string; fixture?: string; json?: boolean },
): Promise<number> {
  const client = await ctx.client();
  const bot = await client.bots.get(botRef);
  const p = painter(ctx.io);
  if (!o.json)
    ctx.io.out(p('bold', `▶ ${bot.spec.name}${o.continue ? ` · replying to ${o.continue}` : ''}`));
  const run = await client.runs.start(bot.id, {
    ...(o.prompt ? { prompt: o.prompt } : {}),
    ...(o.fixture ? { fixture: o.fixture } : {}),
    ...(o.continue ? { continues: o.continue } : {}),
  });
  // run.started shows the driver and auth method; `orbit doctor` explains them.
  return follow(ctx, client, run.runId, 0, o);
}

export async function resumeRun(
  ctx: Context,
  runId: string,
  o: { json?: boolean; fixture?: string },
): Promise<number> {
  const client = await ctx.client();
  if (!o.json) ctx.io.out(painter(ctx.io)('bold', `▶ resuming ${runId}`));
  const before = await client.runs.get(runId);
  await client.runs.resume(runId, o.fixture ? { fixture: o.fixture } : {});
  return follow(ctx, client, runId, before.lastEventId, o);
}

export async function runsList(
  ctx: Context,
  o: { bot?: string; json?: boolean; limit?: string },
): Promise<number> {
  const client = await ctx.client();
  const runs = await client.runs.list({
    ...(o.bot ? { bot: o.bot } : {}),
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
export async function logs(ctx: Context, runId: string, o: { json?: boolean }): Promise<number> {
  const client = await ctx.client();
  const events = await client.runs.events(runId);
  if (events.length === 0) throw new OrbitError('not_found', `Run ${runId} not found`);
  const p = painter(ctx.io);
  let cwd: string | null = null;
  for (const e of events) {
    if (o.json) {
      ctx.io.out(JSON.stringify(e));
      continue;
    }
    if (e.type === 'run.started') cwd = e.data.cwd;
    if (e.type === 'run.queued')
      ctx.io.out(`${p('bold', '▶')} ${p('dim', formatWhen(e.ts))} ${scrubControls(e.data.prompt)}`);
    const line = renderEvent(e, p, cwd);
    if (line !== null) ctx.io.out(line);
  }
  return 0;
}

export async function queueShow(ctx: Context, o: { json?: boolean }): Promise<number> {
  const client = await ctx.client();
  const q = await client.queue();
  if (o.json) {
    ctx.io.out(JSON.stringify(q, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  ctx.io.out(
    `${p('bold', 'Queue')}  ${q.active.length}/${q.limit} running · ${q.queued.length} waiting`,
  );
  if (q.pausedUntil) {
    ctx.io.out(
      p('yellow', `  ⏸ usage limit — new runs wait until ${formatLocalTime(q.pausedUntil)}`),
    );
  }
  for (const j of q.active) ctx.io.out(`  ${p('cyan', '▶')} ${j.runId} ${p('dim', j.kind)}`);
  for (const j of q.queued) {
    ctx.io.out(
      `  ${p('dim', '·')} ${j.runId} ${p('dim', `${j.kind} · priority ${j.priority}`)}${j.heldBy ? p('yellow', ` · ${j.heldBy}`) : ''}`,
    );
  }
  return 0;
}

export async function schedulesShow(
  ctx: Context,
  o: { bot?: string; json?: boolean },
): Promise<number> {
  const client = await ctx.client();
  const [entries, bots] = await Promise.all([client.schedules(o.bot), client.bots.list()]);
  if (o.json) {
    ctx.io.out(JSON.stringify(entries, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  if (entries.length === 0) {
    ctx.io.out('No scheduled triggers. Add one with `orbit bot create … --cron "0 9 * * 1-5"`.');
    return 0;
  }
  const names = new Map(bots.map((b) => [b.id, b.spec.name]));
  for (const e of entries) {
    ctx.io.out(
      `${p('bold', scrubControls(names.get(e.botId) ?? e.botId).padEnd(20))} ${scrubControls(e.description).padEnd(28)} ${
        e.nextAt
          ? `next ${formatLocalTime(e.nextAt)}`
          : p('dim', e.enabled ? 'not scheduled' : 'off')
      }${e.lastFiredAt ? p('dim', ` · last ${formatLocalTime(e.lastFiredAt)}`) : ''}`,
    );
  }
  return 0;
}

const RUN_END = new Set<RunEvent['type']>(['run.completed', 'run.failed', 'run.cancelled']);

/**
 * Follow a Run live, from its first event, across parks and usage-limit
 * pauses until it ends. Unlike `orbit run`, Ctrl-C only detaches: the Run
 * keeps going in orbitd.
 */
export async function tail(
  ctx: Context,
  runId: string,
  o: { json?: boolean; segment?: boolean },
): Promise<number> {
  const client = await ctx.client();
  const run = await client.runs.get(runId);
  const p = painter(ctx.io);
  const controller = new AbortController();
  const offInterrupt = ctx.io.onInterrupt(() => controller.abort());
  let cwd: string | null = null;
  const stopAt = o.segment ? SEGMENT_END : RUN_END;
  try {
    if (!o.json && RUN_END.has(lastType(run.status))) {
      ctx.io.out(p('dim', `run ${runId} already ended (${run.status}); showing its log`));
    }
    for await (const e of client.events({ run: runId, after: 0, signal: controller.signal })) {
      if (o.json) ctx.io.out(JSON.stringify(e));
      else {
        if (e.type === 'run.started') cwd = e.data.cwd;
        if (e.type === 'run.queued')
          ctx.io.out(
            `${p('bold', '▶')} ${p('dim', formatWhen(e.ts))} ${scrubControls(e.data.prompt)}`,
          );
        const line = renderEvent(e, p, cwd);
        if (line !== null) ctx.io.out(line);
      }
      if (stopAt.has(e.type)) break;
      // Already-ended Runs: stop after replaying the log.
      if (e.id >= run.lastEventId && RUN_END.has(lastType(run.status))) break;
    }
  } finally {
    offInterrupt();
  }
  if (controller.signal.aborted) {
    if (!o.json) ctx.io.out(p('dim', `  detached; run ${runId} continues in orbitd`));
    return ExitCode.ok;
  }
  return exitCodeForRun(await client.runs.get(runId));
}

/** The terminal event type a final status came from (for "already ended" checks). */
function lastType(status: RunState['status']): RunEvent['type'] {
  return status === 'completed'
    ? 'run.completed'
    : status === 'failed'
      ? 'run.failed'
      : status === 'cancelled'
        ? 'run.cancelled'
        : 'run.started';
}

/** `orbit bot logs <bot>`: replay the Bot's newest Run. */
export async function botLogs(
  ctx: Context,
  botRef: string,
  o: { json?: boolean },
): Promise<number> {
  const client = await ctx.client();
  const bot = await client.bots.get(botRef);
  const [latest] = await client.runs.list({ bot: bot.id, limit: 1 });
  if (!latest) throw new OrbitError('not_found', `Bot ${bot.spec.name} has no runs yet`);
  return logs(ctx, latest.runId, o);
}
