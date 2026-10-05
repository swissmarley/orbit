/**
 * SGR mouse reports (`ESC [ < b ; x ; y M|m`, enabled with `?1000h` and
 * `?1006h`), parsed out of raw terminal input. Pure: the TTY plumbing lives
 * in `terminal-mouse.ts`, the bindings in `model.ts` (`onMouse`).
 */

export interface MouseEvent {
  kind: 'press' | 'release' | 'wheel';
  /** 0 left, 1 middle, 2 right; null for the wheel. */
  button: 0 | 1 | 2 | null;
  wheel: 'up' | 'down' | null;
  /** 0-based cell; the terminal reports 1-based. */
  x: number;
  y: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

export const MOUSE_ON = '\u001b[?1000h\u001b[?1006h';
export const MOUSE_OFF = '\u001b[?1006l\u001b[?1000l';

const ESC = '\u001b';
// eslint-disable-next-line no-control-regex
const REPORT = /^\u001b\[<(\d{1,4});(\d{1,5});(\d{1,5})([Mm])/;
/** A report cut off by the end of a chunk: wait for the rest. */
// eslint-disable-next-line no-control-regex
const PARTIAL = /^\u001b(\[(<(\d{0,4}(;\d{0,5}(;\d{0,5})?)?)?)?)?$/;

function toEvent(code: number, x: number, y: number, final: string): MouseEvent | null {
  const mods = { shift: (code & 4) !== 0, meta: (code & 8) !== 0, ctrl: (code & 16) !== 0 };
  const cell = { x: Math.max(0, x - 1), y: Math.max(0, y - 1) };
  // Motion reports (bit 32) are not requested (?1003 is never enabled); ignore any.
  if (code & 32) return null;
  if (code & 64) {
    const low = code & 3;
    if (low > 1) return null; // horizontal wheel
    return { kind: 'wheel', button: null, wheel: low === 0 ? 'up' : 'down', ...cell, ...mods };
  }
  const low = code & 3;
  if (low === 3) return null; // X10-style release without a button
  return {
    kind: final === 'M' ? 'press' : 'release',
    button: low as 0 | 1 | 2,
    wheel: null,
    ...cell,
    ...mods,
  };
}

export interface MouseSplit {
  /** Everything that is not a mouse report, in order (keys go on to Ink). */
  text: string;
  events: MouseEvent[];
  /** The start of a report cut off at the end of the input; pass it to the next call. */
  pending: string;
}

/**
 * Split raw input into mouse reports and everything else. `pending` is what
 * the previous call held back. Anything that is not a complete, well-formed
 * report (garbage after `ESC [<`, an over-long number) is passed through as
 * text, never swallowed. A held-back tail is at most a few bytes; the caller
 * flushes it as text after a short timeout (a lone Escape key).
 */
export function splitMouse(pending: string, chunk: string): MouseSplit {
  const input = pending + chunk;
  const events: MouseEvent[] = [];
  let text = '';
  let i = 0;
  while (i < input.length) {
    const esc = input.indexOf(ESC, i);
    if (esc < 0) {
      text += input.slice(i);
      break;
    }
    text += input.slice(i, esc);
    const rest = input.slice(esc);
    const m = REPORT.exec(rest);
    if (m) {
      const ev = toEvent(Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? 'M');
      if (ev) events.push(ev);
      i = esc + m[0].length;
      continue;
    }
    if (PARTIAL.test(rest)) return { text, events, pending: rest };
    // Not a mouse report: the ESC and what follows are ordinary input.
    text += ESC;
    i = esc + 1;
  }
  return { text, events, pending: '' };
}
