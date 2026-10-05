import { readFileSync, writeFileSync } from 'node:fs';
import { ExitCode, OrbitError, errorMessage, formatWhen } from '@orbit/core';
import type { OrbitClient } from '@orbit/sdk-client';
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
      `${p('dim', `#${r.seq} ${formatWhen(r.ts)}`)} ${p('bold', scrubControls(r.action).padEnd(20))} ${scrubControls(r.actor).padEnd(16)} ${scrubControls(r.subject ?? '')}`,
    );
  }
  return 0;
}

type Verify = Awaited<ReturnType<OrbitClient['audit']['verify']>>;
type Checkpoint = Parameters<OrbitClient['audit']['verifyCheckpoint']>[0];

/** "keyed since #12 (…); 11 older records unkeyed (up to #11)". */
function keyingText(r: Verify): string {
  const parts = [
    r.keyedSince
      ? `keyed since #${r.keyedSince.seq} (${formatWhen(r.keyedSince.ts)})`
      : 'not keyed',
  ];
  if (r.unkeyed > 0) {
    parts.push(
      `${r.unkeyed} older record${r.unkeyed === 1 ? '' : 's'} unkeyed (up to #${r.lastUnkeyedSeq ?? 0})`,
    );
  }
  return parts.join('; ');
}

/** The checkpoint file as JSON; orbitd validates its shape (zod) and its MAC. */
function readCheckpoint(file: string): Checkpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    throw new OrbitError(
      'invalid_input',
      `Cannot read the checkpoint ${file}: ${errorMessage(err)}`,
      {
        hint: 'Use the JSON file `orbit audit checkpoint --out <file>` wrote.',
      },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OrbitError('invalid_input', `${file} is not an Orbit audit checkpoint`, {
      hint: 'Use the JSON file `orbit audit checkpoint --out <file>` wrote.',
    });
  }
  return parsed as Checkpoint;
}

export async function auditVerify(
  ctx: Context,
  o: { json?: boolean; checkpoint?: string },
): Promise<number> {
  const p = painter(ctx.io);
  if (o.checkpoint) {
    const checkpoint = readCheckpoint(o.checkpoint);
    const res = await (await ctx.client()).audit.verifyCheckpoint(checkpoint);
    if (o.json) ctx.io.out(JSON.stringify(res));
    else {
      ctx.io.out(
        res.ok
          ? p(
              'green',
              `✔ Audit chain intact and still contains checkpoint #${checkpoint.seq} (${res.since} records since; ${keyingText(res.chain)})`,
            )
          : p('red', `✘ Checkpoint check failed: ${scrubControls(res.reason ?? 'unknown')}`),
      );
    }
    return res.ok ? ExitCode.ok : ExitCode.error;
  }
  const result = await (await ctx.client()).audit.verify();
  if (o.json) ctx.io.out(JSON.stringify(result));
  else {
    ctx.io.out(
      result.ok
        ? p('green', `✔ Audit chain intact (${result.count} records; ${keyingText(result)})`)
        : p('red', `✘ Audit chain broken at #${result.firstBadSeq}: ${result.reason}`),
    );
  }
  return result.ok ? ExitCode.ok : ExitCode.error;
}

export async function auditCheckpoint(
  ctx: Context,
  o: { out?: string; json?: boolean },
): Promise<number> {
  const cp = await (await ctx.client()).audit.checkpoint();
  const text = `${JSON.stringify(cp, null, 2)}\n`;
  if (o.out) writeFileSync(o.out, text, { mode: 0o600 });
  if (o.json) ctx.io.out(JSON.stringify(cp));
  else if (!o.out) ctx.io.out(text.trimEnd());
  ctx.io.err(
    `Checkpoint at #${cp.seq} (${cp.count} records, ${formatWhen(cp.ts)})${o.out ? ` written to ${o.out}` : ''}. Keep it outside ORBIT_HOME and check it later with \`orbit audit verify --checkpoint <file>\`.`,
  );
  return 0;
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
