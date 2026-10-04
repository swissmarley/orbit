import { readFileSync } from 'node:fs';
import { OrbitError } from '@orbit/core';
import type { Context } from '../context';
import { painter } from '../io';

/** Values come from --value-file or stdin, never argv (shell history, `ps`). */
export function secretSet(
  ctx: Context,
  name: string,
  o: { valueFile?: string; stdin?: () => string },
): number {
  const raw = o.valueFile
    ? readFileSync(o.valueFile, 'utf8')
    : (o.stdin ?? (() => readFileSync(0, 'utf8')))();
  const value = raw.replace(/\r?\n$/, '');
  if (!value)
    throw new OrbitError('invalid_input', 'Empty secret value', {
      hint: `printf %s "$VALUE" | orbit secret set ${name}`,
    });
  ctx.vault().set(name, value);
  ctx.audit.append({ actor: 'owner', action: 'secret.set', subject: name, data: {} });
  ctx.io.out(
    `${painter(ctx.io)('green', '✔')} Stored secret ${name} (${ctx.vault().keySource} key)`,
  );
  return 0;
}

export function secretList(ctx: Context, o: { json?: boolean }): number {
  const list = ctx.vault().list();
  if (o.json) ctx.io.out(JSON.stringify(list, null, 2));
  else if (list.length === 0) ctx.io.out('No secrets stored.');
  else
    for (const s of list)
      ctx.io.out(`${s.name.padEnd(32)} ${painter(ctx.io)('dim', `updated ${s.updatedAt}`)}`);
  return 0;
}

export function secretRemove(ctx: Context, name: string): number {
  if (!ctx.vault().remove(name)) throw new OrbitError('not_found', `Secret ${name} not found`);
  ctx.audit.append({ actor: 'owner', action: 'secret.removed', subject: name, data: {} });
  ctx.io.out(`Removed secret ${name}`);
  return 0;
}
