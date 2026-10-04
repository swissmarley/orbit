import { classifyTool } from '@orbit/policy';
import type { Context } from '../context';
import { painter } from '../io';
import { parseExpiry } from './approvals';

export function rulesList(ctx: Context, o: { all?: boolean; json?: boolean }): number {
  const rules = ctx.rules.list({ includeInactive: o.all === true });
  if (o.json) {
    ctx.io.out(JSON.stringify(rules, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  if (rules.length === 0) ctx.io.out('No standing rules. Everything external asks first.');
  for (const r of rules) {
    const scope = r.botId ? (ctx.bots.find(r.botId)?.spec.name ?? r.botId) : 'all bots';
    const state = r.revokedAt
      ? p('dim', 'revoked')
      : r.expiresAt
        ? p('dim', `until ${r.expiresAt}`)
        : p('dim', 'no expiry');
    ctx.io.out(
      `${p('bold', r.id)}  ${p(r.effect === 'allow' ? 'green' : 'red', r.effect.padEnd(5))} ${r.toolPattern}  ${p('dim', scope)}  ${state}`,
    );
  }
  return 0;
}

export function rulesAdd(
  ctx: Context,
  o: {
    tool: string;
    effect: 'allow' | 'deny';
    bot?: string;
    expires?: string;
    reason?: string;
    json?: boolean;
  },
): number {
  const tier = classifyTool(o.tool, { shellContained: false })?.tier ?? null;
  const rule = ctx.rules.create(
    {
      botId: o.bot ? ctx.bots.get(o.bot).id : null,
      toolPattern: o.tool,
      effect: o.effect,
      reason: o.reason ?? null,
      createdBy: 'owner',
      expiresAt: o.expires ? parseExpiry(o.expires) : null,
    },
    tier,
  );
  ctx.audit.append({ actor: 'owner', action: 'rule.created', subject: rule.id, data: { ...rule } });
  if (o.json) ctx.io.out(JSON.stringify(rule));
  else
    ctx.io.out(
      `${painter(ctx.io)('green', '✔')} Rule ${rule.id}: ${rule.effect} ${rule.toolPattern}`,
    );
  return 0;
}

export function rulesRevoke(ctx: Context, id: string): number {
  const rule = ctx.rules.revoke(id);
  ctx.audit.append({ actor: 'owner', action: 'rule.revoked', subject: rule.id, data: {} });
  ctx.io.out(`Revoked ${rule.id}`);
  return 0;
}
