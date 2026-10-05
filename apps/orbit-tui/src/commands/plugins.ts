import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BOT_TEMPLATES,
  describeSandboxNeeds,
  EXACT_VERSION,
  NPM_PACKAGE_NAME,
  OrbitError,
  PLUGIN_SANDBOX_STATE,
  PLUGIN_STATE,
  type PluginInstallPreview,
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

/** What a plugin's sandbox gets, in one line (ADR-019). */
export const sandboxNeeds = describeSandboxNeeds;

export function renderPlugin(pl: PluginStatus, p: Paint): string[] {
  const from =
    pl.source.kind === 'builtin'
      ? ', ships with Orbit'
      : pl.source.kind === 'npm'
        ? `, npm ${pl.source.package ?? '?'}@${pl.source.version ?? '?'}`
        : '';
  const lines = [
    `${p('bold', clean(pl.name))} ${p('dim', `(${clean(pl.id)} ${clean(pl.version)}${clean(from)})`)}  ${stateWord(p, pl.state)}`,
    `  ${p('dim', PLUGIN_STATE[pl.state].meaning)}`,
  ];
  if (pl.description) lines.push(`  ${clean(pl.description)}`);
  lines.push(`  ${p('dim', 'server')} ${clean(pl.server)}`);
  const sb = PLUGIN_SANDBOX_STATE[pl.sandbox.state];
  lines.push(
    `  ${p('dim', 'sandbox')} ${p(TONE[sb.tone], `${sb.mark} ${sb.label}`)}${pl.sandbox.engine ? p('dim', ` (${pl.sandbox.engine})`) : ''}${pl.sandbox.reason ? `  ${clean(pl.sandbox.reason)}` : ''}`,
  );
  if (pl.sandbox.state !== 'remote') {
    lines.push(`  ${p('dim', 'gets')}    ${clean(sandboxNeeds(pl.sandbox.needs))}`);
  }
  if (pl.source.integrity) lines.push(`  ${p('dim', 'integrity')} ${clean(pl.source.integrity)}`);
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

export async function pluginCatalog(ctx: Context, o: { json?: boolean }): Promise<number> {
  const listing = await (await ctx.client()).plugins.catalog();
  if (o.json) {
    json(ctx, listing);
    return listing.error ? 1 : 0;
  }
  const p = painter(ctx.io);
  if (listing.error) {
    ctx.io.err(p('red', `✘ ${clean(listing.error)}`));
    return 1;
  }
  if (listing.description) ctx.io.out(p('dim', clean(listing.description)));
  if (listing.entries.length === 0) {
    ctx.io.out(
      `The catalog (${clean(listing.url)}) lists no plugins yet. Install a package you trust with: orbit plugin install npm:<package>@<version> --integrity sha512-…`,
    );
    return 0;
  }
  for (const e of listing.entries) {
    const mark = e.installed
      ? p('green', `✔ installed${e.installedVersion ? ` ${clean(e.installedVersion)}` : ''}`)
      : p('dim', '○ not installed');
    ctx.io.out(
      `${p('bold', clean(e.id).padEnd(14))} ${clean(e.name)}  ${p('dim', `${clean(e.package)}@${clean(e.version)}`)}  ${mark}`,
    );
    if (e.description) ctx.io.out(`  ${p('dim', clean(e.description))}`);
  }
  ctx.io.out(p('dim', '\nInstall one: orbit plugin install <id>'));
  return 0;
}

/** `npm:<package>@<exact version>` (scoped names have a leading @). */
export function parseNpmSpec(spec: string): { package: string; version: string } | null {
  if (!spec.startsWith('npm:')) return null;
  const rest = spec.slice('npm:'.length);
  const at = rest.lastIndexOf('@');
  if (at <= 0) return null;
  const pkg = rest.slice(0, at);
  const version = rest.slice(at + 1);
  return NPM_PACKAGE_NAME.test(pkg) && EXACT_VERSION.test(version)
    ? { package: pkg, version }
    : null;
}

export function renderPreview(pv: PluginInstallPreview, p: Paint): string[] {
  const lines = [
    `${p('bold', clean(pv.name))} ${p('dim', `(${clean(pv.id)} ${clean(pv.version)})`)} from npm ${clean(pv.package)}@${clean(pv.packageVersion)}`,
  ];
  if (pv.description) lines.push(`  ${clean(pv.description)}`);
  lines.push(
    `  ${p('dim', 'integrity')} ${clean(pv.integrity)} ${p('green', '✔ matched')}`,
    `  ${p('dim', 'manifest')}  ${clean(pv.manifestHash)} ${pv.fromCatalog ? p('green', '✔ from the catalog') : p('yellow', '△ not from the catalog: you vouch for it')}`,
    `  ${p('dim', 'server')}    ${clean(pv.server)}`,
    `  ${p('dim', 'sandbox')}   ${clean(sandboxNeeds(pv.sandbox))}`,
    `  ${p('dim', 'files')}     ${pv.files} (${Math.max(1, Math.round(pv.bytes / 1024))} KB)`,
    '',
    p('bold', 'Tools'),
  );
  for (const t of [...pv.tools].sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.name.localeCompare(b.name),
  )) {
    const w = TIER_WORD[t.tier];
    lines.push(
      `  ${p(TONE[w.tone], `${w.mark} ${w.label}`.padEnd(14))} ${clean(t.name)}${t.egress ? p('dim', ' · reaches any address') : ''}  ${p('dim', clean(t.description))}`,
    );
  }
  if (pv.secrets.length) {
    lines.push(
      '',
      `${p('bold', 'Secrets')} ${pv.secrets.map((s) => `${clean(s.name)}${s.required ? '' : p('dim', ' (optional)')}`).join(', ')}`,
    );
  }
  if (pv.settings.length) {
    lines.push(`${p('bold', 'Settings')} ${pv.settings.map((s) => clean(s.name)).join(', ')}`);
  }
  if (pv.env.length) {
    lines.push(`${p('bold', 'Reads from orbitd’s environment')} ${pv.env.map(clean).join(', ')}`);
  }
  return lines;
}

/**
 * Install from the catalog (`<id>`) or npm (`npm:<package>@<version>
 * --integrity sha512-…`): orbitd downloads and verifies it first (a dry run)
 * and shows what it declares; then, after `y` or with --yes, installs it off.
 */
export async function pluginInstall(
  ctx: Context,
  spec: string,
  o: { integrity?: string; yes?: boolean; dryRun?: boolean; json?: boolean },
): Promise<number> {
  const npm = parseNpmSpec(spec);
  if (spec.startsWith('npm:') && !npm) {
    throw new OrbitError('invalid_input', `Not a package with an exact version: ${spec}`, {
      hint: 'orbit plugin install npm:<package>@<version> --integrity sha512-…  (no ranges or tags)',
    });
  }
  if (npm && !o.integrity) {
    throw new OrbitError('invalid_input', 'An npm install needs the package integrity', {
      hint: `Get it from the publisher or \`npm view ${npm.package}@${npm.version} dist.integrity\`, then pass --integrity sha512-…`,
    });
  }
  if (!npm && o.integrity) {
    throw new OrbitError(
      'invalid_input',
      '--integrity is for npm: installs; catalog entries carry their own',
    );
  }
  const c = await ctx.client();
  const req = npm
    ? { source: 'npm' as const, ...npm, integrity: o.integrity ?? '' }
    : { source: 'catalog' as const, id: spec };
  const p = painter(ctx.io);
  const dry = await c.plugins.install({ ...req, dryRun: true });
  if (o.dryRun) {
    if (o.json) json(ctx, dry);
    else for (const l of renderPreview(dry.preview, p)) ctx.io.out(l);
    return 0;
  }
  if (!o.json) for (const l of renderPreview(dry.preview, p)) ctx.io.out(l);
  if (!o.yes) {
    if (!ctx.io.interactive || !ctx.io.ask) {
      throw new OrbitError('invalid_input', 'Installing needs your confirmation', {
        hint: 'Review it with --dry-run, then run again with --yes.',
      });
    }
    const answer = await ctx.io.ask(
      `\nInstall ${clean(dry.preview.name)}? It stays off until you enable it. [y/N] `,
    );
    if (answer.trim().toLowerCase() !== 'y') {
      ctx.io.out('Nothing was installed.');
      return 1;
    }
  }
  const done = await c.plugins.install({ ...req, dryRun: false });
  if (o.json) {
    json(ctx, done);
    return 0;
  }
  const pl = done.plugin;
  ctx.io.out(
    `${p('green', '✔')} Installed ${clean(dry.preview.name)} (${clean(dry.preview.id)}). It is off: review it with \`orbit plugin show ${clean(dry.preview.id)}\`, then \`orbit plugin enable ${clean(dry.preview.id)}\`.`,
  );
  for (const w of pl?.warnings ?? []) ctx.io.out(p('yellow', `⚠ ${clean(w)}`));
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
