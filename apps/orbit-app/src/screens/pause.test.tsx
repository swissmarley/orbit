/** @jsxRuntime automatic @jsxImportSource react */
import { event } from '@orbit/core/browser';
import { harness } from '@orbit/api/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mountApp } from '../test/harness';

/** ADR-016 in the App: pause and resume a Run, and the take-over command. */

let m: Mounted | undefined;
afterEach(async () => {
  m?.unmount();
  await m?.h.close();
  m = undefined;
});

async function noA11yViolations(root: Element) {
  // WCAG 2.1 AA, as the e2e suite checks (contrast is checked there, in real browsers).
  const r = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });
  expect(
    r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

describe('Run view: pause', () => {
  it('Pause run parks the running Run at its next tool call; the paused state says why; Resume continues', async () => {
    const h = harness({ service: { mock: { delayMs: 60 } } });
    await h.json('POST', '/v1/bots', {
      name: 'Reader',
      goal: 'Read the notes',
      mock: { fixture: 'many-reads' },
    });
    const run = (await h.json<{ runId: string }>('POST', '/v1/bots/reader/runs', {})).body;
    m = mountApp(`/runs/${run.runId}`, { h });
    const user = userEvent.setup();
    const pause = await screen.findByRole('button', { name: /Pause run/ });
    expect(screen.getByRole('button', { name: 'Pause now' })).toBeTruthy();
    await user.click(pause);
    await waitFor(() => expect(h.service.store.getRun(run.runId)?.status).toBe('paused'), {
      timeout: 5000,
    });
    const banner = await screen.findByTestId('pause-banner');
    expect(banner.textContent).toMatch(/Paused by you before Read ran\./);
    expect(banner.textContent).toMatch(/Resume it to continue, or stop it\./);
    expect(screen.getAllByText('paused').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Pause run/ })).toBeNull();
    await noA11yViolations(document.body);
    await user.click(screen.getByRole('button', { name: /Resume run/ }));
    await waitFor(() => expect(h.service.store.getRun(run.runId)?.status).toBe('completed'), {
      timeout: 5000,
    });
  }, 15_000);

  it('an interrupted Run that waits for the owner names the call whose outcome is unknown', async () => {
    const h = harness();
    await h.json('POST', '/v1/bots', { name: 'Mailer', goal: 'g', mock: { fixture: 'pong' } });
    const queued = h.service.orchestrator.enqueue('mailer');
    h.service.store.append(queued.runId, queued.botId, [
      event('run.started', {
        driver: 'mock',
        authMethod: 'mock',
        model: null,
        cwd: h.home,
        resumeSessionId: null,
      }),
      event('run.paused', {
        reason: 'interrupted',
        by: 'system',
        sessionId: 's1',
        interruptedTurn: true,
        toolUseId: 't9',
        toolName: 'mcp__gmail__send_email',
        detail:
          'mcp__gmail__send_email (t9) was allowed but has no result, so it may or may not have happened',
      }),
    ]);
    m = mountApp(`/runs/${queued.runId}`, { h });
    const banner = await screen.findByTestId('pause-banner');
    expect(banner.textContent).toMatch(/Interrupted when orbitd stopped and needs you/);
    expect(banner.textContent).toMatch(/mcp__gmail__send_email \(t9\)/);
    expect(banner.textContent).toMatch(/Check the outcome yourself/);
    expect(await screen.findByRole('button', { name: /Resume run/ })).toBeTruthy();
  });
});

describe('Take over', () => {
  it('shows the exact terminal command with a copy button and why the browser opens no shell', async () => {
    const h = harness();
    await h.json('POST', '/v1/bots', {
      name: 'Release Notes',
      goal: 'g',
      mock: { fixture: 'pong' },
    });
    m = mountApp('/bots/release-notes', { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Take over Release Notes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Take over Release Notes' });
    expect(within(dialog).getByTestId('takeover-command').textContent).toBe(
      'orbit shell release-notes',
    );
    expect(dialog.textContent).toMatch(/would bypass Orbit's policy engine/);
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe('orbit shell release-notes');
    expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeTruthy();
    await noA11yViolations(document.body);
    // Nothing was taken over: the browser only shows the command.
    expect(h.service.controls.takeover(h.service.bots.get('release-notes').id)).toBeNull();
  });
});
