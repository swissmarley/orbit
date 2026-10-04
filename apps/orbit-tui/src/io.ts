import { styleText } from 'node:util';

type Style = Parameters<typeof styleText>[0];

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  color: boolean;
  /** Register a Ctrl-C handler; returns an unregister function. */
  onInterrupt(handler: () => void): () => void;
}

export function processIo(): Io {
  const env = process.env;
  const color =
    !('NO_COLOR' in env) && env.TERM !== 'dumb' && (process.stdout.isTTY || 'FORCE_COLOR' in env);
  return {
    out: (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
    err: (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
    env,
    color,
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
