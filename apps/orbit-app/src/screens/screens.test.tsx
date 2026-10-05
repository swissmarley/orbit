/** @jsxRuntime automatic @jsxImportSource react */
import { harness } from '@orbit/api/testing';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mountApp } from '../test/harness';

let m: Mounted | undefined;
afterEach(async () => {
  m?.unmount();
  await m?.h.close();
  m = undefined;
});

async function seeded() {
  const h = harness();
  await h.json('POST', '/v1/bots', {
    name: 'Notes',
    goal: 'Summarize notes',
    mock: { fixture: 'read-then-write-denied' },
  });
  await h.json('POST', '/v1/bots/notes/runs', {});
  await h.service.queue.idle();
  return h;
}

describe('Bots', () => {
  it('grid shows status in words; pausing asks first and offers to resume', async () => {
    const h = await seeded();
    m = mountApp('/bots', { h });
    const card = await screen.findByTestId('bot-card');
    expect(within(card).getByText('Notes')).toBeTruthy();
    expect(within(card).getAllByText(/done|failed/).length).toBeGreaterThan(0);
    expect(within(card).getByText(/1 run ·/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: 'Pause Notes' }));
    await user.click(await screen.findByRole('button', { name: /^Pause/ }));
    await waitFor(() => expect(h.service.bots.get('notes').pausedAt).not.toBeNull());
    await user.click(await screen.findByRole('button', { name: 'Resume Bot' }));
    await waitFor(() => expect(h.service.bots.get('notes').pausedAt).toBeNull());
  });

  it('the first run on an empty install goes to the welcome screen', async () => {
    m = mountApp('/');
    expect(await screen.findByText('Welcome to Orbit')).toBeTruthy();
    expect(await screen.findByText(/Demo mode/, { selector: 'p' })).toBeTruthy();
  });
});

describe('Run view', () => {
  it('shows the timeline with collapsed tool I/O and replays a prefix of the log', async () => {
    const h = await seeded();
    const [run] = h.service.store.listRuns({ limit: 1 });
    m = mountApp(`/runs/${run?.runId ?? ''}`, { h });
    const log = await screen.findByRole('log', { name: 'Run timeline' });
    await within(log).findByText('Task');
    const toggles = await within(log).findAllByRole('button', { expanded: false });
    expect(toggles.length).toBeGreaterThan(0);
    const slider = screen.getByRole('slider', { name: 'Replay position' });
    fireEvent.change(slider, { target: { value: '1' } });
    expect(await screen.findByText('replaying — not live')).toBeTruthy();
    expect(within(log).queryByText(/Completed|Failed/)).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: /Live/ }));
    await waitFor(() => expect(screen.queryByText('replaying — not live')).toBeNull());
  });

  it('stop asks first, then stops a parked run', async () => {
    const h = harness();
    await h.json('POST', '/v1/bots', {
      name: 'Mailer',
      goal: 'g',
      mock: { fixture: 'send-email' },
      approvals: { parkWindowSeconds: 0 },
    });
    const run = (await h.json<{ runId: string }>('POST', '/v1/bots/mailer/runs', {})).body;
    await h.service.queue.idle();
    m = mountApp(`/runs/${run.runId}`, { h });
    expect(await screen.findByText(/This run is waiting for you/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Stop$/ }));
    await user.click(await screen.findByRole('button', { name: /Stop run/ }));
    await waitFor(() => expect(h.service.store.getRun(run.runId)?.status).toBe('cancelled'));
  });
});

describe('Create Bot wizard', () => {
  it('goal → suggested setup → limits → review → a valid Bot', async () => {
    m = mountApp('/bots/new');
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole('textbox', { name: /What should this Bot achieve/ }),
      'Draft a digest of my notes every weekday at 9',
    );
    await user.click(screen.getByRole('button', { name: /Suggest a setup/ }));
    expect(await screen.findByText(/Suggested from your goal/)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Write/ }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Bash/ }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: /Cron/ }).value).toBe(
      '0 9 * * 1-5',
    );
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await user.click(screen.getByRole('button', { name: /Create Bot/ }));
    await waitFor(() => expect(m?.h.service.bots.list()).toHaveLength(1));
    const bot = m.h.service.bots.list()[0];
    expect(bot?.spec.triggers[0]).toMatchObject({ kind: 'cron', cron: '0 9 * * 1-5' });
    expect(bot?.spec.tools).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit']);
  });
});

describe('Settings', () => {
  it('adds and revokes a standing rule (with Undo)', async () => {
    m = mountApp('/settings?tab=policies');
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole('textbox', { name: 'Tool' }),
      'mcp__slack__post_message',
    );
    await user.click(screen.getByRole('button', { name: /Add/ }));
    await waitFor(() => expect(m?.h.service.rules.list()).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: /Revoke the rule/ }));
    await waitFor(() => expect(m?.h.service.rules.list()).toHaveLength(0));
    const undo = await screen.findAllByRole('button', { name: 'Undo' });
    await user.click(undo.at(-1)!);
    await waitFor(() => expect(m?.h.service.rules.list()).toHaveLength(1));
  });

  it('shows the engine: driver, auth and models', async () => {
    m = mountApp('/settings?tab=engine');
    expect(await screen.findByText('Auth & driver')).toBeTruthy();
    expect(screen.getByText(/set by ORBIT_DRIVER|chosen automatically/)).toBeTruthy();
  });
});
