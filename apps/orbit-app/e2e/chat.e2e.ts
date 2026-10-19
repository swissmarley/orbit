import AxeBuilder from '@axe-core/playwright';
import { type Approval, type Bot, type Run, clearInbox, expect, test, until } from './fixtures';

/** The chat-first App (ADR-020): talk to a Bot, decide in the chat, look at its computer. */
test.describe('chat and the Bot’s computer', () => {
  test('a message starts a conversation; the request is decided in the chat; a reply continues it', async ({
    signedIn: page,
    orbitd,
  }) => {
    test.setTimeout(90_000);
    await clearInbox(orbitd);
    const bot = await orbitd.api<Bot>('POST', '/v1/bots', {
      name: `Mailer chat ${Date.now().toString(36)}`,
      goal: 'Reply to Ada about Tuesday',
      tools: ['Read', 'Write'],
      mock: { fixture: 'send-email' },
      approvals: { parkWindowSeconds: 0 },
      avatar: { character: 'robot', color: 'teal' },
    });
    await page.goto(`${orbitd.url}/chat/${bot.id}`);
    const box = page.getByRole('textbox', { name: `Message ${bot.spec.name}` });
    await box.fill('Reply to Ada: Tuesday works.');
    await box.press('Enter');
    await page.waitForURL(/c=run_/);
    const card = page.getByTestId('chat-approval');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Decide the request above first.')).toBeVisible();
    await card.getByRole('button', { name: /^Approve/ }).click();
    const runId = new URL(page.url()).searchParams.get('c') ?? '';
    await until(
      () => orbitd.api<Run>('GET', `/v1/runs/${runId}`),
      (r) => r.status === 'completed',
      30_000,
    );
    const approvals = await orbitd.api<Approval[]>('GET', `/v1/approvals?run=${runId}&all=true`);
    expect(approvals.map((a) => a.status)).toEqual(['approved']);
    // The held call and the request's receipt both say so.
    await expect(page.getByTestId('chat-log').getByText('Approved')).toHaveCount(2);

    await box.fill('Thanks!');
    // The turn has ended once the composer may send again.
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await box.press('Enter');
    const turns = await until(
      () =>
        orbitd.api<(Run & { continuesRunId: string | null })[]>(
          'GET',
          `/v1/runs?conversation=${runId}`,
        ),
      (l) => l.length === 2,
    );
    expect(turns.find((t) => t.runId !== runId)?.continuesRunId).toBe(runId);
    await expect(page.getByTestId('chat-log').getByText('Thanks!')).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the computer panel: files, browser, terminal, activity (axe, ${scheme})`, async ({
      signedIn: page,
      orbitd,
    }) => {
      test.setTimeout(60_000);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1440, height: 900 });
      const bot = await orbitd.api<Bot>('POST', '/v1/bots', {
        name: `Watcher ${scheme}`,
        goal: 'Watch the launch page and save it',
        mock: { fixture: 'web-then-write' },
        avatar: { character: 'star', color: 'violet' },
      });
      const run = await orbitd.api<Run>('POST', `/v1/bots/${bot.id}/runs`, {
        prompt: 'Save the launch page',
      });
      await until(
        () => orbitd.api<Run>('GET', `/v1/runs/${run.runId}`),
        (r) => r.status === 'completed',
      );
      await page.goto(`${orbitd.url}/chat/${bot.id}?c=${run.runId}`);
      await expect(page.getByTestId('chat-log')).toBeVisible();
      await page.getByRole('button', { name: 'Show the computer' }).click();
      const panel = page.getByTestId('computer-panel');
      await expect(panel).toBeVisible();
      for (const tab of ['Files', 'Browser', 'Terminal', 'Activity']) {
        await panel.getByRole('tab', { name: tab }).click();
        await page.waitForTimeout(200);
        const r = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(
          r.violations.map(
            (v) => `${tab}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
      }
      await panel.getByRole('tab', { name: 'Files' }).click();
      await panel.getByRole('button', { name: /notes/ }).click();
      await panel.getByRole('button', { name: /page\.md/ }).click();
      await expect(panel.getByText(/Launch page: owner Ada/)).toBeVisible();
    });
  }
});
