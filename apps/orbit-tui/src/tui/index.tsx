import { render } from 'ink';
import type { Context } from '../context';
import { painter } from '../io';
import { App } from './app';

/**
 * The full-screen TUI (`orbit` with no arguments in a terminal, or `orbit
 * tui`). Like every command it talks to orbitd only through the client;
 * quitting leaves Bots running in the daemon.
 */
export async function runTui(ctx: Context): Promise<number> {
  const client = await ctx.client();
  const app = render(<App client={client} paint={painter(ctx.io)} />, {
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
  return 0;
}
