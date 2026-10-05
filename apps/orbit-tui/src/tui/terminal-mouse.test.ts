import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MOUSE_OFF, MOUSE_ON, type MouseEvent } from './mouse';
import {
  ESCAPE_FLUSH_MS,
  MouseInput,
  MouseReporting,
  type ProcessLike,
  type TtyIn,
} from './terminal-mouse';

class FakeIn extends EventEmitter implements TtyIn {
  isTTY = true;
  raw: boolean[] = [];
  paused = false;
  setRawMode(m: boolean) {
    this.raw.push(m);
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
}

function readAll(input: MouseInput): string {
  let out = '';
  let chunk: unknown;
  while ((chunk = input.stream.read()) !== null) out += chunk as string;
  return out;
}

describe('MouseInput', () => {
  it('passes keys on to Ink unchanged and takes mouse reports out', () => {
    const tty = new FakeIn();
    const input = new MouseInput(tty);
    const events: MouseEvent[] = [];
    input.subscribe((e) => events.push(e));
    tty.emit('data', Buffer.from('ab\u001b[<0;3;4M\u001b[Bé'));
    expect(readAll(input)).toBe('ab\u001b[Bé');
    expect(events).toMatchObject([{ kind: 'press', x: 2, y: 3 }]);
    input.close();
    expect(tty.paused).toBe(true);
    expect(tty.listenerCount('data')).toBe(0);
  });

  it('joins a report split across chunks (and a UTF-8 character split across them)', () => {
    const tty = new FakeIn();
    const input = new MouseInput(tty);
    const events: MouseEvent[] = [];
    input.subscribe((e) => events.push(e));
    const bytes = Buffer.from('é\u001b[<65;10;2Mz');
    for (const b of bytes) tty.emit('data', Buffer.from([b]));
    expect(readAll(input)).toBe('éz');
    expect(events).toMatchObject([{ kind: 'wheel', wheel: 'down', x: 9, y: 1 }]);
    input.close();
  });

  it('releases a lone Escape as a key after a moment', () => {
    vi.useFakeTimers();
    try {
      const input = new MouseInput(new FakeIn());
      input.feed('\u001b');
      expect(readAll(input)).toBe('');
      vi.advanceTimersByTime(ESCAPE_FLUSH_MS + 1);
      expect(readAll(input)).toBe('\u001b');
      input.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('looks like a raw-mode TTY to Ink and forwards raw mode to the terminal', () => {
    const tty = new FakeIn();
    const input = new MouseInput(tty);
    expect(input.stream.isTTY).toBe(true);
    input.stream.setRawMode(true);
    input.stream.setRawMode(false);
    expect(tty.raw).toEqual([true, false]);
    input.close();
  });
});

class FakeProcess extends EventEmitter implements ProcessLike {
  pid = 4242;
  kills: string[] = [];
  kill(_pid: number, signal: string) {
    this.kills.push(signal);
  }
}

function reporting(opts: { outTty?: boolean; inTty?: boolean } = {}) {
  const writes: string[] = [];
  const proc = new FakeProcess();
  const r = new MouseReporting(
    { isTTY: opts.outTty ?? true, write: (s: string) => writes.push(s) },
    opts.inTty ?? true,
    proc,
  );
  return { r, writes, proc };
}

describe('MouseReporting', () => {
  it('turns SGR reporting on and off, only on a TTY', () => {
    const { r, writes, proc } = reporting();
    expect(r.set(true)).toBe(true);
    expect(writes).toEqual([MOUSE_ON]);
    expect(MOUSE_ON).toBe('\u001b[?1000h\u001b[?1006h');
    expect(r.set(true)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(r.set(false)).toBe(true);
    expect(writes).toEqual([MOUSE_ON, MOUSE_OFF]);
    expect(proc.eventNames()).toEqual([]);

    for (const tty of [{ outTty: false }, { inTty: false }]) {
      const piped = reporting(tty);
      expect(piped.r.set(true)).toBe(false);
      expect(piped.writes).toEqual([]);
      expect(piped.r.enabled).toBe(false);
    }
  });

  it('always turns it off on exit (a crash ends in exit too)', () => {
    const { r, writes, proc } = reporting();
    r.set(true);
    proc.emit('exit', 1);
    expect(writes.at(-1)).toBe(MOUSE_OFF);
  });

  it('turns it off on SIGTERM and SIGHUP, then lets the signal end the process', () => {
    for (const signal of ['SIGTERM', 'SIGHUP']) {
      const { r, writes, proc } = reporting();
      r.set(true);
      proc.emit(signal, signal);
      expect(writes).toEqual([MOUSE_ON, MOUSE_OFF]);
      expect(proc.kills).toEqual([signal]);
      // our handlers are gone, so the re-raised signal does its default thing
      expect(proc.listenerCount(signal)).toBe(0);
    }
  });

  it('turns it off while suspended and back on after SIGCONT', () => {
    const { r, writes, proc } = reporting();
    r.set(true);
    proc.emit('SIGTSTP');
    expect(writes).toEqual([MOUSE_ON, MOUSE_OFF]);
    expect(proc.kills).toEqual(['SIGTSTP']);
    expect(proc.listenerCount('SIGTSTP')).toBe(0);
    proc.emit('SIGCONT');
    expect(writes).toEqual([MOUSE_ON, MOUSE_OFF, MOUSE_ON]);
    expect(proc.listenerCount('SIGTSTP')).toBe(1);
  });

  it('dispose turns it off once and removes every handler', () => {
    const { r, writes, proc } = reporting();
    r.set(true);
    r.dispose();
    r.dispose();
    expect(writes).toEqual([MOUSE_ON, MOUSE_OFF]);
    expect(proc.eventNames()).toEqual([]);
  });
});
