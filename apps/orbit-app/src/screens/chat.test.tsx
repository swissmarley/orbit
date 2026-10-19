/** @jsxRuntime automatic @jsxImportSource react */
import { type Harness, harness } from '@orbit/api/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computerOpenStore,
  computerPathStore,
  computerSheetStore,
  computerTabStore,
  drawerStore,
  lastBotStore,
  sidebarCollapsedStore,
} from '../lib/ui';
import { type Mounted, mountApp } from '../test/harness';

/**
 * The chat-first App (ADR-020): talk to a Bot, see its work as cards, decide
 * its requests in the conversation, and look at its computer.
 */

let m: Mounted | undefined;
afterEach(async () => {
  m?.unmount();
  await m?.h.close();
  m = undefined;
  // Stores outlive a mounted App.
  computerOpenStore.set(false);
  computerSheetStore.set(false);
  computerTabStore.set('activity');
  computerPathStore.set(null);
  lastBotStore.set('');
  drawerStore.set(false);
  sidebarCollapsedStore.set(false);
});

async function noA11yViolations(root: Element) {
  const r = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });
  expect(
    r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

async function bot(h: Harness, name: string, fixture: string, extra: Record<string, unknown> = {}) {
  const r = await h.json<{ id: string }>('POST', '/v1/bots', {
    name,
    goal: 'Help me with the launch',
    mock: { fixture },
    approvals: { parkWindowSeconds: 0 },
    ...extra,
  });
  return r.body.id;
}

describe('chat', () => {
  it('home opens the chat; a message starts a conversation, a reply continues it', async () => {
    const h = harness();
    const id = await bot(h, 'Scout', 'pong');
    m = mountApp('/', { h });
    expect(await screen.findByRole('heading', { name: 'What should Scout do?' })).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Message Scout' }), 'Hello there{Enter}');
    await waitFor(() => expect(h.service.store.listRuns({ botId: id })).toHaveLength(1));
    const first = h.service.store.listRuns({ botId: id })[0];
    expect(first?.prompt).toBe('Hello there');
    await h.service.queue.idle();
    const log = await screen.findByRole('log', { name: 'Conversation with Scout' });
    expect(await within(log).findByText('Hello there')).toBeTruthy();
    expect(await within(log).findByText('pong')).toBeTruthy();
    await waitFor(() => expect(window.location.search).toContain(`c=${first?.runId ?? ''}`));

    await user.type(screen.getByRole('textbox', { name: 'Message Scout' }), 'And now?{Enter}');
    await waitFor(() =>
      expect(h.service.store.listRuns({ conversationId: first?.runId ?? '' })).toHaveLength(2),
    );
    const reply = h.service.store
      .listRuns({ conversationId: first?.runId ?? '' })
      .find((r) => r.runId !== first?.runId);
    expect(reply).toMatchObject({ prompt: 'And now?', continuesRunId: first?.runId });
    expect(await within(log).findByText('And now?')).toBeTruthy();
    await noA11yViolations(document.body);
  });

  it('a request appears in the chat as the full card and is decided there', async () => {
    const h = harness();
    const id = await bot(h, 'Mailer', 'send-email');
    m = mountApp(`/chat/${id}`, { h });
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole('textbox', { name: 'Message Mailer' }),
      'Reply to Ada{Enter}',
    );
    const card = await screen.findByTestId('chat-approval', {}, { timeout: 5000 });
    expect(within(card).getByText(/send email \(gmail\)/)).toBeTruthy();
    expect(await screen.findByText('Decide the request above first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    await user.click(within(card).getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(h.service.approvals.list({ status: 'pending' })).toHaveLength(0));
  });

  it('a request in the chat is decided from the keyboard; focus comes back to the composer', async () => {
    const h = harness();
    const id = await bot(h, 'Mailer', 'send-email');
    m = mountApp(`/chat/${id}`, { h });
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole('textbox', { name: 'Message Mailer' }),
      'Reply to Ada{Enter}',
    );
    const card = await screen.findByTestId('chat-approval', {}, { timeout: 5000 });
    await within(card).findByRole('button', { name: /^Approve/ });
    // r goes to the request (from outside any field), d opens the reason, Esc goes back.
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('r');
    expect(document.activeElement).toBe(card);
    await user.keyboard('d');
    const reason = await within(card).findByRole('textbox', { name: /Reason/ });
    expect(document.activeElement).toBe(reason);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(within(card).queryByRole('textbox', { name: /Reason/ })).toBeNull());
    // ⇧A asks first; n cancels.
    card.focus();
    await user.keyboard('A');
    expect(await within(card).findByRole('alertdialog')).toBeTruthy();
    await user.keyboard('n');
    await waitFor(() => expect(within(card).queryByRole('alertdialog')).toBeNull());
    // a approves from the full card; the composer gets the focus back.
    card.focus();
    await user.keyboard('a');
    await waitFor(() => expect(h.service.approvals.list({ status: 'pending' })).toHaveLength(0));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message Mailer' })),
    );
  });

  it('the computer opens over the chat on a narrow screen, as a dialog', async () => {
    const h = harness();
    const id = await bot(h, 'Watcher', 'pong');
    m = mountApp(`/chat/${id}`, { h });
    const user = userEvent.setup();
    const toggle = await screen.findByRole('button', { name: 'Show the computer' });
    await user.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: "Watcher's computer" });
    expect(within(dialog).getByTestId('computer-panel')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Focus goes back to what opened it.
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it('the computer shows the files, the pages read and every call', async () => {
    const h = harness();
    const id = await bot(h, 'Watcher', 'web-then-write');
    await h.json('POST', `/v1/bots/${id}/runs`, { prompt: 'Save the launch page' });
    await h.service.queue.idle();
    const run = h.service.store.listRuns({ botId: id })[0];
    m = mountApp(`/chat/${id}?c=${run?.runId ?? ''}`, { h });
    await screen.findByRole('log', { name: 'Conversation with Watcher' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show the computer' }));
    const panel = await screen.findByTestId('computer-panel');
    await user.click(within(panel).getByRole('tab', { name: 'Files' }));
    const notes = await within(panel).findByRole('button', { name: /notes/ });
    expect(within(notes).getByText('untrusted')).toBeTruthy();
    await user.click(notes);
    await user.click(await within(panel).findByRole('button', { name: /page\.md/ }));
    expect(await within(panel).findByText(/Launch page: owner Ada/)).toBeTruthy();
    await user.click(within(panel).getByRole('tab', { name: 'Activity' }));
    expect(await within(panel).findByText('Saving a file')).toBeTruthy();
    await user.click(within(panel).getByRole('tab', { name: 'Browser' }));
    expect(await within(panel).findByText(/Ignore previous instructions/)).toBeTruthy();
    await noA11yViolations(document.body);
  });

  it("a tool card opens that file on the Bot's computer", async () => {
    const h = harness();
    const id = await bot(h, 'Watcher', 'web-then-write');
    await h.json('POST', `/v1/bots/${id}/runs`, { prompt: 'Save the launch page' });
    await h.service.queue.idle();
    const run = h.service.store.listRuns({ botId: id })[0];
    m = mountApp(`/chat/${id}?c=${run?.runId ?? ''}`, { h });
    const cards = await screen.findAllByTestId('tool-card');
    const saving = cards.find((c) => within(c).queryByText('Saving a file'));
    const user = userEvent.setup();
    await user.click(within(saving!).getByRole('button', { name: "Show on Watcher's computer" }));
    const panel = await screen.findByTestId('computer-panel');
    expect(await within(panel).findByText(/Launch page: owner Ada/)).toBeTruthy();
  });

  it('the composer says why it cannot send, and offers the way out', async () => {
    const h = harness();
    const id = await bot(h, 'Scout', 'pong');
    await h.json('POST', `/v1/bots/${id}/pause`);
    m = mountApp(`/chat/${id}`, { h });
    expect(await screen.findByText('Scout is paused. Resume it to continue.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume Scout' }));
    await waitFor(() => expect(h.service.bots.get(id).pausedAt).toBeNull());
  });

  it('a starter fills the message box; it does not send', async () => {
    const h = harness();
    const id = await bot(h, 'Scout', 'pong');
    m = mountApp(`/chat/${id}`, { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'What can you do for me?' }));
    const box = screen.getByRole('textbox', { name: 'Message Scout' });
    expect((box as HTMLTextAreaElement).value).toMatch(/What can you do for me/);
    expect(document.activeElement).toBe(box);
    expect(h.service.store.listRuns({ botId: id })).toHaveLength(0);
  });

  it('a viewer reads along but cannot message', async () => {
    const h = harness();
    const id = await bot(h, 'Scout', 'pong');
    m = mountApp(`/chat/${id}`, { h, role: 'viewer' });
    expect(await screen.findByText(/Viewers can read along/)).toBeTruthy();
    // The files are the operator's (ADR-020): the tab says so instead of asking orbitd.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show the computer' }));
    const panel = await screen.findByTestId('computer-panel');
    await user.click(within(panel).getByRole('tab', { name: 'Files' }));
    expect(await within(panel).findByText(/files needs the operator role/)).toBeTruthy();
  });
});

describe('sidebar and avatars', () => {
  it('lists the Bots with their faces and the selected Bot’s conversations', async () => {
    const h = harness();
    const a = await bot(h, 'Scout', 'pong', { avatar: { character: 'cat', color: 'teal' } });
    await bot(h, 'Writer', 'pong');
    await h.json('POST', `/v1/bots/${a}/runs`, { prompt: 'Plan the week' });
    await h.service.queue.idle();
    m = mountApp(`/chat/${a}`, { h });
    const bots = await screen.findByRole('list', { name: 'Bots' });
    await waitFor(() =>
      expect(
        within(bots)
          .getAllByTestId('sidebar-bot')
          .map((e) => e.textContent),
      ).toEqual(['Scout', 'Writer']),
    );
    expect(document.querySelector('[data-avatar="cat/teal"]')).not.toBeNull();
    const conversations = await screen.findByRole('list', { name: 'Conversations with Scout' });
    expect(await within(conversations).findByText('Plan the week')).toBeTruthy();
  });

  it('a new Bot gets the avatar picked in the wizard and opens in a chat', async () => {
    m = mountApp('/bots/new');
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole('textbox', { name: /What should this Bot achieve/ }),
      'Keep my launch notes tidy',
    );
    await user.click(screen.getByRole('button', { name: /Suggest a setup/ }));
    await user.click(await screen.findByRole('radio', { name: 'Cat' }));
    await user.click(screen.getByRole('radio', { name: 'teal' }));
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await user.click(screen.getByRole('button', { name: /Create Bot/ }));
    await waitFor(() => expect(m?.h.service.bots.list()).toHaveLength(1));
    const created = m.h.service.bots.list()[0];
    expect(created?.spec.avatar).toEqual({ character: 'cat', color: 'teal' });
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${created?.id ?? ''}`));
  });
});
