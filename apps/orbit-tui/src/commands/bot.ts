import { readFileSync } from 'node:fs';
import { type BotSpecInput, OrbitError } from '@orbit/core';
import { parse as parseYaml } from 'yaml';
import type { Context } from '../context';
import { painter } from '../io';

export interface BotCreateOptions {
  file?: string;
  name?: string;
  goal?: string;
  instructions?: string;
  model?: string;
  tools?: string;
  maxTurns?: string;
  fixture?: string;
  json?: boolean;
}

export function botSpecFromOptions(o: BotCreateOptions): BotSpecInput {
  let spec: Partial<BotSpecInput> = {};
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
  if (!spec.name || !spec.goal) {
    throw new OrbitError('invalid_input', 'A bot needs a name and a goal', {
      hint: 'orbit bot create --name "Inbox Triage" --goal "Triage my inbox and draft replies"',
    });
  }
  return spec as BotSpecInput;
}

export function botCreate(ctx: Context, o: BotCreateOptions): number {
  const bot = ctx.bots.create(botSpecFromOptions(o));
  if (o.json) ctx.io.out(JSON.stringify(bot, null, 2));
  else ctx.io.out(`${painter(ctx.io)('green', '✔')} Created bot ${bot.spec.name} (${bot.id})`);
  return 0;
}

export function botList(ctx: Context, o: { json?: boolean }): number {
  const bots = ctx.bots.list();
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
    ctx.io.out(`${p('bold', b.spec.name.padEnd(24))} ${p('dim', `v${b.version}`)}  ${b.spec.goal}`);
  }
  return 0;
}
