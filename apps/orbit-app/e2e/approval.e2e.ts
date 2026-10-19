import { type Approval, type Run, clearInbox, expect, mailer, test, until } from './fixtures';

test.beforeEach(async ({ orbitd }) => clearInbox(orbitd));

test.describe('approval flow (MockDriver)', () => {
  test('a request arrives live, is approved from the full card, and the run finishes', async ({
    signedIn: page,
    orbitd,
  }) => {
    await page.goto(`${orbitd.url}/inbox`);
    await expect(page.getByRole('status', { name: 'Connection: live' })).toBeVisible();
    const bot = await mailer(orbitd);
    const run = await orbitd.api<Run>('POST', `/v1/bots/${bot.id}/runs`, {});
    // Arrives over SSE, without a reload.
    const row = page.getByTestId('inbox-row').filter({ hasText: 'send email' });
    await expect(row).toBeVisible();
    await expect(page.getByRole('link', { name: /^Needs you/ })).toContainText('1');

    // a in the list only opens the card.
    await page.keyboard.press('a');
    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('"to": "ada@example.com"')).toBeVisible();
    const [pending] = await orbitd.api<Approval[]>('GET', '/v1/approvals');
    expect(pending?.status).toBe('pending');

    await page.keyboard.press('a');
    await expect(page.getByText(/^Approved send email/)).toBeVisible();
    await expect(row).toHaveCount(0);
    const done = await until(
      () => orbitd.api<Run>('GET', `/v1/runs/${run.runId}`),
      (r) => r.status === 'completed',
    );
    expect(done.status).toBe('completed');

    // The Run view tells the same story.
    await page.goto(`${orbitd.url}/runs/${run.runId}`);
    await expect(page.getByText('✔done').first()).toBeVisible();
    await expect(
      page.getByRole('log', { name: 'Run timeline' }).getByText(/Approved by/),
    ).toBeVisible();
  });

  test('edit then approve sends exactly the edited arguments', async ({
    signedIn: page,
    orbitd,
  }) => {
    const bot = await mailer(orbitd);
    await orbitd.api('POST', `/v1/bots/${bot.id}/runs`, {});
    await page.goto(`${orbitd.url}/inbox`);
    await page.getByTestId('inbox-row').first().waitFor();
    await page.keyboard.press('e');
    const box = page.getByRole('textbox', { name: /Arguments \(JSON\)/ });
    const text = await box.inputValue();
    await box.fill(text.replace('ada@example.com', 'bob@example.com'));
    await expect(page.getByText('Your changes')).toBeVisible();
    await page.getByRole('button', { name: 'Approve edited' }).click();
    const decided = await until(
      () => orbitd.api<Approval[]>('GET', '/v1/approvals?all=true'),
      (l) =>
        l.some((a) => a.decision?.editedInput !== null && a.decision?.editedInput !== undefined),
    );
    expect(decided.find((a) => a.decision?.editedInput)?.decision?.editedInput).toMatchObject({
      to: 'bob@example.com',
    });
  });

  test('deny with a reason; Esc steps back without deciding', async ({
    signedIn: page,
    orbitd,
  }) => {
    const bot = await mailer(orbitd);
    await orbitd.api('POST', `/v1/bots/${bot.id}/runs`, {});
    await page.goto(`${orbitd.url}/inbox`);
    await page.getByTestId('inbox-row').first().waitFor();
    await page.keyboard.press('Enter');
    await page.keyboard.press('d');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('approval-card')).toBeVisible();
    await page.keyboard.press('d');
    await page.getByRole('textbox', { name: /Reason/ }).fill('Draft it for me instead');
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    const denied = await until(
      () => orbitd.api<Approval[]>('GET', '/v1/approvals?all=true'),
      (l) => l.some((a) => a.decision?.reason === 'Draft it for me instead'),
    );
    expect(denied.filter((a) => a.decision?.reason === 'Draft it for me instead')).toHaveLength(1);
  });
});

test.describe('live feed', () => {
  test('starts offline, reconnects by itself and catches up on what it missed', async ({
    signedIn: page,
    orbitd,
  }) => {
    // Every attempt at the event stream fails until we let it through.
    await page.route('**/v1/events**', (route) => route.abort('connectionreset'));
    await page.goto(`${orbitd.url}/inbox`);
    await expect(
      page.getByRole('status', { name: /Connection: (offline|reconnecting)/ }),
    ).toBeVisible({ timeout: 20_000 });
    const before = await page.getByTestId('inbox-row').count();
    const bot = await mailer(orbitd);
    await orbitd.api('POST', `/v1/bots/${bot.id}/runs`, {});
    await page.unroute('**/v1/events**');
    await expect(page.getByRole('status', { name: 'Connection: live' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('inbox-row')).toHaveCount(before + 1);
  });
});
