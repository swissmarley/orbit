import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BOT_TEMPLATES,
  OrbitError,
  PLUGIN_STATE,
  type PluginStatus,
  TIER_WORD,
  TRIGGER_KIND_WORD,
  TRIGGER_STATE,
  type Tone,
} from '@orbit/core';
import type { Context } from '../context';
import { painter } from '../io';
import { clean } from './approvals';

type Paint = ReturnType<typeof painter>;
type Color = Parameters<Paint>[0];

/** The 16-colour terminal palette for the shared tones (always with a symbol or word). */
const TONE: Record<Tone, Color> = {
  neutral: 'dim',
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  attention: 'magenta',
};

const json = (ctx: Context, value: unknown) => ctx.io.out(JSON.stringify(value, null, 2));

/** Pad the plain words, then paint (escape codes must not count as width). */
function stateWord(p: Paint, s: PluginStatus['state'], width = 0): string {
  const w = PLUGIN_STATE[s];
  return p(TONE[w.tone], `${w.mark} ${w.label}`.padEnd(width));
}

const TIER_ORDER = ['READ', 'WRITE_LOCAL', 'EXTERNAL', 'FINANCIAL'] as const;

export async function pluginsList(ctx: Context, o: { json?: boolean }): Promise<number> {
  const list = await (await ctx.client()).plugins.list();
  if (o.json) {
    json(ctx, list);
    return 0;
  }
  const p = painter(ctx.io);
  if (list.length === 0) {
    ctx.io.out('No plugins known. Add one with `orbit plugin add <dir>`.');
    return 0;
  }
  for (const pl of list) {
    const used = pl.bots.length
      ? `used by ${pl.bots.map((b) => clean(b.name)).join(', ')}`
      : 'no Bot uses it';
    ctx.io.out(
      `${stateWord(p, pl.state, 14)} ${p('bold', clean(pl.id).padEnd(12))} ${clean(pl.name)}  ${p('dim', `${pl.tools.length} tools · ${used}`)}`,
    );
  }
  ctx.io.out(p('dim', '\nDetails: orbit plugin show <id>'));
  return 0;
}

export function renderPlugin(pl: PluginStatus, p: Paint): string[] {
  const lines = [
    `${p('bold', clean(pl.name))} ${p('dim', `(${clean(pl.id)} ${clean(pl.version)}${pl.builtIn ? ', ships with Orbit' : ''})`)}  ${stateWord(p, pl.state)}`,
    `  ${p('dim', PLUGIN_STATE[pl.state].meaning)}`,
  ];
  if (pl.description) lines.push(`  ${clean(pl.description)}`);
  lines.push(`  ${p('dim', 'server')} ${clean(pl.server)}`);
  lines.push('', p('bold', 'Tools'));
  const tools = [...pl.tools].sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.name.localeCompare(b.name),
  );
  const nameWidth = Math.max(0, ...tools.map((t) => t.name.length));
  for (const t of tools) {
    const w = TIER_WORD[t.tier];
    const avail = t.available === false ? p('red', ' (not offered by the server)') : '';
    lines.push(
      `  ${p(TONE[w.tone], `${w.mark} ${w.label}`.padEnd(14))} ${clean(t.name).padEnd(nameWidth)}${t.egress ? p('dim', ' · reaches any address') : ''}${avail}  ${p('dim', clean(t.description))}`,
    );
  }
  if (pl.secrets.length) {
    lines.push('', p('bold', 'Secrets') + p('dim', ' (only this plugin receives them)'));
    for (const s of pl.secrets) {
      lines.push(
        `  ${s.set ? p('green', '✔ set    ') : p(s.required ? 'magenta' : 'dim', s.required ? '◌ missing' : '○ not set')} ${clean(s.name)}  ${p('dim', clean(s.description))}`,
      );
    }
  }
  if (pl.settings.length) {
    lines.push('', p('bold', 'Settings'));
    for (const s of pl.settings) {
      const v = s.value ?? (s.default !== null ? `${s.default} (default)` : null);
      lines.push(
        `  ${clean(s.name)} = ${v === null ? p(s.required ? 'magenta' : 'dim', s.required ? '(required, not set)' : '(not set)') : clean(v)}  ${p('dim', clean(s.description))}`,
      );
    }
  }
  if (pl.env.length)
    lines.push(
      '',
      `${p('bold', 'Reads from orbitd’s environment')} ${pl.env.map(clean).join(', ')}`,
    );
  lines.push(
    '',
    `${p('bold', 'Bots')} ${pl.bots.length ? pl.bots.map((b) => clean(b.name)).join(', ') : p('dim', 'none list it yet (add its id to a Bot’s plugins)')}`,
  );
  if (pl.undeclaredTools.length) {
    lines.push(
      `${p('dim', 'Hidden (not in the manifest):')} ${pl.undeclaredTools.map(clean).join(', ')}`,
    );
  }
  for (const w of pl.warnings) lines.push(p('yellow', `⚠ ${clean(w)}`));
  if (pl.error) lines.push(p('red', `✘ ${clean(pl.error)}`));
  return lines;
}

export async function pluginShow(ctx: Context, id: string, o: { json?: boolean }): Promise<number> {
  const pl = await (await ctx.client()).plugins.get(id);
  if (o.json) json(ctx, pl);
  else for (const l of renderPlugin(pl, painter(ctx.io))) ctx.io.out(l);
  return 0;
}

async function pluginAction(
  ctx: Context,
  o: { json?: boolean },
  run: () => Promise<PluginStatus>,
  done: (pl: PluginStatus) => string,
): Promise<number> {
  const pl = await run();
  if (o.json) json(ctx, pl);
  else {
    const p = painter(ctx.io);
    ctx.io.out(`${stateWord(p, pl.state)} ${done(pl)}`);
    for (const w of pl.warnings) ctx.io.out(p('yellow', `⚠ ${clean(w)}`));
  }
  return 0;
}

export async function pluginEnable(ctx: Context, id: string, o: { json?: boolean }) {
  const c = await ctx.client();
  return pluginAction(
    ctx,
    o,
    () => c.plugins.enable(id),
    (pl) =>
      `${clean(pl.name)} is enabled: ${pl.tools.length} tools for the Bots that list "${pl.id}".`,
  );
}

export async function pluginDisable(ctx: Context, id: string, o: { json?: boolean }) {
  const c = await ctx.client();
  return pluginAction(
    ctx,
    o,
    () => c.plugins.disable(id),
    (pl) => `${clean(pl.name)} is off.`,
  );
}

export async function pluginCheck(ctx: Context, id: string, o: { json?: boolean }) {
  const c = await ctx.client();
  return pluginAction(
    ctx,
    o,
    () => c.plugins.check(id),
    (pl) =>
      pl.error
        ? `${clean(pl.name)} did not start.`
        : `${clean(pl.name)} started and listed its tools.`,
  );
}

export async function pluginAdd(ctx: Context, dir: string, o: { json?: boolean }) {
  const c = await ctx.client();
  return pluginAction(
    ctx,
    o,
    () => c.plugins.add(resolve(dir)),
    (pl) =>
      `Added ${clean(pl.name)} (${pl.id}). Review it with \`orbit plugin show ${pl.id}\`, then \`orbit plugin enable ${pl.id}\`.`,
  );
}

export async function pluginRemove(
  ctx: Context,
  id: string,
  o: { json?: boolean },
): Promise<number> {
  await (await ctx.client()).plugins.remove(id);
  ctx.io.out(
    o.json
      ? JSON.stringify({ id, removed: true }, null, 2)
      : `Removed plugin ${clean(id)} and its secrets`,
  );
  return 0;
}

/** Secret values come from --value-file or stdin, never argv (shell history, `ps`). */
export async function pluginSecret(
  ctx: Context,
  id: string,
  name: string,
  o: { valueFile?: string; remove?: boolean; stdin?: () => string; json?: boolean },
): Promise<number> {
  const c = await ctx.client();
  if (o.remove) {
    return pluginAction(
      ctx,
      o,
      () => c.plugins.removeSecret(id, name),
      () => `Removed ${name}.`,
    );
  }
  const raw = o.valueFile
    ? readFileSync(o.valueFile, 'utf8')
    : (o.stdin ?? (() => readFileSync(0, 'utf8')))();
  const value = raw.replace(/\r?\n$/, '');
  if (!value) {
    throw new OrbitError('invalid_input', 'Empty secret value', {
      hint: `orbit plugin secret ${id} ${name} --value-file <file>   (or pipe it on stdin)`,
    });
  }
  return pluginAction(
    ctx,
    o,
    () => c.plugins.setSecret(id, name, value),
    (pl) => `Stored ${name} for ${clean(pl.name)} (only this plugin receives it).`,
  );
}

export async function pluginSetting(
  ctx: Context,
  id: string,
  name: string,
  value: string | undefined,
  o: { clear?: boolean; json?: boolean },
): Promise<number> {
  if (value === undefined && !o.clear) {
    throw new OrbitError('invalid_input', 'Give a value, or --clear', {
      hint: `orbit plugin setting ${id} ${name} <value>`,
    });
  }
  const c = await ctx.client();
  return pluginAction(
    ctx,
    o,
    () => c.plugins.setSetting(id, name, o.clear ? null : (value ?? null)),
    (pl) =>
      `${o.clear ? `Cleared ${clean(name)}` : `${clean(name)} set`} for ${clean(pl.name)}.${pl.enabled ? '' : ` Turn it on with: orbit plugin enable ${clean(pl.id)}`}`,
  );
}

export async function triggersList(ctx: Context, o: { json?: boolean }): Promise<number> {
  const list = await (await ctx.client()).triggers.list();
  if (o.json) {
    json(ctx, list);
    return 0;
  }
  const p = painter(ctx.io);
  if (list.length === 0) {
    ctx.io.out(
      'No inbound triggers. Add a webhook, Slack, file or git trigger to a Bot (scheduled ones: orbit schedules).',
    );
    return 0;
  }
  for (const t of list) {
    const w = TRIGGER_STATE[t.state];
    ctx.io.out(
      `${p(TONE[w.tone], `${w.mark} ${w.label}`.padEnd(14))} ${p('bold', clean(t.botName))}  ${TRIGGER_KIND_WORD[t.kind].padEnd(8)} ${clean(t.description)}${t.path ? p('dim', `  POST ${clean(t.url ?? t.path)}`) : ''}${t.detail ? p('dim', `  (${clean(t.detail)})`) : ''}`,
    );
  }
  return 0;
}

export async function webhookSecret(
  ctx: Context,
  bot: string,
  trigger: string,
  o: { json?: boolean; rotate?: boolean },
): Promise<number> {
  const c = await ctx.client();
  // Rotating kills the old secret at once: only on purpose.
  const existing = (await c.triggers.list()).find(
    (t) =>
      t.kind === 'webhook' &&
      t.path?.endsWith(`/${trigger}`) &&
      (t.botId === bot || t.botName === bot || t.botName.toLowerCase() === bot.toLowerCase()),
  );
  if (existing && existing.state !== 'needs_setup' && !o.rotate) {
    throw new OrbitError('invalid_input', `${trigger} already has a signing secret`, {
      hint: `Add --rotate to replace it (the old one stops working at once).`,
    });
  }
  const s = await c.triggers.webhookSecret(bot, trigger);
  if (o.json) {
    json(ctx, s);
    return 0;
  }
  const p = painter(ctx.io);
  const base = c.baseUrl;
  ctx.io.out(
    `${p('green', '✔')} New signing secret for ${trigger} (shown once; Orbit keeps it in its vault):`,
  );
  ctx.io.out(`\n  ${s.secret}\n`);
  ctx.io.out(
    s.url !== null
      ? `POST ${s.url}   (hosted: reachable from other machines)`
      : `POST ${base}${s.path}   (loopback only; forward a tunnel to it if the sender is remote)`,
  );
  ctx.io.out(
    s.style === 'github'
      ? 'GitHub style: set it as the webhook secret; GitHub sends X-Hub-Signature-256 and X-GitHub-Delivery.'
      : 'Orbit style: send X-Orbit-Timestamp (unix seconds) and X-Orbit-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<body>") in hex.',
  );
  return 0;
}

export function templatesList(ctx: Context, o: { json?: boolean }): number {
  if (o.json) {
    json(ctx, BOT_TEMPLATES);
    return 0;
  }
  const p = painter(ctx.io);
  for (const t of BOT_TEMPLATES) {
    ctx.io.out(`${p('bold', t.id.padEnd(16))} ${t.title} — ${t.summary}`);
    for (const s of t.setup) ctx.io.out(`  ${p('dim', `· ${s}`)}`);
  }
  ctx.io.out(p('dim', '\nCreate one: orbit bot create --template <id>'));
  return 0;
}
