import { OrbitError } from '@orbit/core';
import type { Context } from '../context';
import { painter } from '../io';
import { scrubControls } from '../render';
import { DEFAULT_RULE_EXPIRY, parseExpiry } from './approvals';

export async function rulesList(
  ctx: Context,
  o: { all?: boolean; json?: boolean },
): Promise<number> {
  const client = await ctx.client();
  const rules = await client.rules.list(o.all === true);
  if (o.json) {
    ctx.io.out(JSON.stringify(rules, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  if (rules.length === 0) ctx.io.out('No standing rules. Everything external asks first.');
  const names = new Map((await client.bots.list()).map((b) => [b.id, b.spec.name]));
  for (const r of rules) {
    const scope = scrubControls(r.botId ? (names.get(r.botId) ?? r.botId) : 'all bots');
    const state = r.revokedAt
      ? p('dim', 'revoked')
      : r.expiresAt
        ? p('dim', `until ${r.expiresAt}`)
        : p('dim', 'no expiry');
    const when = r.inputMatch
      ? ` when ${Object.entries(r.inputMatch)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`
      : '';
    ctx.io.out(
      `${p('bold', r.id)}  ${p(r.effect === 'allow' ? 'green' : 'red', r.effect.padEnd(5))} ${scrubControls(r.toolPattern + when)}  ${p('dim', scope)}  ${state}`,
    );
  }
  return 0;
}

export async function rulesAdd(
  ctx: Context,
  o: {
    tool: string;
    effect: 'allow' | 'deny';
    bot?: string;
    expires?: string;
    reason?: string;
    /** `field=glob` (repeatable): top-level arguments that must match, one value per `*`. */
    match?: string[];
    json?: boolean;
  },
): Promise<number> {
  const inputMatch: Record<string, string> = {};
  for (const m of o.match ?? []) {
    const i = m.indexOf('=');
    if (i < 1) {
      throw new OrbitError('invalid_input', `--match takes field=glob, got "${m}"`, {
        hint: "orbit rules add --tool mcp__google__send_draft --effect allow --match 'to=*@example.com'",
      });
    }
    inputMatch[m.slice(0, i)] = m.slice(i + 1);
  }
  const rule = await (
    await ctx.client()
  ).rules.create({
    toolPattern: o.tool,
    effect: o.effect,
    inputMatch: Object.keys(inputMatch).length ? inputMatch : null,
    bot: o.bot ?? null,
    reason: o.reason ?? null,
    // Allow rules expire by default; deny rules last until revoked.
    expiresAt: parseExpiry(o.expires ?? (o.effect === 'allow' ? DEFAULT_RULE_EXPIRY : 'never')),
  });
  if (o.json) ctx.io.out(JSON.stringify(rule));
  else
    ctx.io.out(
      `${painter(ctx.io)('green', '✔')} Rule ${rule.id}: ${rule.effect} ${rule.toolPattern}${
        rule.inputMatch
          ? ` when ${Object.entries(rule.inputMatch)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}`
          : ''
      }`,
    );
  return 0;
}

export async function rulesRevoke(
  ctx: Context,
  id: string,
  o: { json?: boolean } = {},
): Promise<number> {
  const rule = await (await ctx.client()).rules.revoke(id);
  ctx.io.out(o.json ? JSON.stringify(rule) : `Revoked ${rule.id}`);
  return 0;
}
