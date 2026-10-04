import { ExitCode } from '@orbit/core';
import { daemonFiles } from '@orbit/sdk-client';
import type { Context } from '../context';
import { runningDaemon, waitForDaemonExit } from '../daemon-control';
import { painter } from '../io';

export async function daemonStatus(ctx: Context, o: { json?: boolean }): Promise<number> {
  const client = await runningDaemon(ctx.home);
  if (!client) {
    if (o.json) ctx.io.out(JSON.stringify({ running: false }));
    else ctx.io.out(`orbitd is not running (home ${ctx.home}). Start it with: orbit daemon start`);
    return ExitCode.error;
  }
  const [health, queue] = await Promise.all([client.health(), client.queue()]);
  if (o.json) {
    ctx.io.out(JSON.stringify({ running: true, url: client.baseUrl, ...health, queue }, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  ctx.io.out(
    `${p('green', '●')} orbitd ${health.version} on ${client.baseUrl} · pid ${health.pid} · up since ${health.startedAt}`,
  );
  ctx.io.out(
    `  ${queue.active.length}/${queue.limit} running · ${queue.queued.length} queued${queue.pausedUntil ? p('yellow', ` · usage limit until ${queue.pausedUntil}`) : ''}`,
  );
  ctx.io.out(p('dim', `  log: ${daemonFiles(ctx.home).log}`));
  return 0;
}

export async function daemonStart(ctx: Context, o: { json?: boolean }): Promise<number> {
  await ctx.client(); // starts it when needed
  return daemonStatus(ctx, o);
}

export async function daemonStop(ctx: Context, o: { json?: boolean }): Promise<number> {
  const client = await runningDaemon(ctx.home);
  if (!client) {
    if (o.json) ctx.io.out(JSON.stringify({ stopped: false, running: false }));
    else ctx.io.out('orbitd is not running.');
    return 0;
  }
  await client.stopDaemon();
  await waitForDaemonExit(ctx.home);
  if (o.json) ctx.io.out(JSON.stringify({ stopped: true }));
  else
    ctx.io.out(
      `${painter(ctx.io)('yellow', '■')} orbitd stopped (executing runs end as interrupted).`,
    );
  return 0;
}
