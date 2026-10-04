import { readFileSync } from 'node:fs';
import { OrbitError } from '@orbit/core';
import type { Approval } from '@orbit/policy';
import type { Context } from '../context';
import { painter } from '../io';
import { formatRelative, renderDiff } from '../render';
import { resumeRun } from './run';

type Paint = ReturnType<typeof painter>;

function card(a: Approval, p: Paint): string[] {
  const c = a.card;
  const tierColor = c.tier === 'EXTERNAL' ? 'yellow' : c.tier === 'FINANCIAL' ? 'red' : 'cyan';
  const lines = [
    `${p('bold', a.id)}  ${p(tierColor, c.tier)}  ${p('dim', `${a.status} · ${formatRelative(a.createdAt)}`)}`,
    `  ${p('bold', 'What')}   ${c.what}`,
    `  ${p('bold', 'Why')}    ${c.why}`,
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

export function approvalsList(ctx: Context, o: { all?: boolean; json?: boolean }): number {
  const list = ctx.approvals.list(o.all ? {} : { status: 'pending' });
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

export function approvalShow(ctx: Context, id: string, o: { json?: boolean }): number {
  const a = ctx.approvals.require(id);
  if (o.json) ctx.io.out(JSON.stringify(a, null, 2));
  else ctx.io.out(card(a, painter(ctx.io)).join('\n'));
  return 0;
}

/** "7d", "12h", "30m" → ISO timestamp from now. */
export function parseExpiry(value: string, now = new Date()): string {
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

async function afterDecision(
  ctx: Context,
  a: Approval,
  o: { resume?: boolean; json?: boolean; fixture?: string },
): Promise<number> {
  const p = painter(ctx.io);
  const run = ctx.store.getRun(a.runId);
  const bot = ctx.bots.find(a.botId);
  const ready = run?.status === 'waiting_approval' && run.pendingApprovals.length === 0;
  if (!ready) {
    if (!o.json && run && run.pendingApprovals.length > 0) {
      ctx.io.out(p('dim', `Run ${a.runId} still waits on ${run.pendingApprovals.join(', ')}.`));
    }
    return 0;
  }
  if (o.resume === false || bot?.spec.approvals.autoResume === false) {
    if (!o.json) ctx.io.out(`Resume later with ${p('bold', `orbit resume ${a.runId}`)}.`);
    return 0;
  }
  return resumeRun(ctx, a.runId, {
    ...(o.json ? { json: true } : {}),
    ...(o.fixture ? { fixture: o.fixture } : {}),
  });
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
  const a = ctx.approvals.decide(id, {
    approve: true,
    by: 'owner',
    editedInput: o.edit ? parseEdit(o.edit) : null,
    always: o.always
      ? { scope: o.global ? 'global' : 'bot', expiresAt: o.expires ? parseExpiry(o.expires) : null }
      : null,
  });
  if (o.json) ctx.io.out(JSON.stringify(a));
  else
    ctx.io.out(
      `${painter(ctx.io)('green', '✔')} Approved ${a.card.what}${a.decision?.editedInput ? ' (edited)' : ''}`,
    );
  return afterDecision(ctx, a, o);
}

export async function deny(
  ctx: Context,
  id: string,
  o: { reason?: string; resume?: boolean; json?: boolean; fixture?: string },
): Promise<number> {
  const a = ctx.approvals.decide(id, { approve: false, by: 'owner', reason: o.reason ?? null });
  if (o.json) ctx.io.out(JSON.stringify(a));
  else
    ctx.io.out(
      `${painter(ctx.io)('red', '✘')} Denied ${a.card.what}${o.reason ? ` — ${o.reason}` : ''}`,
    );
  return afterDecision(ctx, a, o);
}
