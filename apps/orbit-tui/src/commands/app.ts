import { spawn } from 'node:child_process';
import { OrbitError, isAllowedAppOrigin } from '@orbit/core';
import { buildChildEnv } from '@orbit/runtime';
import type { Context } from '../context';
import { painter } from '../io';

/** Display variables a browser launcher needs (never credentials). */
const DISPLAY_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'BROWSER'];

/** Open a URL in the default browser, with an allowlisted environment (ADR-005). */
export function openInBrowser(url: string, env: Record<string, string | undefined>): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const extra = Object.fromEntries(
    DISPLAY_VARS.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]]])),
  ) as Record<string, string>;
  const child = spawn(cmd, args, {
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
  if (open) (ctx.io.openUrl ?? ((u: string) => openInBrowser(u, ctx.io.env)))(url);
  ctx.io.out(`${open ? 'Opening' : 'Open'} Orbit: ${p('bold', url)}`);
  ctx.io.out(p('dim', '  A one-time sign-in link: it works once, within 2 minutes.'));
  return 0;
}
