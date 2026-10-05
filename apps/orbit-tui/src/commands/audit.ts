import { writeFileSync } from 'node:fs';
import { ExitCode } from '@orbit/core';
import type { Context } from '../context';
import { painter } from '../io';
import { scrubControls } from '../render';

export async function auditList(
  ctx: Context,
  o: { action?: string; limit?: string; json?: boolean },
): Promise<number> {
  const records = await (
    await ctx.client()
  ).audit.list({
    ...(o.action ? { action: o.action } : {}),
    limit: o.limit ? Number(o.limit) : 50,
  });
  if (o.json) {
    ctx.io.out(JSON.stringify(records, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  if (records.length === 0) ctx.io.out('The audit log is empty.');
  for (const r of records) {
    ctx.io.out(
      `${p('dim', `#${r.seq} ${r.ts}`)} ${p('bold', scrubControls(r.action).padEnd(20))} ${scrubControls(r.actor).padEnd(16)} ${scrubControls(r.subject ?? '')}`,
    );
  }
  return 0;
}

export async function auditVerify(ctx: Context, o: { json?: boolean }): Promise<number> {
  const result = await (await ctx.client()).audit.verify();
  if (o.json) ctx.io.out(JSON.stringify(result));
  else {
    const p = painter(ctx.io);
    ctx.io.out(
      result.ok
        ? p('green', `✔ Audit chain intact (${result.count} records)`)
        : p('red', `✘ Audit chain broken at #${result.firstBadSeq}: ${result.reason}`),
    );
  }
  return result.ok ? ExitCode.ok : ExitCode.error;
}

export async function auditExport(ctx: Context, o: { out?: string }): Promise<number> {
  const text = await (await ctx.client()).audit.export();
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (o.out) {
    writeFileSync(o.out, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
    ctx.io.err(`Exported ${lines.length} audit records to ${o.out}`);
  } else {
    for (const l of lines) ctx.io.out(l);
  }
  return 0;
}
