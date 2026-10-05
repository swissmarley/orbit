import { styleText } from 'node:util';

type Style = Parameters<typeof styleText>[0];

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  color: boolean;
  /** stdin and stdout are a terminal: `orbit` alone opens the TUI. */
  interactive?: boolean;
  /** Register a Ctrl-C handler; returns an unregister function. */
  onInterrupt(handler: () => void): () => void;
  /**
   * Start orbitd for this ORBIT_HOME in the background and resolve once it
   * has published its address. Default: spawn the orbitd bin detached.
   * Tests start it in-process instead.
   */
  startDaemon?: (env: Record<string, string | undefined>) => Promise<void>;
}

export function processIo(): Io {
  const env = process.env;
  const color =
    !('NO_COLOR' in env) && env.TERM !== 'dumb' && (process.stdout.isTTY || 'FORCE_COLOR' in env);
  // `orbit … | head` closes stdout early; that is a normal end, not a crash.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  return {
    out: (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
    err: (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
    env,
    color,
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    onInterrupt(handler) {
      process.on('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
  };
}

export function painter(io: Pick<Io, 'color'>) {
  return (style: Style, text: string): string =>
    io.color ? styleText(style, text, { validateStream: false }) : text;
}
