/** @jsxRuntime automatic @jsxImportSource react */
import { afterEach, describe, expect, it } from 'vitest';
import { data, fakeClient } from '../../test/tui-fixtures';
import { KEYS, renderTerminal } from '../../test/render';
import { App } from './app';
import { INITIAL_UI, type Ui, onKey } from './model';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('terminal engine setup', () => {
  it('opens from any pane, changes modes, validates fields and clears keys before saving', () => {
    const d = data();
    let ui: Ui = onKey({ ...INITIAL_UI, focus: 'approvals' }, d, 'O', {}).ui;
    expect(ui.overlay).toMatchObject({ kind: 'setup', busy: true });
    if (ui.overlay?.kind !== 'setup') throw new Error('setup not opened');
    ui = {
      ...ui,
      overlay: {
        ...ui.overlay,
        busy: false,
        status: {
          canConfigure: true,
          apiKeyStored: false,
          reason: null,
          doctor: { apiCredential: null },
        } as never,
      },
    };
    ui = onKey(ui, d, '1', {}).ui;
    expect(onKey(ui, d, 's', { ctrl: true }).ui.toast?.text).toMatch(/API key/);
    ui = onKey(ui, d, '', { tab: true }).ui;
    ui = onKey(ui, d, '', { tab: true }).ui;
    ui = onKey(ui, d, 'sk-ant-secret', {}).ui;
    const saved = onKey(ui, d, 's', { ctrl: true });
    expect(saved.command).toEqual({
      kind: 'configureSetup',
      body: { mode: 'api', model: 'sonnet', apiKey: 'sk-ant-secret' },
    });
    expect(saved.ui.overlay).toMatchObject({ apiKey: '', busy: true });
    const closed = onKey(ui, d, '', { escape: true });
    expect(closed.ui.overlay).toBeNull();
    expect(closed.command).toBeUndefined();
  });

  it('switching mode discards a typed key and input never triggers global shortcuts', () => {
    const d = data();
    const ui: Ui = {
      ...INITIAL_UI,
      overlay: {
        kind: 'setup',
        mode: 'api',
        model: 'sonnet',
        apiKey: 'secret',
        field: 'apiKey',
        busy: false,
        status: null,
      },
    };
    expect(onKey(ui, d, 'q', {}).command).toBeUndefined();
    const changed = onKey(
      { ...ui, overlay: { ...ui.overlay!, field: 'mode' } as never },
      d,
      '3',
      {},
    );
    expect(changed.ui.overlay).toMatchObject({ mode: 'demo', apiKey: '' });
  });

  it('renders a masked API key, saves via the API and shows readiness without a model run', async () => {
    const fake = fakeClient(data());
    const terminal = renderTerminal(<App client={fake.client} paint={(_s, value) => value} />, {
      columns: 90,
      rows: 24,
    });
    cleanup = terminal.unmount;
    await terminal.waitFor(/Mailer/);
    await terminal.press('O');
    await terminal.waitFor(/Current engine: Demo/);
    await terminal.press('1', KEYS.tab, KEYS.tab, 'sk-ant-secret-for-test');
    const frame = await terminal.waitFor(/\*{10}/);
    expect(frame).not.toContain('sk-ant-secret-for-test');
    await terminal.press('\u0013');
    await terminal.waitFor(/Setup saved/);
    expect(fake.mock.call).toHaveBeenCalledWith('configureSetup', {
      body: { mode: 'api', model: 'sonnet', apiKey: 'sk-ant-secret-for-test' },
    });
    expect(fake.mock.runs.start).not.toHaveBeenCalled();
    expect(terminal.lastFrame()).not.toContain('sk-ant-secret-for-test');
  });
});
