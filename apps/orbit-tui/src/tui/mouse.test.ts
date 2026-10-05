import { describe, expect, it } from 'vitest';
import { approval, data as fixture } from '../../test/tui-fixtures';
import { screenLayout, tabAt } from './layout';
import { HELP, INITIAL_UI, type Overlay, type Ui, onKey, onMouse } from './model';
import { type MouseEvent, splitMouse } from './mouse';

/** What the TUI has after its first load (the fixture starts before it). */
const data = (over: Parameters<typeof fixture>[0] = {}) => fixture({ loaded: true, ...over });

const ESC = '\u001b';
const sgr = (b: number, x: number, y: number, final = 'M') => `${ESC}[<${b};${x};${y}${final}`;

/** Every chunking of `text`, fed through splitMouse like a stream. */
function feedAll(chunks: string[]): { text: string; events: MouseEvent[]; pending: string } {
  let pending = '';
  let text = '';
  const events: MouseEvent[] = [];
  for (const c of chunks) {
    const r = splitMouse(pending, c);
    text += r.text;
    events.push(...r.events);
    pending = r.pending;
  }
  return { text, events, pending };
}

describe('splitMouse (SGR reports)', () => {
  it('parses presses, releases and the wheel, 1-based to 0-based, with modifiers', () => {
    const r = splitMouse('', sgr(0, 10, 5) + sgr(0, 10, 5, 'm') + sgr(64, 1, 1) + sgr(65, 2, 3));
    expect(r.text).toBe('');
    expect(r.pending).toBe('');
    expect(r.events).toEqual([
      { kind: 'press', button: 0, wheel: null, x: 9, y: 4, shift: false, meta: false, ctrl: false },
      {
        kind: 'release',
        button: 0,
        wheel: null,
        x: 9,
        y: 4,
        shift: false,
        meta: false,
        ctrl: false,
      },
      {
        kind: 'wheel',
        button: null,
        wheel: 'up',
        x: 0,
        y: 0,
        shift: false,
        meta: false,
        ctrl: false,
      },
      {
        kind: 'wheel',
        button: null,
        wheel: 'down',
        x: 1,
        y: 2,
        shift: false,
        meta: false,
        ctrl: false,
      },
    ]);
    expect(splitMouse('', sgr(2 + 4 + 16, 3, 3)).events[0]).toMatchObject({
      button: 2,
      shift: true,
      ctrl: true,
      meta: false,
    });
  });

  it('keeps keys around and between reports, in order', () => {
    const r = splitMouse('', `ab${sgr(0, 1, 1)}${ESC}[A${sgr(65, 4, 4)}c\r`);
    expect(r.text).toBe(`ab${ESC}[Ac\r`);
    expect(r.events.map((e) => e.kind)).toEqual(['press', 'wheel']);
  });

  it('reassembles a report split at every possible point', () => {
    const whole = `x${sgr(0, 120, 40)}y${sgr(64, 7, 8)}`;
    for (let i = 1; i < whole.length; i++) {
      const r = feedAll([whole.slice(0, i), whole.slice(i)]);
      expect(r.text).toBe('xy');
      expect(r.events.map((e) => [e.kind, e.x, e.y])).toEqual([
        ['press', 119, 39],
        ['wheel', 6, 7],
      ]);
      expect(r.pending).toBe('');
    }
    // one byte at a time
    expect(
      feedAll(Array.from({ length: whole.length }, (_, i) => whole.charAt(i))).events,
    ).toHaveLength(2);
  });

  it('holds back only what could still become a report (a lone Escape too, for the caller to flush)', () => {
    expect(splitMouse('', `a${ESC}`)).toEqual({ text: 'a', events: [], pending: ESC });
    expect(splitMouse('', `${ESC}[<12;3`)).toMatchObject({ text: '', pending: `${ESC}[<12;3` });
    expect(splitMouse(ESC, '[A')).toEqual({ text: `${ESC}[A`, events: [], pending: '' });
  });

  it('passes garbage through as text instead of swallowing it', () => {
    for (const junk of [
      `${ESC}[<abc`,
      `${ESC}[<1;2;3X`,
      `${ESC}[<123456;1;1M`,
      `${ESC}[<1;2;1234567M`,
      `${ESC}[<;;M`,
    ]) {
      const r = splitMouse('', `${junk}z`);
      expect(r.events).toEqual([]);
      expect(r.text + r.pending).toBe(`${junk}z`);
    }
  });

  it('ignores motion, horizontal wheel and button-less releases', () => {
    const r = splitMouse('', sgr(32, 1, 1) + sgr(35, 1, 1) + sgr(66, 1, 1) + sgr(3, 1, 1));
    expect(r.events).toEqual([]);
    expect(r.text).toBe('');
  });
});

const W = { columns: 120, rows: 22 };
const layoutFor = (ui: Ui, size = W) => screenLayout(size.columns, size.rows, ui.overlay, ui.focus);
const press = (x: number, y: number): MouseEvent => ({
  kind: 'press',
  button: 0,
  wheel: null,
  x,
  y,
  shift: false,
  meta: false,
  ctrl: false,
});
const wheel = (dir: 'up' | 'down'): MouseEvent => ({
  ...press(50, 10),
  kind: 'wheel',
  button: null,
  wheel: dir,
});
const click = (ui: Ui, x: number, y: number, d = data()) =>
  onMouse(ui, d, press(x, y), layoutFor(ui));

describe('onMouse (the pure mouse model)', () => {
  // 120×22: Bots x 0–30, Timeline 31–79, Approvals 80–119; content starts at row 3.
  it('a click selects the Bot under the pointer and focuses its pane', () => {
    const r = click({ ...INITIAL_UI, focus: 'timeline', runIndex: 1 }, 5, 4);
    expect(r.ui).toMatchObject({ focus: 'bots', botIndex: 1, botId: 'bot_b', runIndex: 0 });
    expect(r.command).toBeUndefined();
    // the same Bot again: only focus, the Run selection stays
    const same = click({ ...INITIAL_UI, focus: 'timeline', botId: 'bot_a', runIndex: 1 }, 5, 3);
    expect(same.ui).toMatchObject({ focus: 'bots', botId: 'bot_a', runIndex: 1 });
  });

  it("a click on one of the Bot's Runs selects that Run", () => {
    // 3 bot rows (3–5), a margin (6), the header (7), Runs from row 8.
    const r = click(INITIAL_UI, 5, 9);
    expect(r.ui).toMatchObject({ focus: 'bots', runIndex: 1, runId: 'run_a1' });
    expect(click(INITIAL_UI, 5, 7).ui).toMatchObject({ focus: 'bots', runIndex: 0, runId: null });
  });

  it('a click on an approval selects it but never opens, approves or denies it', () => {
    const d = data({ approvals: [approval('apr_1'), approval('apr_2')] });
    const r = click({ ...INITIAL_UI, approvalMoved: true }, 90, 4, d);
    expect(r.ui).toMatchObject({
      focus: 'approvals',
      approvalIndex: 1,
      approvalId: 'apr_2',
      approvalMoved: false,
      overlay: null,
    });
    expect(r.command).toBeUndefined();
    // a second click on the same row still only selects
    expect(click(r.ui, 90, 4, d)).toMatchObject({ ui: { overlay: null } });
    expect(click(r.ui, 90, 4, d).command).toBeUndefined();
  });

  it('a click elsewhere in a pane focuses it; outside every pane does nothing', () => {
    expect(click(INITIAL_UI, 50, 10).ui.focus).toBe('timeline');
    expect(click(INITIAL_UI, 50, 0).ui).toBe(INITIAL_UI);
    expect(click(INITIAL_UI, 50, 21).ui).toBe(INITIAL_UI);
  });

  it('only a left press acts; right, middle and releases do not', () => {
    for (const ev of [
      { ...press(5, 4), button: 2 as const },
      { ...press(5, 4), button: 1 as const },
      { ...press(5, 4), kind: 'release' as const },
    ]) {
      expect(onMouse(INITIAL_UI, data(), ev, layoutFor(INITIAL_UI)).ui).toBe(INITIAL_UI);
    }
  });

  it('narrow: the tab bar switches panes; rows hit under the tabs', () => {
    const N = { columns: 72, rows: 18 };
    const ui = INITIAL_UI;
    const l = layoutFor(ui, N);
    // " ▶1 Bots " (9) " 2 Timeline " (12) " 3 Approvals (1) "
    expect(tabAt(3, 'bots', 1)).toBe('bots');
    expect(tabAt(12, 'bots', 1)).toBe('timeline');
    expect(tabAt(25, 'bots', 1)).toBe('approvals');
    expect(tabAt(70, 'bots', 1)).toBeNull();
    expect(onMouse(ui, data(), press(25, 1), l).ui.focus).toBe('approvals');
    // The focused pane starts at row 2: its content at row 4.
    expect(onMouse(ui, data(), press(5, 5), l).ui).toMatchObject({ botId: 'bot_b' });
  });

  it('the wheel works like j/k on the focused list, the timeline and scrollable overlays', () => {
    expect(onMouse(INITIAL_UI, data(), wheel('down'), layoutFor(INITIAL_UI)).ui.botIndex).toBe(1);
    const tl: Ui = { ...INITIAL_UI, focus: 'timeline' };
    expect(onMouse(tl, data(), wheel('up'), layoutFor(tl)).ui.scroll).toBe(1);
    const card: Ui = { ...INITIAL_UI, overlay: { kind: 'card', approvalId: 'apr_1', scroll: 0 } };
    const r = onMouse(card, data(), wheel('down'), layoutFor(card));
    expect(r.ui.overlay).toMatchObject({ kind: 'card', scroll: 1 });
    expect(r.command).toBeUndefined();
  });

  it('clicks do nothing while an overlay is open', () => {
    const card: Ui = { ...INITIAL_UI, overlay: { kind: 'card', approvalId: 'apr_1', scroll: 0 } };
    expect(click(card, 5, 4).ui).toBe(card);
  });

  it('never reaches a question, the deny reason or the memory editor', () => {
    const memory: Overlay = {
      kind: 'memory',
      botId: 'bot_a',
      index: 0,
      open: false,
      scroll: 0,
      search: null,
      query: '',
    };
    const overlays: Overlay[] = [
      { kind: 'confirm', message: 'Stop?', command: { kind: 'stopRun', runId: 'run_a2' } },
      { kind: 'deny', approvalId: 'apr_1', text: 'too broad' },
      {
        kind: 'memoryEdit',
        memoryId: 'mem_1',
        field: 'body',
        title: 't',
        body: 'b',
        cursor: 1,
        original: { title: 't', body: 'b' },
        untrusted: false,
        back: memory,
      },
      { ...memory, search: 'lau' },
    ];
    for (const overlay of overlays) {
      const ui: Ui = { ...INITIAL_UI, overlay };
      for (const ev of [press(5, 4), wheel('down'), wheel('up')]) {
        const r = onMouse(ui, data(), ev, layoutFor(ui));
        expect(r.ui).toBe(ui);
        expect(r.command).toBeUndefined();
      }
    }
  });

  it('M toggles the mouse and the help lists it', () => {
    expect(onKey(INITIAL_UI, data(), 'M', {}).command).toEqual({ kind: 'mouse', on: true });
    expect(onKey({ ...INITIAL_UI, mouse: true }, data(), 'M', {}).command).toEqual({
      kind: 'mouse',
      on: false,
    });
    expect(HELP.some((h) => h.keys === 'M' && h.does.includes('mouse'))).toBe(true);
  });
});
