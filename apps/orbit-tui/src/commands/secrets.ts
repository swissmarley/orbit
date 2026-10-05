import { readFileSync } from 'node:fs';
import { OrbitError } from '@orbit/core';
import type { Context } from '../context';
import { painter } from '../io';

/** Values come from --value-file or stdin, never argv (shell history, `ps`). */
export async function secretSet(
  ctx: Context,
  name: string,
  o: { valueFile?: string; stdin?: () => string; json?: boolean },
): Promise<number> {
  const raw = o.valueFile
    ? readFileSync(o.valueFile, 'utf8')
    : (o.stdin ?? (() => readFileSync(0, 'utf8')))();
  const value = raw.replace(/\r?\n$/, '');
  if (!value)
    throw new OrbitError('invalid_input', 'Empty secret value', {
      hint: `printf %s "$VALUE" | orbit secret set ${name}`,
    });
  // Sent to the local daemon over loopback (token-authenticated); stored encrypted there.
  const stored = await (await ctx.client()).secrets.set(name, value);
  ctx.io.out(
    o.json
      ? JSON.stringify(stored)
      : `${painter(ctx.io)('green', '✔')} Stored secret ${name} (${stored.keySource} key)`,
  );
  return 0;
}

export async function secretList(ctx: Context, o: { json?: boolean }): Promise<number> {
  const list = await (await ctx.client()).secrets.list();
  if (o.json) ctx.io.out(JSON.stringify(list, null, 2));
  else if (list.length === 0) ctx.io.out('No secrets stored.');
  else
    for (const s of list)
      ctx.io.out(`${s.name.padEnd(32)} ${painter(ctx.io)('dim', `updated ${s.updatedAt}`)}`);
  return 0;
}

export async function secretRemove(
  ctx: Context,
  name: string,
  o: { json?: boolean } = {},
): Promise<number> {
  await (await ctx.client()).secrets.remove(name);
  ctx.io.out(o.json ? JSON.stringify({ name, removed: true }) : `Removed secret ${name}`);
  return 0;
}
