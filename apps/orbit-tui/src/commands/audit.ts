import { writeFileSync } from 'node:fs';
import { ExitCode } from '@orbit/core';
import type { Context } from '../context';
import { painter } from '../io';

export function auditList(
  ctx: Context,
  o: { action?: string; limit?: string; json?: boolean },
): number {
  // Page through to the newest records (list() is oldest-first).
  const limit = o.limit ? Number(o.limit) : 50;
  let records: ReturnType<typeof ctx.audit.list> = [];
  let afterSeq = 0;
  for (;;) {
    const page = ctx.audit.list({
      ...(o.action ? { action: o.action } : {}),
      afterSeq,
      limit: 1000,
    });
    if (page.length === 0) break;
    records = [...records, ...page].slice(-limit);
    afterSeq = page.at(-1)?.seq ?? afterSeq;
  }
  if (o.json) {
    ctx.io.out(JSON.stringify(records, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  if (records.length === 0) ctx.io.out('The audit log is empty.');
  for (const r of records) {
    ctx.io.out(
      `${p('dim', `#${r.seq} ${r.ts}`)} ${p('bold', r.action.padEnd(20))} ${r.actor.padEnd(16)} ${r.subject ?? ''}`,
    );
  }
  return 0;
}

export function auditVerify(ctx: Context, o: { json?: boolean }): number {
  const result = ctx.audit.verify();
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

export function auditExport(ctx: Context, o: { out?: string }): number {
  const lines: string[] = [];
  const count = ctx.audit.exportJsonl((line) => lines.push(line));
  if (o.out) {
    writeFileSync(o.out, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
    ctx.io.err(`Exported ${count} audit records to ${o.out}`);
  } else {
    for (const l of lines) ctx.io.out(l);
  }
  return 0;
}
