import { readFileSync } from 'node:fs';
import type { Approval } from '@orbit/sdk-client';
import { OrbitError } from '@orbit/core';
import type { Context } from '../context';
import { painter } from '../io';
import { formatRelative, renderDiff, scrubControls } from '../render';
import { follow } from './run';

type Paint = ReturnType<typeof painter>;

/** Model-derived text on one line: controls neutralised, newlines shown as ⏎. */
export function clean(text: string): string {
  return scrubControls(text.replace(/\t/g, ' ')).replace(/\n/g, ' \u23ce ');
}

function card(a: Approval, p: Paint): string[] {
  const c = a.card;
  const tierColor = c.tier === 'EXTERNAL' ? 'yellow' : c.tier === 'FINANCIAL' ? 'red' : 'cyan';
  const lines = [
    `${p('bold', a.id)}  ${p(tierColor, c.tier)}  ${p('dim', `${a.status} · ${formatRelative(a.createdAt)}`)}`,
    `  ${p('bold', 'What')}   ${clean(c.what)}`,
    `  ${p('bold', 'Why')}    ${clean(c.why)}`,
    `  ${p('bold', 'Bot')}    ${c.botName} ${p('dim', `(run ${c.runId})`)}`,
    `  ${p('bold', 'Risk')}   ${c.risk}`,
  ];
  if (c.untrusted.length)
    lines.push(`  ${p('red', '⚠ Untrusted input:')} ${c.untrusted.join(', ')}`);
  if (c.diff) {
    lines.push(`  ${p('bold', 'Change')}`);
    lines.push(...renderDiff(c.diff, p).map((l) => `    ${l}`));
  } else {
    lines.push(`  ${p('bold', 'Payload')}`);
    lines.push(
      ...JSON.stringify(c.payload, null, 2)
        .split('\n')
        .map((l) => `    ${l}`),
    );
  }
  return lines;
}

export async function approvalsList(
  ctx: Context,
  o: { all?: boolean; json?: boolean },
): Promise<number> {
  const client = await ctx.client();
  const list = await client.approvals.list(o.all ? { all: 'true' } : {});
  if (o.json) {
    ctx.io.out(JSON.stringify(list, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  if (list.length === 0) {
    ctx.io.out(o.all ? 'No approvals yet.' : `${p('green', '✔')} Nothing needs you right now.`);
    return 0;
  }
  for (const a of list) {
    ctx.io.out(card(a, p).join('\n'));
    ctx.io.out('');
  }
  if (!o.all) {
    ctx.io.out(
      p(
        'dim',
        'orbit approve <id> [--edit <json|@file>] [--always [--global] [--expires 7d]]  ·  orbit deny <id> --reason "…"',
      ),
    );
  }
  return 0;
}

export async function approvalShow(
  ctx: Context,
  id: string,
  o: { json?: boolean },
): Promise<number> {
  const a = await (await ctx.client()).approvals.get(id);
  if (o.json) ctx.io.out(JSON.stringify(a, null, 2));
  else ctx.io.out(card(a, painter(ctx.io)).join('\n'));
  return 0;
}

/** Default lifetime of standing allow rules (review M7): explicit `never` to opt out. */
export const DEFAULT_RULE_EXPIRY = '7d';

/** "7d", "12h", "30m" → ISO timestamp from now; "never" → null. */
export function parseExpiry(value: string, now = new Date()): string | null {
  if (value.trim().toLowerCase() === 'never') return null;
  const m = /^(\d+)([mhdw])$/.exec(value.trim());
  if (!m)
    throw new OrbitError(
      'invalid_input',
      `Invalid duration "${value}" (use e.g. 30m, 12h, 7d, 2w)`,
    );
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
    m[2] as 'm' | 'h' | 'd' | 'w'
  ];
  return new Date(now.getTime() + Number(m[1]) * unit).toISOString();
}

function parseEdit(value: string): Record<string, unknown> {
  const text = value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value;
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OrbitError('invalid_input', '--edit must be a JSON object (the full tool input)');
  }
  return parsed as Record<string, unknown>;
}

type DecisionResult = Awaited<
  ReturnType<Awaited<ReturnType<Context['client']>>['approvals']['approve']>
>;

/** After a decision: follow the resumed Run, or say what it still waits on. */
async function afterDecision(
  ctx: Context,
  result: DecisionResult,
  o: { resume?: boolean; json?: boolean },
): Promise<number> {
  const p = painter(ctx.io);
  const { approval: a, run, resumed } = result;
  if (resumed && run) {
    if (!o.json) ctx.io.out(p('bold', `▶ resuming ${a.runId}`));
    return follow(ctx, await ctx.client(), a.runId, run.lastEventId, o);
  }
  if (!o.json && run && run.pendingApprovals.length > 0) {
    ctx.io.out(p('dim', `Run ${a.runId} still waits on ${run.pendingApprovals.join(', ')}.`));
  } else if (!o.json && run?.status === 'waiting_approval') {
    ctx.io.out(`Resume later with ${p('bold', `orbit resume ${a.runId}`)}.`);
  }
  return 0;
}

export async function approve(
  ctx: Context,
  id: string,
  o: {
    edit?: string;
    always?: boolean;
    global?: boolean;
    expires?: string;
    resume?: boolean;
    json?: boolean;
    fixture?: string;
  },
): Promise<number> {
  const client = await ctx.client();
  const result = await client.approvals.approve(id, {
    editedInput: o.edit ? parseEdit(o.edit) : null,
    always: o.always
      ? {
          scope: o.global ? 'global' : 'bot',
          expiresAt: parseExpiry(o.expires ?? DEFAULT_RULE_EXPIRY),
        }
      : null,
    ...(o.resume === false ? { resume: false } : {}),
    ...(o.fixture ? { fixture: o.fixture } : {}),
  });
  const a = result.approval;
  if (o.json) ctx.io.out(JSON.stringify(a));
  else
    ctx.io.out(
      `${painter(ctx.io)('green', '✔')} Approved ${a.card.what}${a.decision?.editedInput ? ' (edited)' : ''}`,
    );
  return afterDecision(ctx, result, o);
}

export async function deny(
  ctx: Context,
  id: string,
  o: { reason?: string; resume?: boolean; json?: boolean; fixture?: string },
): Promise<number> {
  const client = await ctx.client();
  const result = await client.approvals.deny(id, {
    reason: o.reason ?? null,
    ...(o.resume === false ? { resume: false } : {}),
    ...(o.fixture ? { fixture: o.fixture } : {}),
  });
  const a = result.approval;
  if (o.json) ctx.io.out(JSON.stringify(a));
  else
    ctx.io.out(
      `${painter(ctx.io)('red', '✘')} Denied ${a.card.what}${o.reason ? ` — ${o.reason}` : ''}`,
    );
  return afterDecision(ctx, result, o);
}
