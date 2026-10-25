/** @jsxRuntime automatic @jsxImportSource react */
import { harness } from '@orbit/api/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mountApp } from '../test/harness';

let m: Mounted | undefined;
afterEach(async () => {
  m?.unmount();
  await m?.h.close();
  m = undefined;
});

function localInstall() {
  return harness({
    service: {
      probes: {
        findClaude: () => Promise.resolve(null),
        cliStatus: () => Promise.reject(new Error('Claude Code is not installed')),
      },
    },
  });
}

const KEY = 'sk-ant-api03-orbit-web-onboarding-test-secret-123456';

describe('guided engine setup', () => {
  it('starts a fresh unconfigured install with the API and Sonnet selected', async () => {
    const h = harness({
      config: { driver: null },
      service: {
        probes: {
          findClaude: () => Promise.resolve(null),
          cliStatus: () => Promise.reject(new Error('Claude Code is not installed')),
        },
      },
    });
    m = mountApp('/welcome', { h });
    expect(
      (await screen.findByRole<HTMLInputElement>('radio', { name: /Anthropic API/ })).checked,
    ).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText<HTMLSelectElement>('Default model').value).toBe('sonnet');
    expect(screen.getByLabelText('Anthropic API key')).toBeTruthy();
  });

  it('connects a demo install to the API, saves the model and never sends a model request', async () => {
    const h = localInstall();
    m = mountApp('/welcome', { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Anthropic API key'), KEY);
    await user.selectOptions(screen.getByLabelText('Default model'), 'haiku');
    expect(screen.getByLabelText<HTMLInputElement>('Anthropic API key').value).toBe(KEY);
    await user.click(screen.getByRole('button', { name: 'Save API setup' }));
    expect(await screen.findByRole('heading', { name: 'Your engine is configured' })).toBeTruthy();
    expect(h.service.config.driver).toBe('sdk');
    expect(h.service.config.models.default).toBe('haiku');
    expect(h.service.store.listRuns()).toEqual([]);
    expect(screen.getByText(/Credentials are detected and haiku/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Try a demo chat/ })).toBeNull();
    expect(screen.queryByLabelText('Anthropic API key')).toBeNull();
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(KEY);
    expect(document.body.textContent).not.toContain(KEY);
    const status = await h.json('GET', '/v1/setup');
    expect(JSON.stringify(status.body)).not.toContain(KEY);
    expect(await screen.findByRole('button', { name: 'Create a Bot' })).toBeTruthy();
  });

  it('validates missing credentials and clears a rejected key before showing the error', async () => {
    const h = localInstall();
    m = mountApp('/welcome', { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Save API setup' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Enter your Anthropic API key'),
    );
    const input = screen.getByLabelText<HTMLInputElement>('Anthropic API key');
    await user.type(input, 'invalid-secret-key');
    await user.click(screen.getByRole('button', { name: 'Save API setup' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/valid Anthropic API key/),
    );
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain('invalid-secret-key');
    expect(h.service.config.driver).toBe('mock');
    expect(h.service.store.listRuns()).toEqual([]);
  });

  it('can remove a saved key only with an explicit choice to return to demo', async () => {
    const h = localInstall();
    await h.json('POST', '/v1/setup', { mode: 'api', model: 'sonnet', apiKey: KEY });
    m = mountApp('/settings?tab=engine', { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Try the demo/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const remove = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Remove the saved API key from Orbit',
    });
    expect(remove.checked).toBe(false);
    await user.click(remove);
    await user.click(screen.getByRole('button', { name: 'Remove key and use demo' }));
    expect(await screen.findByRole('heading', { name: 'Your demo is ready' })).toBeTruthy();
    const state = await h.json<{ apiKeyStored: boolean }>('GET', '/v1/setup');
    expect(state.body.apiKeyStored).toBe(false);
    expect(h.service.config.driver).toBe('mock');
    expect(h.service.store.listRuns()).toEqual([]);
  });

  it('clears an unsubmitted key when switching engines and starts demo work only on request', async () => {
    const h = localInstall();
    m = mountApp('/welcome', { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Anthropic API key'), KEY);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('radio', { name: /Try the demo/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByLabelText('Anthropic API key')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Use demo mode' }));
    expect(await screen.findByRole('heading', { name: 'Your demo is ready' })).toBeTruthy();
    expect(h.service.store.listRuns()).toEqual([]);
    await user.click(
      screen.getByRole('button', { name: 'Try a demo chat that asks for approval' }),
    );
    await waitFor(() => expect(h.service.bots.list()).toHaveLength(1));
    await waitFor(() => expect(h.service.store.listRuns()).toHaveLength(1));
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(KEY);
  });

  it('offers current ready setup when environment-managed settings cannot be changed', async () => {
    const h = harness({ env: { ORBIT_DRIVER: 'mock' } });
    m = mountApp('/welcome', { h });
    const user = userEvent.setup();
    expect((await screen.findByRole('button', { name: 'Continue' })).hasAttribute('disabled')).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Use current demo' }));
    expect(await screen.findByRole('heading', { name: 'Your demo is ready' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create a Bot' })).toBeTruthy();
    expect(screen.queryByText('Your choice is saved for future restarts.')).toBeNull();
  });

  it('keeps setup available in Settings and explains how to finish a Claude Code login', async () => {
    const h = localInstall();
    await h.json('POST', '/v1/bots', { name: 'Notes', goal: 'Help with notes' });
    m = mountApp('/settings?tab=engine', { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Existing Claude Code login/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('claude auth login')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check login and save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Claude Code is not ready/);
    expect(h.service.config.driver).toBe('mock');
  });

  it('explains owner-only setup without presenting credential fields to a viewer', async () => {
    m = mountApp('/settings?tab=engine', { role: 'viewer' });
    expect(await screen.findByText(/An Orbit owner connects the engine/)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Anthropic API/ })).toBeNull();
    expect(screen.queryByLabelText('Anthropic API key')).toBeNull();
  });
});
