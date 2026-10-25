import { describe, expect, it, vi } from 'vitest';
import type { OrbitClient } from '@orbit/sdk-client';
import { Context } from '../context';
import type { Io } from '../io';
import { setup } from './setup';

function harness(options: { interactive?: boolean; saved?: boolean; blocked?: boolean } = {}) {
  const out: string[] = [];
  const state = {
    doctor: {
      driver: 'mock',
      authLabel: 'Demo mode',
      ok: true,
      models: { default: 'sonnet' },
      apiCredential: null,
    },
    apiKeyStored: options.saved ?? false,
    canConfigure: !options.blocked,
    reason: options.blocked ? 'Stop active Runs before changing engines.' : null,
  };
  const call = vi.fn(() => Promise.resolve(state));
  const ask = vi.fn<(question: string) => Promise<string>>();
  const askSecret = vi.fn<(question: string) => Promise<string>>();
  const io: Io = {
    out: (line) => out.push(line),
    err: () => undefined,
    env: { ORBIT_HOME: '/tmp/orbit-setup-test' },
    color: false,
    interactive: options.interactive ?? false,
    ask,
    askSecret,
    onInterrupt: () => () => undefined,
  };
  const ctx = new Context(io);
  vi.spyOn(ctx, 'client').mockResolvedValue({ call } as unknown as OrbitClient);
  return { ctx, out, call, ask, askSecret, state };
}

describe('orbit setup', () => {
  it('reports status without changing the engine or prompting in --json mode', async () => {
    const h = harness({ interactive: true });
    expect(await setup(h.ctx, { json: true })).toBe(0);
    expect(h.call).toHaveBeenCalledTimes(1);
    expect(h.call).toHaveBeenCalledWith('getSetup');
    expect(JSON.parse(h.out.join('\n'))).toEqual(h.state);
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.askSecret).not.toHaveBeenCalled();
  });

  it('guides an interactive user and reads the key only through a hidden prompt', async () => {
    const h = harness({ interactive: true });
    h.ask.mockResolvedValueOnce('1').mockResolvedValueOnce('');
    h.askSecret.mockResolvedValueOnce('sk-ant-setup-private');
    expect(await setup(h.ctx, {})).toBe(0);
    expect(h.askSecret).toHaveBeenCalledOnce();
    expect(h.call).toHaveBeenLastCalledWith('configureSetup', {
      body: { mode: 'api', model: 'sonnet', apiKey: 'sk-ant-setup-private' },
    });
    expect(h.out.join('\n')).not.toContain('sk-ant-setup-private');
    expect(h.out.join('\n')).toContain('No model calls or charges');
  });

  it('supports a piped key without placing it in output or needing an interactive terminal', async () => {
    const h = harness();
    await setup(h.ctx, {
      mode: 'api',
      model: 'haiku',
      apiKeyStdin: true,
      stdin: () => 'sk-ant-piped\n',
      json: true,
    });
    expect(h.call).toHaveBeenLastCalledWith('configureSetup', {
      body: { mode: 'api', model: 'haiku', apiKey: 'sk-ant-piped' },
    });
    expect(h.out.join('\n')).not.toContain('sk-ant-piped');
    expect(h.askSecret).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing key when the hidden prompt is left blank', async () => {
    const h = harness({ interactive: true, saved: true });
    h.ask.mockResolvedValueOnce('sonnet');
    h.askSecret.mockResolvedValueOnce('');
    await setup(h.ctx, { mode: 'api' });
    expect(h.call).toHaveBeenLastCalledWith('configureSetup', {
      body: { mode: 'api', model: 'sonnet' },
    });
  });

  it('validates mode, empty keys and a blocked server before attempting a save', async () => {
    const invalid = harness();
    await expect(setup(invalid.ctx, { mode: 'unknown' })).rejects.toThrow(
      'Choose api, cli or demo',
    );
    const empty = harness();
    await expect(
      setup(empty.ctx, { mode: 'api', apiKeyStdin: true, stdin: () => '\n' }),
    ).rejects.toThrow('empty');
    const blocked = harness({ blocked: true });
    await expect(setup(blocked.ctx, { mode: 'demo' })).rejects.toThrow('Stop active Runs');
    expect(blocked.call).toHaveBeenCalledTimes(1);
    const wrongInput = harness();
    await expect(setup(wrongInput.ctx, { mode: 'demo', apiKeyStdin: true })).rejects.toThrow(
      'requires --mode api',
    );
    expect(wrongInput.call).not.toHaveBeenCalled();
  });

  it('cancels without changing configuration', async () => {
    const h = harness({ interactive: true });
    h.ask.mockResolvedValueOnce('q');
    await setup(h.ctx, {});
    expect(h.call).toHaveBeenCalledTimes(1);
    expect(h.out.join('\n')).toContain('Setup cancelled');
  });

  it('only removes a saved key on an explicit Demo request', async () => {
    const h = harness({ saved: true });
    await setup(h.ctx, { mode: 'demo', forgetApiKey: true, json: true });
    expect(h.call).toHaveBeenLastCalledWith('configureSetup', {
      body: { mode: 'demo', model: 'sonnet', forgetApiKey: true },
    });
    const invalid = harness();
    await expect(setup(invalid.ctx, { mode: 'api', forgetApiKey: true })).rejects.toThrow(
      'requires --mode demo',
    );
    expect(invalid.call).not.toHaveBeenCalled();
  });
});
