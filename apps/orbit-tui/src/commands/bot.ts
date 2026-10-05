import { readFileSync } from 'node:fs';
import { BOT_TEMPLATES, type BotSpecInput, OrbitError, botTemplate } from '@orbit/core';
import { parse as parseYaml } from 'yaml';
import type { Context } from '../context';
import { painter } from '../io';
import { scrubControls } from '../render';

export interface BotCreateOptions {
  file?: string;
  /** Start from a template (`orbit templates`); other flags override it. */
  template?: string;
  /** Comma-separated plugin ids the Bot may use. */
  plugins?: string;
  name?: string;
  goal?: string;
  instructions?: string;
  model?: string;
  tools?: string;
  maxTurns?: string;
  fixture?: string;
  /** Scheduled trigger: cron expression (5 fields). */
  cron?: string;
  /** Scheduled trigger: every N minutes. */
  every?: string;
  json?: boolean;
}

export function botSpecFromOptions(o: BotCreateOptions): BotSpecInput {
  let spec: Partial<BotSpecInput> = {};
  if (o.template) {
    const t = botTemplate(o.template);
    if (!t) {
      throw new OrbitError('invalid_input', `No template "${o.template}"`, {
        hint: `Templates: ${BOT_TEMPLATES.map((x) => x.id).join(', ')} (orbit templates)`,
      });
    }
    spec = structuredClone(t.spec);
  }
  if (o.file) {
    const text = readFileSync(o.file, 'utf8');
    spec = (o.file.endsWith('.json') ? JSON.parse(text) : parseYaml(text)) as Partial<BotSpecInput>;
  }
  if (o.name) spec.name = o.name;
  if (o.goal) spec.goal = o.goal;
  if (o.instructions) spec.instructions = o.instructions;
  if (o.model) spec.model = o.model;
  if (o.tools)
    spec.tools = o.tools
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  if (o.maxTurns) spec.maxTurns = Number(o.maxTurns);
  if (o.fixture) spec.mock = { fixture: o.fixture };
  if (o.plugins)
    spec.plugins = o.plugins
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  const triggers = [...(spec.triggers ?? [])];
  if (o.cron) triggers.push({ kind: 'cron', cron: o.cron });
  if (o.every) {
    const minutes = Number(o.every);
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new OrbitError('invalid_input', '--every takes a whole number of minutes (≥ 1)');
    }
    triggers.push({ kind: 'interval', everyMinutes: minutes });
  }
  if (triggers.length) spec.triggers = triggers;
  if (!spec.name || !spec.goal) {
    throw new OrbitError('invalid_input', 'A bot needs a name and a goal', {
      hint: 'orbit bot create --name "Inbox Triage" --goal "Triage my inbox and draft replies"',
    });
  }
  return spec as BotSpecInput;
}

export async function botCreate(ctx: Context, o: BotCreateOptions): Promise<number> {
  const bot = await (await ctx.client()).bots.create(botSpecFromOptions(o));
  if (o.json) ctx.io.out(JSON.stringify(bot, null, 2));
  else {
    const p = painter(ctx.io);
    ctx.io.out(`${p('green', '✔')} Created bot ${scrubControls(bot.spec.name)} (${bot.id})`);
    const t = o.template ? botTemplate(o.template) : undefined;
    for (const step of t?.setup ?? []) ctx.io.out(p('dim', `  Next: ${step}`));
  }
  return 0;
}

export async function botList(ctx: Context, o: { json?: boolean }): Promise<number> {
  const bots = await (await ctx.client()).bots.list();
  if (o.json) {
    ctx.io.out(JSON.stringify(bots, null, 2));
    return 0;
  }
  const p = painter(ctx.io);
  if (bots.length === 0) {
    ctx.io.out(
      `No bots yet. Create one with ${p('bold', 'orbit bot create --name <name> --goal <goal>')}`,
    );
    return 0;
  }
  for (const b of bots) {
    const flags = [
      b.pausedAt ? p('yellow', 'paused') : '',
      b.spec.triggers.length ? p('dim', `${b.spec.triggers.length} trigger(s)`) : '',
    ].filter(Boolean);
    ctx.io.out(
      `${p('bold', scrubControls(b.spec.name).padEnd(24))} ${p('dim', `v${b.version}`)}  ${scrubControls(b.spec.goal)}${flags.length ? `  ${flags.join(' ')}` : ''}`,
    );
  }
  return 0;
}
