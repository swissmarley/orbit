import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { MOUSE_OFF, MOUSE_ON, type MouseEvent, splitMouse } from './mouse';

/**
 * The TTY side of the TUI's optional mouse (`orbit tui --mouse`, or M):
 * terminal input goes through `MouseInput`, which takes SGR mouse reports out
 * before Ink sees anything (so a report can never reach a text input), and
 * `MouseReporting` turns reporting on and off — only on a TTY, and always off
 * again on exit, on a crash, on SIGTERM/SIGHUP and while suspended.
 */

/** A held-back `ESC` (maybe the start of a report) is released as a key after this. */
export const ESCAPE_FLUSH_MS = 25;

type Listener = (e: MouseEvent) => void;

/** The parts of process.stdin MouseInput uses (injectable for tests). */
export interface TtyIn {
  isTTY?: boolean;
  on(event: 'data', fn: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', fn: (chunk: Buffer | string) => void): unknown;
  setRawMode?(mode: boolean): unknown;
  ref?(): unknown;
  unref?(): unknown;
  pause(): unknown;
  resume(): unknown;
}

/**
 * The stdin Ink reads: process.stdin minus mouse reports. Everything else
 * passes through unchanged and in order.
 */
export class MouseInput {
  /** Hand this to Ink's `render({ stdin })`. */
  readonly stream: PassThrough & { isTTY: boolean; setRawMode(m: boolean): unknown };
  private pending = '';
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly decoder = new StringDecoder('utf8');
  private readonly onData = (chunk: Buffer | string) => {
    this.feed(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
  };

  constructor(private readonly input: TtyIn) {
    const stream = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode(m: boolean): unknown;
    };
    stream.isTTY = input.isTTY === true;
    stream.setRawMode = (m: boolean) => {
      input.setRawMode?.(m);
      return stream;
    };
    // Ink refs stdin while it reads keys and unrefs it on exit.
    (stream as unknown as { ref: () => void }).ref = () => input.ref?.();
    (stream as unknown as { unref: () => void }).unref = () => input.unref?.();
    this.stream = stream;
    input.on('data', this.onData);
    input.resume();
  }

  /** Mouse events, in order; returns an unsubscribe. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Raw terminal input (also used by tests). */
  feed(chunk: string): void {
    clearTimeout(this.timer);
    const split = splitMouse(this.pending, chunk);
    this.pending = split.pending;
    if (split.text) this.stream.write(split.text);
    for (const e of split.events) for (const fn of this.listeners) fn(e);
    if (this.pending) {
      this.timer = setTimeout(() => {
        const held = this.pending;
        this.pending = '';
        if (held) this.stream.write(held);
      }, ESCAPE_FLUSH_MS);
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.input.off('data', this.onData);
    this.input.pause();
    this.listeners.clear();
    this.stream.end();
  }
}

/** The parts of the process MouseReporting uses (injectable for tests). */
export interface ProcessLike {
  pid: number;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  off(event: string, fn: (...args: unknown[]) => void): unknown;
  kill(pid: number, signal: string): unknown;
}

export interface TtyOut {
  isTTY?: boolean;
  write(s: string): unknown;
}

/** Signals after which the terminal must not be left reporting the mouse. */
const ENDING = ['SIGTERM', 'SIGHUP'] as const;

export class MouseReporting {
  private on = false;
  private suspended = false;
  private guarded = false;
  private readonly onExit = () => this.write(false);
  private readonly onEnding = (signal: unknown) => {
    // Turn reporting off, then let the signal do what it would have done.
    this.dispose();
    this.proc.kill(this.proc.pid, String(signal));
  };
  private readonly onSuspend = () => {
    // Off while the shell owns the terminal; stop for real, back on at SIGCONT.
    this.write(false);
    this.suspended = true;
    this.proc.off('SIGTSTP', this.onSuspend);
    this.proc.kill(this.proc.pid, 'SIGTSTP');
  };
  private readonly onContinue = () => {
    if (!this.suspended) return;
    this.suspended = false;
    this.proc.on('SIGTSTP', this.onSuspend);
    if (this.on) this.write(true);
  };

  constructor(
    private readonly out: TtyOut,
    private readonly inIsTty: boolean,
    private readonly proc: ProcessLike = process,
  ) {}

  /** Reporting needs a terminal on both ends. */
  get available(): boolean {
    return this.out.isTTY === true && this.inIsTty;
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Turn reporting on or off; false when it cannot be turned on here. */
  set(on: boolean): boolean {
    if (on && !this.available) return false;
    if (on === this.on) return true;
    this.on = on;
    if (on) this.guard();
    this.write(on);
    if (!on) this.unguard();
    return true;
  }

  /** Off for good (normal exit); idempotent. */
  dispose(): void {
    if (this.on) this.write(false);
    this.on = false;
    this.unguard();
  }

  private write(on: boolean): void {
    if (!this.available) return;
    try {
      this.out.write(on ? MOUSE_ON : MOUSE_OFF);
    } catch {
      // the terminal is gone; nothing to restore
    }
  }

  private guard(): void {
    if (this.guarded) return;
    this.guarded = true;
    this.proc.on('exit', this.onExit);
    for (const s of ENDING) this.proc.on(s, this.onEnding);
    this.proc.on('SIGTSTP', this.onSuspend);
    this.proc.on('SIGCONT', this.onContinue);
  }

  private unguard(): void {
    if (!this.guarded) return;
    this.guarded = false;
    this.proc.off('exit', this.onExit);
    for (const s of ENDING) this.proc.off(s, this.onEnding);
    this.proc.off('SIGTSTP', this.onSuspend);
    this.proc.off('SIGCONT', this.onContinue);
  }
}
