import { describe, expect, it } from 'vitest';
import { approval, bot, data, inbound, memories, plugins, run } from '../../test/tui-fixtures';
import {
  INITIAL_UI,
  type KeyInfo,
  type Ui,
  onKey,
  reconcile,
  selectedRun,
  treeRows,
} from './model';

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

  it('r runs the selected Bot; p asks before pausing; only y confirms', () => {
    expect(press(INITIAL_UI, 'r').command).toEqual({ kind: 'runBot', botId: 'bot_a' });
    const p = press(INITIAL_UI, 'p');
    expect(p.command).toBeUndefined();
    expect(p.ui.overlay).toMatchObject({
      kind: 'confirm',
      command: { kind: 'pauseBot', botId: 'bot_a', paused: true },
    });
    expect(press(p.ui, 'y').command).toEqual({ kind: 'pauseBot', botId: 'bot_a', paused: true });
    // [y/N]: Enter, n, Esc and any other key cancel.
    for (const [input, key] of [
      ['', { return: true }],
      ['n', {}],
      ['x', {}],
      ['', { escape: true }],
    ] as const) {
      const r = press(p.ui, input, key);
      expect(r.command).toBeUndefined();
      expect(r.ui.overlay).toBeNull();
    }
  });

  it('approving always goes through the whole card; A asks (y only); d prompts for a reason', () => {
    const ui: Ui = { ...INITIAL_UI, focus: 'approvals' };
    const opened = press(ui, 'a');
    expect(opened.command).toBeUndefined();
    expect(opened.ui.overlay).toEqual({ kind: 'card', approvalId: 'apr_1', scroll: 0 });
    expect(press(ui, '', { return: true }).ui.overlay).toMatchObject({ kind: 'card' });
    expect(press(opened.ui, 'j').ui.overlay).toMatchObject({ scroll: 1 });
    expect(press(opened.ui, 'a').command).toEqual({
      kind: 'approve',
      approvalId: 'apr_1',
      always: false,
    });
    const always = press(opened.ui, 'A');
    expect(always.ui.overlay).toMatchObject({ kind: 'confirm', message: /with any arguments/ });
    expect(press(always.ui, '', { return: true }).command).toBeUndefined();
    expect(press(always.ui, 'y').command).toEqual({
      kind: 'approve',
      approvalId: 'apr_1',
      always: true,
    });
    expect(press(opened.ui, '', { escape: true }).ui.overlay).toBeNull();
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

  it('a card replaced under the cursor is never acted on by the next key (selection by id)', () => {
    const two = data({ approvals: [approval('apr_1'), approval('apr_2')] });
    let ui = reconcile({ ...INITIAL_UI, focus: 'approvals' }, two);
    expect(ui).toMatchObject({ approvalId: 'apr_1', approvalMoved: false });
    // apr_1 is decided elsewhere: the cursor lands on apr_2, flagged.
    ui = reconcile(ui, data({ approvals: [approval('apr_2')] }));
    expect(ui).toMatchObject({ approvalId: 'apr_2', approvalIndex: 0, approvalMoved: true });
    const ignored = press(ui, 'a', {}, data({ approvals: [approval('apr_2')] }));
    expect(ignored.ui.overlay).toBeNull();
    expect(ignored.ui.toast?.text).toMatch(/selected card changed/);
    expect(
      press(ignored.ui, 'a', {}, data({ approvals: [approval('apr_2')] })).ui.overlay,
    ).toMatchObject({
      kind: 'card',
      approvalId: 'apr_2',
    });
    // A card inserted above keeps the selection on the same card.
    const shifted = reconcile(
      { ...ui, approvalMoved: false },
      data({ approvals: [approval('apr_0'), approval('apr_2')] }),
    );
    expect(shifted).toMatchObject({ approvalId: 'apr_2', approvalIndex: 1, approvalMoved: false });
    // An open card closes when its approval disappears.
    const open: Ui = { ...shifted, overlay: { kind: 'card', approvalId: 'apr_2', scroll: 0 } };
    expect(reconcile(open, data({ approvals: [approval('apr_0')] })).overlay).toBeNull();
  });

  it('a pane-specific key elsewhere says where it works', () => {
    expect(press(INITIAL_UI, 'a').ui.toast?.text).toMatch(/Approvals — press 3/);
    expect(press({ ...INITIAL_UI, focus: 'approvals' }, 'r').ui.toast?.text).toMatch(/Bots pane/);
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

  it('timeline: P pauses a running Run (no confirmation); other states say why not', () => {
    const ui: Ui = { ...INITIAL_UI, focus: 'timeline' };
    const runningData = data({
      runs: [run('run_a2', 'bot_a', 'running'), run('run_a1', 'bot_a', 'completed')],
    });
    expect(press(ui, 'P', {}, runningData).command).toEqual({
      kind: 'pauseRun',
      runId: 'run_a2',
    });
    const parked = press(ui, 'P');
    expect(parked.command).toBeUndefined();
    expect(parked.ui.toast?.text).toMatch(/Only a running Run can be paused/);
    const pausedData = data({ runs: [run('run_a2', 'bot_a', 'paused')] });
    expect(press(ui, 'P', {}, pausedData).ui.toast?.text).toMatch(/u resumes it/);
    expect(press(ui, 'u', {}, pausedData).command).toEqual({
      kind: 'resumeRun',
      runId: 'run_a2',
    });
    // Elsewhere, P says where it works.
    expect(press(INITIAL_UI, 'P', {}, runningData).ui.toast?.text).toMatch(/press 2/);
  });

  it('help overlay opens with ? and swallows keys until closed', () => {
    const help = press(INITIAL_UI, '?').ui;
    expect(help.overlay).toEqual({ kind: 'help', scroll: 0 });
    expect(press(help, 'j').ui.overlay).toEqual({ kind: 'help', scroll: 1 });
    expect(press(help, 'r').command).toBeUndefined();
    expect(press(help, '', { escape: true }).ui.overlay).toBeNull();
  });

  it('q and Ctrl-C quit', () => {
    expect(press(INITIAL_UI, 'q').command).toEqual({ kind: 'quit' });
    expect(press(INITIAL_UI, 'c', { ctrl: true }).command).toEqual({ kind: 'quit' });
  });

  it('the Bot selection follows its id when Bots are added or removed', () => {
    const d = data();
    const ui = reconcile(press(INITIAL_UI, 'j', {}, d).ui, d);
    const picked = ui.botId;
    expect(picked).not.toBeNull();
    // A new Bot sorted before it: the cursor stays on the same Bot, not the same row.
    const grown = data({ bots: [bot('bot_0', 'Aardvark'), ...d.bots] });
    const after = reconcile(ui, grown);
    expect(after.botId).toBe(picked);
    expect(grown.bots[after.botIndex]?.id).toBe(picked);
    // The selected Bot disappears: the cursor stays at its row and the Run selection resets.
    const shrunk = data({ bots: d.bots.filter((b) => b.id !== picked) });
    const gone = reconcile({ ...after, runIndex: 2 }, shrunk);
    expect(gone.botId).not.toBe(picked);
    expect(gone.runIndex).toBe(0);
  });

  it('an older Run picked with [ stays selected when a new Run arrives', () => {
    const d = data();
    let ui = reconcile(press(INITIAL_UI, '[', {}, d).ui, d);
    const picked = selectedRun(d, ui)?.runId;
    expect(picked).toBe('run_a1');
    const botId = d.bots[0]?.id ?? '';
    const grown = data({ runs: [run('run_new', botId, 'running'), ...d.runs] });
    ui = reconcile(ui, grown);
    expect(selectedRun(grown, ui)?.runId).toBe(picked);
    // On the newest Run (index 0) the selection follows new Runs.
    const top = reconcile(INITIAL_UI, grown);
    expect(selectedRun(grown, top)?.runId).toBe('run_new');
  });

  it('reconcile keeps selections valid when data shrinks', () => {
    const ui: Ui = { ...INITIAL_UI, botIndex: 2, runIndex: 4, approvalIndex: 3 };
    const d = data({ bots: [bot('bot_a', 'Alpha')], approvals: [approval('apr_1')] });
    expect(reconcile(ui, d)).toMatchObject({ botIndex: 0, runIndex: 1, approvalIndex: 0 });
    const settled = reconcile(INITIAL_UI, data());
    expect(reconcile(settled, data())).toBe(settled);
    expect(run('x', 'bot_a', 'queued').status).toBe('queued');
  });
});

describe('M6: memory browser, delegation tree, feedback', () => {
  const withMem = (over = {}) => data({ memories: memories(), memoryBot: 'bot_a', ...over });
  const openMemory = () => press(INITIAL_UI, 'm', {}, withMem());

  it('m opens the selected Bot’s memory and loads it; elsewhere it says where it works', () => {
    const r = openMemory();
    expect(r.ui.overlay).toMatchObject({ kind: 'memory', botId: 'bot_a', index: 0, open: false });
    expect(r.command).toEqual({ kind: 'loadMemory', botId: 'bot_a', query: '' });
    expect(press({ ...INITIAL_UI, focus: 'approvals' }, 'm').ui.toast?.text).toMatch(/Bots pane/);
  });

  it('j/k select, Enter opens a memory, Esc goes back then closes', () => {
    const d = withMem();
    let ui = openMemory().ui;
    ui = press(ui, 'j', {}, d).ui;
    ui = press(ui, 'j', {}, d).ui;
    ui = press(ui, 'j', {}, d).ui;
    expect(ui.overlay).toMatchObject({ index: 2 });
    ui = press(ui, '', { return: true }, d).ui;
    expect(ui.overlay).toMatchObject({ open: true });
    ui = press(ui, 'j', {}, d).ui;
    expect(ui.overlay).toMatchObject({ open: true, scroll: 1, index: 2 });
    ui = press(ui, '', { escape: true }, d).ui;
    expect(ui.overlay).toMatchObject({ open: false });
    expect(press(ui, '', { escape: true }, d).ui.overlay).toBeNull();
  });

  it('/ searches the full text', () => {
    const d = withMem();
    let ui = press(openMemory().ui, '/', {}, d).ui;
    for (const c of 'launch') ui = press(ui, c, {}, d).ui;
    expect(ui.overlay).toMatchObject({ search: 'launch' });
    const r = press(ui, '', { return: true }, d);
    expect(r.ui.overlay).toMatchObject({ search: null, query: 'launch', index: 0 });
    expect(r.command).toEqual({ kind: 'loadMemory', botId: 'bot_a', query: 'launch' });
  });

  it('x deletes after an explicit y and returns to the browser', () => {
    const d = withMem();
    const asked = press(openMemory().ui, 'x', {}, d);
    expect(asked.ui.overlay).toMatchObject({ kind: 'confirm' });
    const yes = press(asked.ui, 'y', {}, d);
    expect(yes.command).toEqual({ kind: 'deleteMemory', memoryId: 'mem_1' });
    expect(yes.ui.overlay).toMatchObject({ kind: 'memory' });
    const no = press(asked.ui, '', { return: true }, d);
    expect(no.command).toBeUndefined();
    expect(no.ui.overlay).toMatchObject({ kind: 'memory' });
  });

  it('T reviews an untrusted memory (asks); P pins only trusted ones', () => {
    const d = withMem();
    const onRumour = press(openMemory().ui, 'j', {}, d).ui;
    const t = press(onRumour, 'T', {}, d);
    expect(t.ui.overlay).toMatchObject({
      kind: 'confirm',
      command: { kind: 'updateMemory', memoryId: 'mem_2', patch: { trusted: true } },
    });
    const pin = press(onRumour, 'P', {}, d);
    expect(pin.command).toBeUndefined();
    expect(pin.ui.toast?.text).toMatch(/Only trusted/);
    expect(press(openMemory().ui, 'P', {}, d).command).toEqual({
      kind: 'updateMemory',
      memoryId: 'mem_1',
      patch: { pinned: true },
    });
  });

  it('e edits title and text; Tab switches; Ctrl-S saves; Esc cancels', () => {
    const d = withMem();
    let ui = press(openMemory().ui, 'e', {}, d).ui;
    expect(ui.overlay).toMatchObject({ kind: 'memoryEdit', field: 'title', title: 'Launch owner' });
    ui = press(ui, '', { backspace: true }, d).ui;
    ui = press(ui, 'R', {}, d).ui;
    ui = press(ui, '', { tab: true }, d).ui;
    ui = press(ui, '', { return: true }, d).ui;
    ui = press(ui, 'x', {}, d).ui;
    expect(ui.overlay).toMatchObject({ field: 'body', title: 'Launch owneR' });
    const saved = press(ui, 's', { ctrl: true }, d);
    expect(saved.command).toEqual({
      kind: 'updateMemory',
      memoryId: 'mem_1',
      patch: { title: 'Launch owneR', body: 'Ada owns the launch.\nIt opens Tuesday.\nx' },
    });
    expect(saved.ui.overlay).toMatchObject({ kind: 'memory' });
    // Esc with changes asks; any key but y returns to the editor.
    const esc = press(ui, '', { escape: true }, d);
    expect(esc.command).toBeUndefined();
    expect(esc.ui.overlay).toMatchObject({ kind: 'confirm', message: /Discard/ });
    expect(press(esc.ui, 'n', {}, d).ui.overlay).toMatchObject({ kind: 'memoryEdit' });
    expect(press(esc.ui, 'y', {}, d).ui.overlay).toMatchObject({ kind: 'memory' });
  });

  it('the editor has a cursor: arrows move it, typing inserts there', () => {
    const d = withMem();
    let ui = press(openMemory().ui, 'e', {}, d).ui;
    ui = press(ui, '', { tab: true }, d).ui; // body, cursor at the end
    ui = press(ui, '', { upArrow: true }, d).ui; // to line 1
    for (let i = 0; i < 30; i++) ui = press(ui, '', { leftArrow: true }, d).ui;
    ui = press(ui, '>', {}, d).ui;
    expect(ui.overlay).toMatchObject({
      body: '>Ada owns the launch.\nIt opens Tuesday.',
      cursor: 1,
    });
    ui = press(ui, '', { backspace: true }, d).ui;
    ui = press(ui, '', { downArrow: true }, d).ui;
    ui = press(ui, '!', {}, d).ui;
    expect(ui.overlay).toMatchObject({ body: 'Ada owns the launch.\n!It opens Tuesday.' });
  });

  it('no key acts on a memory before this Bot’s list has loaded', () => {
    const d = data({ memories: memories(), memoryBot: 'bot_b' });
    const ui = press(INITIAL_UI, 'm', {}, d).ui;
    expect(press(ui, 'x', {}, d).ui.overlay).toMatchObject({ kind: 'memory' });
    expect(press(ui, 'e', {}, d).ui.overlay).toMatchObject({ kind: 'memory' });
  });

  it('? opens the help over the browser and goes back to it; Esc stops the watch', () => {
    const d = withMem();
    const ui = openMemory().ui;
    const help = press(ui, '?', {}, d).ui;
    expect(help.overlay).toMatchObject({ kind: 'help' });
    expect(press(help, '', { escape: true }, d).ui.overlay).toMatchObject({ kind: 'memory' });
    expect(press(ui, '', { escape: true }, d).command).toEqual({
      kind: 'loadMemory',
      botId: null,
      query: '',
    });
  });

  it('t shows the delegation tree of the selected Run and stops following it on close', () => {
    const ui = { ...INITIAL_UI, focus: 'timeline' as const };
    const r = press(ui, 't');
    expect(r.ui.overlay).toMatchObject({ kind: 'tree', runId: 'run_a2' });
    expect(r.command).toEqual({ kind: 'loadTree', runId: 'run_a2' });
    expect(press(r.ui, '', { escape: true }).command).toEqual({ kind: 'loadTree', runId: null });
  });

  it('+ and - rate a finished Run; a running one is refused', () => {
    const ui = { ...INITIAL_UI, focus: 'timeline' as const, botIndex: 1, botId: 'bot_b' };
    expect(press(ui, '+').command).toEqual({ kind: 'feedback', runId: 'run_b1', rating: 'up' });
    expect(press(ui, '-').command).toEqual({ kind: 'feedback', runId: 'run_b1', rating: 'down' });
    const parked = press({ ...ui, botIndex: 0, botId: 'bot_a' }, '+');
    expect(parked.command).toBeUndefined();
    expect(parked.ui.toast?.text).toMatch(/once it has ended/);
  });

  it('i opens integrations; j/k select; Enter opens; e asks before enabling; Esc closes', () => {
    const d = { ...data(), plugins: plugins(), inbound: inbound() };
    let r = onKey(INITIAL_UI, d, 'i', {});
    expect(r.ui.overlay).toEqual({ kind: 'integrations', index: 0, open: false, scroll: 0 });
    expect(r.command).toEqual({ kind: 'loadIntegrations', on: true });
    r = onKey(r.ui, d, 'j', {});
    expect(r.ui.overlay).toMatchObject({ index: 1 });
    r = onKey(r.ui, d, 'j', {});
    expect(r.ui.overlay).toMatchObject({ index: 1 });
    r = onKey(r.ui, d, '', { return: true });
    expect(r.ui.overlay).toMatchObject({ kind: 'integrations', open: true });
    r = onKey(r.ui, d, 'e', {});
    expect(r.ui.overlay?.kind === 'confirm' && r.ui.overlay.message).toMatch(
      /^Enable Filesystem\?/,
    );
    expect(r.command).toBeUndefined();
    const yes = onKey(r.ui, d, 'y', {});
    expect(yes.command).toEqual({ kind: 'setPlugin', pluginId: 'filesystem', enabled: true });
    expect(yes.ui.overlay).toMatchObject({ kind: 'integrations', index: 1 });
    // Any other key cancels, back to the overlay.
    expect(onKey(r.ui, d, 'n', {}).command).toBeUndefined();
    // Esc in a plugin's detail goes back to the list; Esc in the list closes.
    const back = onKey(yes.ui, d, '', { escape: true });
    expect(back.ui.overlay).toMatchObject({ kind: 'integrations', open: false });
    const closed = onKey(back.ui, d, '', { escape: true });
    expect(closed.ui.overlay).toBeNull();
    expect(closed.command).toEqual({ kind: 'loadIntegrations', on: false });
    // Disabling an enabled plugin asks too.
    const first = onKey(onKey(INITIAL_UI, d, 'i', {}).ui, d, 'e', {});
    expect(first.ui.overlay?.kind === 'confirm' && first.ui.overlay.message).toMatch(
      /^Disable GitHub\?/,
    );
  });

  it('treeRows draws the tree with statuses in words and marks this Run', () => {
    const parent = {
      ...run('run_a1', 'bot_a', 'completed'),
      children: [
        { runId: 'run_b1', botId: 'bot_b', botName: 'Notes', status: 'completed' as const },
      ],
    };
    const child = run('run_b1', 'bot_b', 'running');
    const rows = treeRows(
      { root: 'run_a1', runs: [parent, child] },
      (id) => (id === 'bot_a' ? 'Mailer' : 'Notes'),
      'run_b1',
    );
    expect(rows.map((r) => r.text)).toEqual([
      '✔ done  Mailer  run_a1',
      '└─ ● running  Notes  run_b1  ← this run',
    ]);
    expect(rows[1]?.current).toBe(true);
  });
});
