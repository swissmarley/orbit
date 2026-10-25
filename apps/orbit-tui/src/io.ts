import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
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
  /** Open a URL in the browser (`orbit app`). Default: the platform launcher. */
  openUrl?: (url: string) => void;
  /**
   * Run the owner's interactive shell for `orbit shell` and resolve with its
   * exit code. Default: spawn it on this terminal. Tests inject a fake.
   */
  spawnShell?: (o: { shell: string; cwd: string; env: Record<string, string> }) => Promise<number>;
  /** Ask a question on the terminal and resolve with the answer (`plugin install`). */
  ask?: (question: string) => Promise<string>;
  /** Read a credential without echoing it to the terminal or scrollback. */
  askSecret?: (question: string) => Promise<string>;
}

/** Readline handles editing and Ctrl-C, while its echo goes to a muted stream. */
export async function hiddenQuestion(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input, output: muted, terminal: true });
  output.write(question);
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once('SIGINT', () => reject(new Error('Setup cancelled')));
      rl.once('close', () => reject(new Error('Setup cancelled')));
      void rl.question('').then(resolve, reject);
    });
  } finally {
    rl.close();
    muted.end();
    output.write('\n');
  }
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
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    askSecret: hiddenQuestion,
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
