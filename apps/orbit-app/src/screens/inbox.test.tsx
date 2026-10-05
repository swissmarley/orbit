/** @jsxRuntime automatic @jsxImportSource react */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { harness } from '@orbit/api/testing';
import { type Mounted, mountApp } from '../test/harness';

let m: Mounted | undefined;
afterEach(async () => {
  m?.unmount();
  await m?.h.close();
  m = undefined;
});

/** A parked Run of the send-email scenario: one EXTERNAL approval pending. */
async function withPendingApproval(path = '/inbox') {
  const h = harness();
  await h.json('POST', '/v1/bots', {
    name: 'Mailer',
    goal: 'Reply to Ada',
    mock: { fixture: 'send-email' },
    approvals: { parkWindowSeconds: 0 },
  });
  await h.json('POST', '/v1/bots/mailer/runs', {});
  await h.service.queue.idle();
  const [approval] = h.service.approvals.list({ status: 'pending' });
  if (!approval) throw new Error('no pending approval');
  m = mountApp(path, { h });
  await screen.findByTestId('inbox-row');
  return { h, approval };
}

async function noA11yViolations(root: Element) {
  const r = await axe.run(root, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(
    r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

describe('Inbox', () => {
  it('a in the list opens the whole card; only a in the card approves', async () => {
    const { h, approval } = await withPendingApproval();
    const user = userEvent.setup();
    await user.keyboard('a');
    const card = await screen.findByTestId('approval-card');
    expect(within(card).getByText(/ada@example.com/, { selector: 'pre' })).toBeTruthy();
    expect(h.service.approvals.require(approval.id).status).toBe('pending');
    await user.keyboard('a');
    await waitFor(() => expect(h.service.approvals.require(approval.id).status).toBe('approved'));
    expect(h.service.approvals.require(approval.id).decision?.editedInput).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('inbox-row')).toBeNull());
  });

  it('e edits the arguments, shows the change, then approves exactly those', async () => {
    const { h, approval } = await withPendingApproval();
    const user = userEvent.setup();
    await user.keyboard('e');
    const box = await screen.findByRole('textbox', { name: /Arguments \(JSON\)/ });
    await user.clear(box);
    await user.click(box);
    await user.paste(JSON.stringify({ ...approval.input, to: 'bob@example.com' }));
    expect(screen.getByText('Your changes')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Approve edited/ }));
    await waitFor(() => expect(h.service.approvals.require(approval.id).status).toBe('approved'));
    expect(h.service.approvals.require(approval.id).decision?.editedInput).toMatchObject({
      to: 'bob@example.com',
    });
  });

  it('invalid edited JSON cannot be approved', async () => {
    await withPendingApproval();
    const user = userEvent.setup();
    await user.keyboard('e');
    const box = await screen.findByRole('textbox', { name: /Arguments \(JSON\)/ });
    await user.clear(box);
    await user.type(box, 'nope');
    expect(screen.getByRole('alert').textContent).toMatch(/Not valid JSON/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Approve edited/ }).disabled).toBe(
      true,
    );
  });

  it('d denies with a reason the Bot will see', async () => {
    const { h, approval } = await withPendingApproval();
    const user = userEvent.setup();
    await user.keyboard('d');
    const reason = await screen.findByRole('textbox', { name: /Reason/ });
    await user.type(reason, 'Draft it for me instead');
    await user.click(screen.getByRole('button', { name: /^Deny$/ }));
    await waitFor(() => expect(h.service.approvals.require(approval.id).status).toBe('denied'));
    expect(h.service.approvals.require(approval.id).decision?.reason).toBe(
      'Draft it for me instead',
    );
  });

  it('always-allow asks first and needs y', async () => {
    const { h, approval } = await withPendingApproval();
    const user = userEvent.setup();
    await user.keyboard('{Enter}');
    await screen.findByTestId('approval-card');
    await user.keyboard('A');
    expect(await screen.findByText(/Always allow mcp__gmail__send_email for Mailer/)).toBeTruthy();
    await user.keyboard('n');
    expect(h.service.approvals.require(approval.id).status).toBe('pending');
    await user.keyboard('A');
    await user.keyboard('y');
    await waitFor(() => expect(h.service.approvals.require(approval.id).status).toBe('approved'));
    expect(
      h.service.rules
        .list()
        .some((r) => r.toolPattern === 'mcp__gmail__send_email' && r.effect === 'allow'),
    ).toBe(true);
  });

  it('?approval= opens that card; the list and the card have no axe violations', async () => {
    const { approval } = await withPendingApproval();
    await noA11yViolations(document.body);
    m?.unmount();
    const h = m?.h;
    if (!h) throw new Error('no harness');
    m = mountApp(`/inbox?approval=${approval.id}`, { h });
    const card = await screen.findByTestId('approval-card');
    expect(card).toBeTruthy();
    await noA11yViolations(document.body);
  });
});

describe('sign-in', () => {
  it('without a valid session the App explains how to sign in', async () => {
    m = mountApp('/inbox', { token: 'wrong-token-wrong-token-wrong-token-xx' });
    expect(await screen.findByText('Sign in to Orbit')).toBeTruthy();
    expect(screen.getByText('orbit app')).toBeTruthy();
  });
});
