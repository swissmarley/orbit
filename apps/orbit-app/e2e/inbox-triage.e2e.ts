import AxeBuilder from '@axe-core/playwright';
import { type Approval, type Bot, type Run, clearInbox, expect, test, until } from './fixtures';

test.describe('Inbox Triage demo (M7)', () => {
  test('from the template: reads mail, drafts a reply, and sends only after you approve it', async ({
    signedIn: page,
    orbitd,
  }) => {
    test.setTimeout(90_000);
    await clearInbox(orbitd);
    await page.goto(`${orbitd.url}/bots/new`);
    await page.getByRole('button', { name: 'Use Inbox Triage' }).click();
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Inbox Triage');
    await page
      .getByRole('textbox', { name: 'Name' })
      .fill(`Inbox Triage ${Date.now().toString(36)}`);
    await page.getByRole('button', { name: /Next/ }).click();
    await page.getByRole('button', { name: /Next/ }).click();
    await page.getByRole('button', { name: /Create Bot/ }).click();
    await page.waitForURL(/\/bots\/bot_/);
    const botId = /\/bots\/(bot_[0-9a-z]+)/.exec(page.url())?.[1] ?? '';
    const bot = await orbitd.api<Bot & { spec: { plugins: string[] } }>('GET', `/v1/bots/${botId}`);
    expect(bot.spec.plugins).toEqual(['google']);

    // Demo mode: the Gmail plugin is not set up, so a recorded mailbox replays.
    const run = await orbitd.api<Run>('POST', `/v1/bots/${botId}/runs`, {});
    const parked = await until(
      () => orbitd.api<Run>('GET', `/v1/runs/${run.runId}`),
      (r) => r.status === 'waiting_approval',
      40_000,
    );
    expect(parked.status).toBe('waiting_approval');

    await page.goto(`${orbitd.url}/inbox`);
    const row = page.getByTestId('inbox-row').filter({ hasText: 'send draft (google)' });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible();
    await expect(card.getByText(/untrusted content influenced/i).first()).toBeVisible();
    await expect(card.getByText(/r-5521/).first()).toBeVisible();
    // The owner sees who receives the mail and its subject (review M4).
    await expect(card.getByText(/ada@example\.com/).first()).toBeVisible();
    await expect(card.getByText(/Re: Launch window/).first()).toBeVisible();
    await card
      .getByRole('button', { name: /^Approve/ })
      .first()
      .click();
    await until(
      () => orbitd.api<Approval[]>('GET', `/v1/approvals?run=${run.runId}&all=true`),
      (l) => l.some((a) => a.status === 'approved'),
    );
    const done = await until(
      () => orbitd.api<Run & { resultText: string | null }>('GET', `/v1/runs/${run.runId}`),
      (r) => r.status === 'completed',
      40_000,
    );
    expect(done.resultText).toMatch(/did not pay it/);
  });

  test('Settings → Integrations lists the reference plugins and passes axe', async ({
    signedIn: page,
    orbitd,
  }) => {
    await page.goto(`${orbitd.url}/settings?tab=integrations`);
    await expect(page.getByRole('heading', { name: 'Gmail & Calendar' })).toBeVisible();
    await expect(page.getByTestId('plugin-card')).toHaveCount(5);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      axe.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
  });
});
