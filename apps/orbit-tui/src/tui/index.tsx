/** @jsxRuntime automatic @jsxImportSource react */
import { render } from 'ink';
import type { Context } from '../context';
import { painter } from '../io';
import { App, type MouseControl } from './app';
import { MouseInput, MouseReporting } from './terminal-mouse';

/**
 * The full-screen TUI (`orbit` with no arguments in a terminal, or `orbit
 * tui`). Like every command it talks to orbitd only through the client;
 * quitting leaves Bots running in the daemon.
 *
 * On a terminal, input reaches Ink through `MouseInput`, which takes mouse
 * reports out first; reporting itself is off unless `--mouse` (or M) turns it
 * on, and `MouseReporting` always turns it off again on the way out.
 */
export async function runTui(ctx: Context, opts: { mouse?: boolean } = {}): Promise<number> {
  const client = await ctx.client();
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  const input = tty ? new MouseInput(process.stdin) : null;
  const reporting = new MouseReporting(process.stdout, process.stdin.isTTY);
  const mouse: MouseControl | undefined = input
    ? {
        subscribe: (fn) => input.subscribe(fn),
        set: (on) => reporting.set(on),
        get enabled() {
          return reporting.enabled;
        },
      }
    : undefined;
  if (opts.mouse && mouse) reporting.set(true);
  try {
    const app = render(
      <App client={client} paint={painter(ctx.io)} {...(mouse ? { mouse } : {})} />,
      {
        exitOnCtrlC: false,
        ...(input ? { stdin: input.stream as unknown as NodeJS.ReadStream } : {}),
      },
    );
    await app.waitUntilExit();
  } finally {
    reporting.dispose();
    input?.close();
  }
  return 0;
}
