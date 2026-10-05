import { readFileSync } from 'node:fs';
import {
  MEMORY_SOURCE_WORD,
  type Memory,
  OrbitError,
  RUN_STATUS,
  type RunState,
  formatTokens,
  formatWhen,
  memoryTrust,
} from '@orbit/core';
import type { Context } from '../context';
import { painter } from '../io';
import { scrubControls } from '../render';

type Paint = ReturnType<typeof painter>;

const TONE: Record<string, Parameters<Paint>[0]> = {
  neutral: 'dim',
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  attention: 'magenta',
};

/** One memory as a list row: trust mark + word, kind, who wrote it, when, title. */
export function memoryRow(m: Memory, p: Paint): string {
  const trust = memoryTrust(m);
  return [
    p('dim', m.id),
    p(TONE[trust.tone] ?? 'white', `${trust.mark} ${trust.label}`.padEnd(11)),
    m.kind.padEnd(8),
    p('dim', MEMORY_SOURCE_WORD[m.source].padEnd(8)),
    p('dim', formatWhen(m.createdAt).padEnd(22)),
    `${m.pinned ? '📌 ' : ''}${scrubControls(m.title)}`,
  ].join(' ');
}

function readBody(o: { bodyFile?: string; stdin?: () => string }): string {
  return o.bodyFile
    ? readFileSync(o.bodyFile, 'utf8')
    : (o.stdin ?? (() => readFileSync(0, 'utf8')))();
}

export async function memoryList(
  ctx: Context,
  botRef: string | undefined,
  o: { search?: string; kind?: string; limit?: string; json?: boolean },
): Promise<number> {
  const client = await ctx.client();
  const list = await client.memory.list({
    ...(botRef ? { bot: botRef } : {}),
    ...(o.search ? { q: o.search } : {}),
    ...(o.kind ? { kind: o.kind as Memory['kind'] } : {}),
    limit: o.limit ? Number(o.limit) : 50,
  });
  if (o.json) {
    ctx.io.out(JSON.stringify(list, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  if (list.length === 0) {
    ctx.io.out(o.search ? 'No memories match.' : 'No memories yet.');
    return 0;
  }
  for (const m of list) ctx.io.out(memoryRow(m, p));
  return 0;
}

export async function memoryShow(ctx: Context, id: string, o: { json?: boolean }): Promise<number> {
  const m = await (await ctx.client()).memory.get(id);
  if (o.json) {
    ctx.io.out(JSON.stringify(m, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  const trust = memoryTrust(m);
  ctx.io.out(p('bold', scrubControls(m.title)));
  ctx.io.out(
    p(
      'dim',
      `${m.id} · ${m.kind} · by ${MEMORY_SOURCE_WORD[m.source]} · ${formatWhen(m.createdAt)}${m.runId ? ` · run ${m.runId}` : ''}${m.editedAt ? ' · edited by you' : ''}`,
    ),
  );
  ctx.io.out(
    p(TONE[trust.tone] ?? 'white', `${trust.mark} ${trust.label}`) +
      (m.taint.length ? p('dim', ` — from ${scrubControls(m.taint.join(', '))}`) : ''),
  );
  ctx.io.out('');
  ctx.io.out(scrubControls(m.body));
  return 0;
}

export async function memoryAdd(
  ctx: Context,
  botRef: string,
  o: { title: string; bodyFile?: string; stdin?: () => string; pin?: boolean; json?: boolean },
): Promise<number> {
  const body = readBody(o).replace(/\r?\n$/, '');
  const m = await (
    await ctx.client()
  ).memory.create(botRef, { title: o.title, body, kind: 'fact', pinned: o.pin === true });
  ctx.io.out(o.json ? JSON.stringify(m) : `${painter(ctx.io)('green', '✔')} Saved ${m.id}`);
  return 0;
}

export async function memoryEdit(
  ctx: Context,
  id: string,
  o: {
    title?: string;
    body?: boolean;
    bodyFile?: string;
    stdin?: () => string;
    pin?: boolean;
    unpin?: boolean;
    trust?: boolean;
    json?: boolean;
  },
): Promise<number> {
  if (o.pin && o.unpin) throw new OrbitError('invalid_input', 'Use --pin or --unpin, not both');
  const patch = {
    ...(o.title ? { title: o.title } : {}),
    ...(o.body || o.bodyFile ? { body: readBody(o).replace(/\r?\n$/, '') } : {}),
    ...(o.pin ? { pinned: true } : o.unpin ? { pinned: false } : {}),
    ...(o.trust ? { trusted: true as const } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new OrbitError('invalid_input', 'Nothing to change', {
      hint: 'Pass --title, --body (reads stdin), --body-file, --pin/--unpin or --trust.',
    });
  }
  const m = await (await ctx.client()).memory.update(id, patch);
  ctx.io.out(o.json ? JSON.stringify(m) : `${painter(ctx.io)('green', '✔')} Updated ${m.id}`);
  return 0;
}

export async function memoryRm(ctx: Context, id: string, o: { json?: boolean }): Promise<number> {
  await (await ctx.client()).memory.remove(id);
  ctx.io.out(o.json ? JSON.stringify({ ok: true, id }) : `Deleted ${id}`);
  return 0;
}

export async function feedbackCmd(
  ctx: Context,
  runId: string,
  rating: string,
  o: { comment?: string; json?: boolean },
): Promise<number> {
  if (rating !== 'up' && rating !== 'down') {
    throw new OrbitError('invalid_input', 'Rating must be up or down');
  }
  const m = await (
    await ctx.client()
  ).runs.feedback(runId, { rating, ...(o.comment ? { comment: o.comment } : {}) });
  ctx.io.out(
    o.json
      ? JSON.stringify(m)
      : `${painter(ctx.io)('green', '✔')} Feedback saved (${m.id}); the Bot sees it in future Runs.`,
  );
  return 0;
}

/** The delegation tree as indented lines (parents before children). */
export function treeLines(
  runs: readonly RunState[],
  names: ReadonlyMap<string, string>,
  p: Paint,
): string[] {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const out: string[] = [];
  const walk = (r: RunState, prefix: string, last: boolean, top: boolean) => {
    const s = RUN_STATUS[r.status];
    const branch = top ? '' : `${prefix}${last ? '└─ ' : '├─ '}`;
    out.push(
      `${branch}${p(TONE[s.tone] ?? 'white', `${s.mark} ${s.label}`)} ${p('bold', scrubControls(names.get(r.botId) ?? r.botId))} ${p('dim', r.runId)}`,
    );
    const kids = r.children.flatMap((c) => byId.get(c.runId) ?? []);
    kids.forEach((k, i) =>
      walk(k, top ? '' : `${prefix}${last ? '   ' : '│  '}`, i === kids.length - 1, false),
    );
  };
  const root = runs[0];
  if (root) walk(root, '', true, true);
  return out;
}

export async function treeCmd(ctx: Context, runId: string, o: { json?: boolean }): Promise<number> {
  const client = await ctx.client();
  const tree = await client.runs.tree(runId);
  if (o.json) {
    ctx.io.out(JSON.stringify(tree, null, 2));
    return 0;
  }
  const names = new Map((await client.bots.list()).map((b) => [b.id, b.spec.name]));
  for (const line of treeLines(tree.runs, names, painter(ctx.io))) ctx.io.out(line);
  return 0;
}

export async function triageCmd(ctx: Context, o: { json?: boolean }): Promise<number> {
  const u = await (await ctx.client()).triage.usage();
  if (o.json) {
    ctx.io.out(JSON.stringify(u, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  ctx.io.out(
    `${p('bold', 'Triage calls today:')} ${u.callsToday} of ${u.limit} · ${formatTokens(u.inputTokensToday)} in / ${formatTokens(u.outputTokensToday)} out · ~$${u.costUsdToday.toFixed(4)}`,
  );
  ctx.io.out(
    p(
      'dim',
      'Post-run summaries (memory.summarize = triage) and Create Bot proposals use ORBIT_TRIAGE_MODEL. Limit: triage.maxCallsPerDay.',
    ),
  );
  for (const c of u.recent.slice(0, 10)) {
    ctx.io.out(
      `  ${p(c.status === 'ok' ? 'green' : 'red', c.status === 'ok' ? '✔' : '✘')} ${formatWhen(c.createdAt).padEnd(22)} ${c.purpose.padEnd(12)} ${c.model} · ${formatTokens(c.inputTokens)}/${formatTokens(c.outputTokens)}${c.error ? p('dim', ` · ${scrubControls(c.error)}`) : ''}`,
    );
  }
  return 0;
}
