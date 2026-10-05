/** @jsxRuntime automatic @jsxImportSource react */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { KEYS, renderTerminal } from '../../test/render';
import { approval, data, events, fakeClient } from '../../test/tui-fixtures';
import { App } from './app';

const plain = (_style: unknown, text: string) => text;
const WIDE = { columns: 120, rows: 22 };
const NARROW = { columns: 72, rows: 18 };

// Times are local and relative: pin the zone and the clock (Date only; Ink's timers stay real).
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-04T09:20:00.000Z'));
});
afterAll(() => {
  vi.useRealTimers();
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

function open(size = WIDE, d = data()) {
  const fake = fakeClient(d);
  const t = renderTerminal(<App client={fake.client} paint={plain} refreshDelayMs={5} />, size);
  unmount = t.unmount;
  return { ...t, ...fake };
}

describe('TUI rendering', () => {
  it('wide: three panes, status bar, the parked Run and its approval card', async () => {
    const t = open();
    const frame = await t.waitFor(/waiting for your approval/);
    expect(frame).toMatchSnapshot();
    expect(frame).toMatch(/mock · Demo mode/);
    expect(frame).toMatch(/Approvals 1 pending/);
  });

  it('narrow: one pane at a time with a tab bar', async () => {
    const t = open(NARROW);
    await t.waitFor(/Mailer/);
    expect(t.lastFrame()).toMatch(/▶1 Bots {2}2 Timeline {2}3 Approvals \(1\)/);
    await t.press('3');
    expect(await t.waitFor(/Enter\/a open card to approve/)).toMatchSnapshot();
    expect(t.lastFrame()).not.toMatch(/Timeline\s*│/);
  });

  it('help overlay lists every binding', async () => {
    const t = open();
    await t.waitFor(/Mailer/);
    await t.press('?');
    const frame = await t.waitFor(/Keys/);
    expect(frame).toMatchSnapshot();
    await t.press(KEYS.escape);
    await t.waitFor((f) => !f.includes('Keys'));
  });

  it('shows the kill switch and usage-limit state in the status bar', async () => {
    const t = open(WIDE, data({ kill: { engaged: true, by: 'owner' } }));
    expect(await t.waitFor(/KILL SWITCH/)).toMatch(/■ KILL SWITCH/);
  });

  it('renders file changes as a diff on the card', async () => {
    const diffCard = approval('apr_1', {
      what: 'write notes.md',
      diff: '--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-old line\n+new line',
    });
    const t = open(WIDE, data({ approvals: [diffCard] }));
    const frame = await t.waitFor(/new line/);
    expect(frame).toMatch(/-old line/);
    expect(frame).toMatch(/\+new line/);
  });

  it('empty state explains how to start', async () => {
    const t = open(WIDE, data({ bots: [], runs: [], approvals: [] }));
    const frame = await t.waitFor(/No bots yet/);
    expect(frame).toMatch(/Nothing needs you right now/);
  });
});

describe('TUI actions', () => {
  it('a approves the selected card through orbitd and reports it', async () => {
    const t = open();
    await t.waitFor(/Mailer/);
    await t.press('3', 'a');
    expect(await t.waitFor(/a approve · A always allow/)).toMatchSnapshot();
    expect(t.mock.approvals.approve).not.toHaveBeenCalled();
    await t.press('a');
    await t.waitFor(/approved send email/);
    expect(t.mock.approvals.approve).toHaveBeenCalledWith('apr_1', { always: null });
  });

  it('d asks for a reason, then denies with it', async () => {
    const t = open();
    await t.waitFor(/Mailer/);
    await t.press('3', 'd', ...Array.from('wrong tone'));
    expect(await t.waitFor(/› wrong tone/)).toMatchSnapshot();
    await t.press(KEYS.enter);
    await t.waitFor(/denied send email/);
    expect(t.mock.approvals.deny).toHaveBeenCalledWith('apr_1', { reason: 'wrong tone' });
  });

  it('r runs the selected Bot; K and p only act after confirmation', async () => {
    const t = open();
    await t.waitFor(/Mailer/);
    await t.press('j', 'r');
    await t.waitFor(/queued run_new/);
    expect(t.mock.runs.start).toHaveBeenCalledWith('bot_b');
    await t.press('K');
    await t.waitFor(/Engage the global kill switch\?/);
    await t.press('n');
    expect(t.mock.kill.set).not.toHaveBeenCalled();
    await t.press('K', KEYS.enter);
    await t.waitFor(/Cancelled/);
    expect(t.mock.kill.set).not.toHaveBeenCalled();
    await t.press('K', 'y');
    await t.waitFor(/kill switch engaged/);
    expect(t.mock.kill.set).toHaveBeenCalledWith(true);
    await t.press('p', 'y');
    await t.waitFor(/paused Notes/);
    expect(t.mock.bots.pause).toHaveBeenCalledWith('bot_b');
  });

  it('errors from orbitd show as a red toast, not a crash', async () => {
    const t = open();
    await t.waitFor(/Mailer/);
    t.mock.runs.start.mockRejectedValueOnce(new Error('The global kill switch is engaged'));
    await t.press('r');
    await t.waitFor(/kill switch is engaged/);
  });

  it('live events of the selected Run appear in the timeline', async () => {
    const t = open();
    await t.waitFor(/waiting for your approval/);
    const [resumed] = events('run_a2', 'bot_a', [
      { type: 'run.resumed', data: { reason: 'approval', sessionId: 's1' } },
    ]);
    t.push(resumed!);
    await t.waitFor(/resumed after approval/);
    // Lifecycle events refetch the lists.
    await new Promise((r) => setTimeout(r, 40));
    expect(t.mock.runs.list.mock.calls.length).toBeGreaterThan(1);
  });

  it('q quits', async () => {
    const t = open();
    await t.waitFor(/Mailer/);
    const exited = t.instance.waitUntilExit();
    await t.press('q');
    await exited;
  });
});

describe('runs outside Vitest', () => {
  it('every TUI source file sets the JSX runtime itself (tsx run from the repo root ignores the package tsconfig)', () => {
    const dir = import.meta.dirname;
    const missing = readdirSync(dir)
      .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
      .filter((f) => !readFileSync(join(dir, f), 'utf8').startsWith('/** @jsxRuntime automatic'));
    expect(missing).toEqual([]);
  });
});

describe('16-color terminals', () => {
  it('the TUI only uses the 16 basic ANSI colors', () => {
    const basic = new Set([
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'gray',
      'grey',
      'blackBright',
      'redBright',
      'greenBright',
      'yellowBright',
      'blueBright',
      'magentaBright',
      'cyanBright',
      'whiteBright',
    ]);
    const dir = import.meta.dirname;
    const used = readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))
      .flatMap((f) => [
        ...readFileSync(join(dir, f), 'utf8').matchAll(
          /(?:color|borderColor)[=:]\s*\{?\s*['"]([^'"]+)['"]/g,
        ),
      ])
      .map((m) => m[1]);
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((c) => !basic.has(c!))).toEqual([]);
  });
});

describe('untrusted text', () => {
  it('terminal escapes in model-written text cannot spoof the screen', async () => {
    const evil = '\u001b[2J\u001b[32m✔ approved by owner\u001b[0m‮evil';
    const card = approval('apr_1', {
      what: `send ${evil}`,
      why: evil,
      diff: `--- a/x\n+++ b/x\n+${evil}`,
    });
    const timeline = events('run_a2', 'bot_a', [
      { type: 'message.assistant', data: { messageId: null, text: evil, parentToolUseId: null } },
    ]);
    const fake = fakeClient(data({ approvals: [card] }), timeline);
    const t = renderTerminal(<App client={fake.client} paint={plain} />, WIDE);
    unmount = t.unmount;
    const frame = await t.waitFor(/approved by owner/);
    expect(frame).not.toContain('\u001b');
    expect(frame).not.toContain('‮');
    expect(frame).toContain('�');
  });
});

describe('small terminals', () => {
  it.each([
    { columns: 120, rows: 10 },
    { columns: 40, rows: 12 },
    { columns: 72, rows: 18 },
  ])('every frame fits $columns×$rows, overlays included', async (size) => {
    const t = open(size);
    await t.waitFor(/Mailer/);
    const fits = () => t.lastFrame().split('\n').length <= size.rows;
    expect(fits()).toBe(true);
    for (const keys of [
      ['?'],
      [KEYS.escape, 'K'],
      [KEYS.escape, '3', 'd', ...Array.from('too long a reason')],
    ]) {
      await t.press(...keys);
      await new Promise((r) => setTimeout(r, 30));
      expect(t.lastFrame().split('\n').length, t.lastFrame()).toBeLessThanOrEqual(size.rows);
    }
  });
});

describe('more untrusted text', () => {
  it('Bot names, untrusted sources and toasts are scrubbed too (conceal, OSC 52)', async () => {
    const conceal = '\u001b[8mHIDDEN\u001b[0m';
    const osc52 = '\u001b]52;c;ZXZpbA==\u0007';
    const card = approval('apr_1', { botName: `Mail${conceal}`, untrusted: [`web${osc52}`] });
    const fake = fakeClient(data({ approvals: [card] }));
    fake.mock.runs.start.mockRejectedValueOnce(new Error(`boom ${conceal}`));
    const t = renderTerminal(<App client={fake.client} paint={plain} />, WIDE);
    unmount = t.unmount;
    await t.waitFor(/untrusted input/);
    await t.press('1', 'r');
    await t.waitFor(/boom/);
    const frames = t.lastFrame();
    expect(frames).not.toContain('\u001b');
    expect(frames).not.toContain('\u0007');
  });
});
