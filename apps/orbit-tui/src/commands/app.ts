import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrbitError, isAllowedAppOrigin } from '@orbit/core';
import { buildChildEnv } from '@orbit/runtime';
import type { Context } from '../context';
import { painter } from '../io';

/** Display variables a browser launcher needs (never credentials). */
const DISPLAY_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'BROWSER'];

/** The 0600 page that forwards the browser to the sign-in link. */
export function signInFile(home: string): string {
  return join(home, 'app-sign-in.html');
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Open the sign-in link in the default browser without putting it on a
 * command line (other local users can read argv from /proc or ps until the
 * launcher exits; review M5 MEDIUM-1): the link goes into a 0600 file in
 * $ORBIT_HOME that redirects, and the launcher gets that file's path. The
 * launcher's environment is an allowlist plus display variables (ADR-005).
 */
export function openInBrowser(
  url: string,
  env: Record<string, string | undefined>,
  home: string,
  spawnFn: typeof spawn = spawn,
): void {
  const file = signInFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  const href = escapeHtml(url);
  writeFileSync(
    tmp,
    `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
      `<meta http-equiv="refresh" content="0;url=${href}"><title>Orbit</title>` +
      `<p>Opening Orbit… <a href="${href}">continue</a></p>\n`,
    { mode: 0o600 },
  );
  renameSync(tmp, file);
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', file]]
        : ['xdg-open', [file]];
  const extra = Object.fromEntries(
    DISPLAY_VARS.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]]])),
  ) as Record<string, string>;
  const child = spawnFn(cmd, args, {
    env: buildChildEnv('tool', env, extra),
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => undefined); // no launcher: the URL is printed anyway
  child.unref();
}

/**
 * `orbit app`: sign the browser in to the App that orbitd serves (ADR-011).
 * The CLI holds the bearer token, mints a one-time ticket and opens
 * `<origin>/login#ticket=…`; the page trades it for an HttpOnly cookie. The
 * ticket sits in the URL fragment, which browsers never send to a server.
 */
export async function openApp(
  ctx: Context,
  o: { origin?: string; open?: boolean; json?: boolean },
): Promise<number> {
  let origin: string | undefined;
  if (o.origin !== undefined) {
    origin = o.origin.trim().replace(/\/+$/, '').toLowerCase();
    if (!isAllowedAppOrigin(origin)) {
      throw new OrbitError(
        'invalid_input',
        `--origin must be a loopback origin (got ${o.origin})`,
        {
          hint: 'For the Vite dev server: --origin http://localhost:5173 (and ORBIT_ALLOWED_ORIGINS on orbitd).',
        },
      );
    }
  }
  const client = await ctx.client();
  const { ticket, expiresAt } = await client.call('createLoginTicket');
  const url = `${origin ?? client.baseUrl}/login#ticket=${ticket}`;
  if (o.json) {
    ctx.io.out(JSON.stringify({ url, expiresAt }));
    return 0;
  }
  const p = painter(ctx.io);
  const open = o.open !== false && ctx.io.interactive === true;
  if (open) (ctx.io.openUrl ?? ((u: string) => openInBrowser(u, ctx.io.env, ctx.home)))(url);
  ctx.io.out(`${open ? 'Opening' : 'Open'} Orbit: ${p('bold', url)}`);
  ctx.io.out(p('dim', '  A one-time sign-in link: it works once, within 2 minutes.'));
  return 0;
}
