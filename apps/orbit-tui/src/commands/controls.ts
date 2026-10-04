import type { Context } from '../context';
import { painter } from '../io';

export function stopRun(ctx: Context, runId: string, o: { json?: boolean }): number {
  ctx.orchestrator().stop(runId, 'owner');
  if (o.json) ctx.io.out(JSON.stringify({ runId, stopRequested: true }));
  else ctx.io.out(`${painter(ctx.io)('yellow', '■')} Stop requested for ${runId}`);
  return 0;
}

export function pauseBot(
  ctx: Context,
  botRef: string,
  paused: boolean,
  o: { json?: boolean },
): number {
  const o2 = ctx.orchestrator();
  const bot = paused ? o2.pauseBot(botRef, 'owner') : o2.resumeBot(botRef, 'owner');
  if (o.json)
    ctx.io.out(JSON.stringify({ id: bot.id, name: bot.spec.name, pausedAt: bot.pausedAt }));
  else ctx.io.out(`${paused ? '⏸ Paused' : '▶ Resumed'} ${bot.spec.name}`);
  return 0;
}

export function killSwitch(
  ctx: Context,
  o: { off?: boolean; status?: boolean; json?: boolean },
): number {
  const p = painter(ctx.io);
  if (o.status) {
    const by = ctx.controls.globalKill();
    if (o.json) ctx.io.out(JSON.stringify({ engaged: by !== null, by }));
    else
      ctx.io.out(by ? p('red', `Kill switch ENGAGED (by ${by})`) : p('green', 'Kill switch off'));
    return 0;
  }
  ctx.orchestrator().killAll('owner', !o.off);
  if (o.json) ctx.io.out(JSON.stringify({ engaged: !o.off }));
  else
    ctx.io.out(
      o.off
        ? p('green', 'Kill switch released — Bots may run again.')
        : p('red', '■ Kill switch engaged — every Run stops and no new Runs start.'),
    );
  return 0;
}
