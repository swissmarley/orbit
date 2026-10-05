import { describe, expect, it } from 'vitest';
import { approval, bot, data, run } from '../../test/tui-fixtures';
import { INITIAL_UI, type KeyInfo, type Ui, onKey, reconcile, selectedRun } from './model';

const press = (ui: Ui, input: string, key: KeyInfo = {}, d = data()) => onKey(ui, d, input, key);

describe('TUI key model', () => {
  it('moves focus with Tab, Shift-Tab, h/l and 1/2/3', () => {
    expect(press(INITIAL_UI, '', { tab: true }).ui.focus).toBe('timeline');
    expect(press(INITIAL_UI, '', { tab: true, shift: true }).ui.focus).toBe('approvals');
    expect(press(INITIAL_UI, 'l').ui.focus).toBe('timeline');
    expect(press({ ...INITIAL_UI, focus: 'timeline' }, 'h').ui.focus).toBe('bots');
    expect(press(INITIAL_UI, 'h').ui.focus).toBe('bots');
    expect(press(INITIAL_UI, '3').ui.focus).toBe('approvals');
  });

  it('j/k move the Bot selection within bounds and reset the Run selection', () => {
    let ui = press({ ...INITIAL_UI, runIndex: 1 }, 'j').ui;
    expect(ui).toMatchObject({ botIndex: 1, runIndex: 0 });
    ui = press(ui, 'j').ui;
    ui = press(ui, 'j').ui;
    expect(ui.botIndex).toBe(2);
    expect(press(INITIAL_UI, 'k').ui.botIndex).toBe(0);
  });

  it("[ and ] walk the selected Bot's Runs, newest first", () => {
    const d = data();
    let ui = press(INITIAL_UI, '[', {}, d).ui;
    expect(selectedRun(d, ui)?.runId).toBe('run_a1');
    ui = press(ui, '[', {}, d).ui;
    expect(ui.runIndex).toBe(1); // only two runs
    expect(press(ui, ']', {}, d).ui.runIndex).toBe(0);
  });

  it('r runs the selected Bot; p asks before pausing', () => {
    expect(press(INITIAL_UI, 'r').command).toEqual({ kind: 'runBot', botId: 'bot_a' });
    const p = press(INITIAL_UI, 'p');
    expect(p.command).toBeUndefined();
    expect(p.ui.overlay).toMatchObject({
      kind: 'confirm',
      command: { kind: 'pauseBot', botId: 'bot_a', paused: true },
    });
    expect(press(p.ui, 'y').command).toEqual({ kind: 'pauseBot', botId: 'bot_a', paused: true });
    expect(press(p.ui, 'n').ui.overlay).toBeNull();
    expect(press(p.ui, 'x').ui.overlay).not.toBeNull();
  });

  it('a approves at once; A asks first; d opens a reason prompt', () => {
    const ui: Ui = { ...INITIAL_UI, focus: 'approvals' };
    expect(press(ui, 'a').command).toEqual({ kind: 'approve', approvalId: 'apr_1', always: false });
    const always = press(ui, 'A');
    expect(always.ui.overlay).toMatchObject({ kind: 'confirm', message: /Always allow/ });
    expect(press(always.ui, '', { return: true }).command).toEqual({
      kind: 'approve',
      approvalId: 'apr_1',
      always: true,
    });
    let deny = press(ui, 'd').ui;
    for (const ch of 'not now') deny = press(deny, ch).ui;
    deny = press(deny, '', { backspace: true }).ui;
    // Keys typed into the prompt never act as bindings.
    expect(deny.overlay).toEqual({ kind: 'deny', approvalId: 'apr_1', text: 'not no' });
    expect(press(deny, 'q').command).toBeUndefined();
    expect(press(deny, '', { return: true }).command).toEqual({
      kind: 'deny',
      approvalId: 'apr_1',
      reason: 'not no',
    });
    expect(press(press(ui, 'd').ui, '', { return: true }).command).toMatchObject({ reason: null });
    expect(press(press(ui, 'd').ui, '', { escape: true }).ui.overlay).toBeNull();
  });

  it('approval keys do nothing when nothing is pending', () => {
    const d = data({ approvals: [] });
    expect(press({ ...INITIAL_UI, focus: 'approvals' }, 'a', {}, d).command).toBeUndefined();
  });

  it('K asks before engaging or releasing the global kill switch', () => {
    const on = press(INITIAL_UI, 'K');
    expect(on.ui.overlay).toMatchObject({ command: { kind: 'kill', on: true } });
    const off = press(INITIAL_UI, 'K', {}, data({ kill: { engaged: true, by: 'owner' } }));
    expect(off.ui.overlay).toMatchObject({ command: { kind: 'kill', on: false } });
  });

  it('timeline: scroll, follow, stop (confirmed) and resume', () => {
    const ui: Ui = { ...INITIAL_UI, focus: 'timeline' };
    expect(press(ui, 'k').ui.scroll).toBe(1);
    expect(press({ ...ui, scroll: 3 }, 'j').ui.scroll).toBe(2);
    expect(press({ ...ui, scroll: 3 }, 'G').ui.scroll).toBe(0);
    expect(press(ui, 'g').ui.scroll).toBeGreaterThan(1000);
    expect(press(ui, 's').ui.overlay).toMatchObject({
      command: { kind: 'stopRun', runId: 'run_a2' },
    });
    expect(press(ui, 'u').command).toEqual({ kind: 'resumeRun', runId: 'run_a2' });
  });

  it('help overlay opens with ? and swallows keys until closed', () => {
    const help = press(INITIAL_UI, '?').ui;
    expect(help.overlay).toEqual({ kind: 'help' });
    expect(press(help, 'r').command).toBeUndefined();
    expect(press(help, '', { escape: true }).ui.overlay).toBeNull();
  });

  it('q and Ctrl-C quit', () => {
    expect(press(INITIAL_UI, 'q').command).toEqual({ kind: 'quit' });
    expect(press(INITIAL_UI, 'c', { ctrl: true }).command).toEqual({ kind: 'quit' });
  });

  it('reconcile keeps selections valid when data shrinks', () => {
    const ui: Ui = { ...INITIAL_UI, botIndex: 2, runIndex: 4, approvalIndex: 3 };
    const d = data({ bots: [bot('bot_a', 'Alpha')], approvals: [approval('apr_1')] });
    expect(reconcile(ui, d)).toMatchObject({ botIndex: 0, runIndex: 1, approvalIndex: 0 });
    expect(reconcile(INITIAL_UI, data())).toBe(INITIAL_UI);
    expect(run('x', 'bot_a', 'queued').status).toBe('queued');
  });
});
