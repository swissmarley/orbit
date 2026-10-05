import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { ReactElement } from 'react';

/**
 * Render an Ink tree into memory, like ink-testing-library but with a
 * configurable terminal size (wide, narrow) and helpers to type keys and
 * wait for frames.
 */
class Stdout extends EventEmitter {
  frames: string[] = [];
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }
  write = (frame: string, done?: () => void) => {
    // Ink writes '' with a callback as a flush barrier on exit.
    if (frame !== '') this.frames.push(frame);
    done?.();
    return true;
  };
}

class Stdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
  // Terminal controls Ink calls; nothing to do in memory.
  setEncoding = () => undefined;
  setRawMode = () => undefined;
  resume = () => undefined;
  pause = () => undefined;
  ref = () => undefined;
  unref = () => undefined;
}

export const KEYS = {
  tab: '\t',
  enter: '\r',
  escape: '\u001b',
  backspace: '\u007f',
  down: '\u001b[B',
  up: '\u001b[A',
};

export function renderTerminal(tree: ReactElement, size = { columns: 120, rows: 30 }) {
  const stdout = new Stdout(size.columns, size.rows);
  const stdin = new Stdin();
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new Stdout(size.columns, size.rows) as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const lastFrame = () => stdout.frames.at(-1) ?? '';
  return {
    lastFrame,
    instance,
    /** Type keys one at a time, letting React settle in between. */
    async press(...keys: string[]) {
      for (const k of keys) {
        stdin.write(k);
        await new Promise((r) => setTimeout(r, 15));
      }
    },
    /** Wait until the latest frame matches (or fail with the frame). */
    async waitFor(test: RegExp | ((frame: string) => boolean), timeoutMs = 3000) {
      const ok = typeof test === 'function' ? test : (f: string) => test.test(f);
      const deadline = Date.now() + timeoutMs;
      while (!ok(lastFrame())) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${String(test)}. Last frame:\n${lastFrame()}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return lastFrame();
    },
    unmount: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}
