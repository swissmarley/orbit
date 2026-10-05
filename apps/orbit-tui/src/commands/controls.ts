import type { Context } from '../context';
import { painter } from '../io';

export async function stopRun(ctx: Context, runId: string, o: { json?: boolean }): Promise<number> {
  const run = await (await ctx.client()).runs.stop(runId);
  if (o.json) ctx.io.out(JSON.stringify({ runId, stopRequested: true, status: run.status }));
  else ctx.io.out(`${painter(ctx.io)('yellow', '■')} Stop requested for ${runId}`);
  return 0;
}

/** Pause a running Run at its next tool call, or `--now` (ADR-016). */
export async function pauseRun(
  ctx: Context,
  runId: string,
  o: { now?: boolean; json?: boolean },
): Promise<number> {
  const run = await (await ctx.client()).runs.pause(runId, o.now ? { now: true } : {});
  const now = o.now === true;
  if (o.json) {
    ctx.io.out(JSON.stringify({ runId, pauseRequested: true, now, status: run.status }));
    return 0;
  }
  ctx.io.out(
    `${painter(ctx.io)('yellow', '⏸')} Pause requested for ${runId}: ${now ? 'the engine stops now (its last turn is cut off)' : 'it pauses at its next tool call (if it finishes first, the request lapses)'}. Resume it with orbit resume ${runId}.`,
  );
  return 0;
}

export async function pauseBot(
  ctx: Context,
  botRef: string,
  paused: boolean,
  o: { json?: boolean },
): Promise<number> {
  const client = await ctx.client();
  const bot = paused ? await client.bots.pause(botRef) : await client.bots.resume(botRef);
  if (o.json)
    ctx.io.out(JSON.stringify({ id: bot.id, name: bot.spec.name, pausedAt: bot.pausedAt }));
  else ctx.io.out(`${paused ? '⏸ Paused' : '▶ Resumed'} ${bot.spec.name}`);
  return 0;
}

export async function killSwitch(
  ctx: Context,
  o: { off?: boolean; status?: boolean; json?: boolean },
): Promise<number> {
  const p = painter(ctx.io);
  const client = await ctx.client();
  if (o.status) {
    const { engaged, by } = await client.kill.status();
    if (o.json) ctx.io.out(JSON.stringify({ engaged, by }));
    else
      ctx.io.out(
        engaged ? p('red', `Kill switch ENGAGED (by ${by})`) : p('green', 'Kill switch off'),
      );
    return 0;
  }
  await client.kill.set(!o.off);
  if (o.json) ctx.io.out(JSON.stringify({ engaged: !o.off }));
  else
    ctx.io.out(
      o.off
        ? p('green', 'Kill switch released — Bots may run again.')
        : p('red', '■ Kill switch engaged — every Run stops and no new Runs start.'),
    );
  return 0;
}
