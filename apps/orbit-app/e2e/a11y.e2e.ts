import AxeBuilder from '@axe-core/playwright';
import { type Run, expect, mailer, test } from './fixtures';

const SCREENS = [
  '/inbox',
  '/bots',
  '/runs',
  '/bots/new',
  '/settings',
  '/settings?tab=engine',
  '/settings?tab=policies',
  '/settings?tab=audit',
  '/welcome',
];

test.describe('accessibility (axe, WCAG 2.1 AA, both themes)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`every screen, ${scheme}`, async ({ signedIn: page, orbitd }) => {
      test.setTimeout(150_000);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const bot = await mailer(orbitd);
      const run = await orbitd.api<Run>('POST', `/v1/bots/${bot.id}/runs`, {});
      const pages = [
        ...SCREENS,
        `/bots/${bot.id}`,
        `/bots/${bot.id}?tab=config`,
        `/runs/${run.runId}`,
      ];
      for (const path of pages) {
        await page.goto(orbitd.url + path);
        // The SSE feed keeps the network busy: wait for content, not for idle.
        await expect(page.locator('main h1, main [role="log"]').first()).toBeVisible();
        await expect(page.locator('main [aria-label="Loading"]')).toHaveCount(0);
        await page.waitForTimeout(250);
        const r = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(
          r.violations.map(
            (v) => `${path}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
      }
      // The full approval card (a dialog) too.
      await page.goto(`${orbitd.url}/inbox`);
      await page.getByTestId('inbox-row').first().waitFor();
      await page.keyboard.press('Enter');
      await page.getByTestId('approval-card').waitFor();
      const card = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(
        card.violations.map(
          (v) => `card: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
        ),
      ).toEqual([]);
    });
  }

  test('keyboard only: the palette reaches a Bot and runs it', async ({
    signedIn: page,
    orbitd,
  }) => {
    const bot = await mailer(orbitd, 'pong');
    await page.goto(`${orbitd.url}/bots`);
    await expect(page.getByTestId('bot-card').first()).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await page.keyboard.type(`Run ${bot.spec.name} now`);
    await expect(palette.getByRole('option', { name: `Run ${bot.spec.name} now` })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByText(`Queued a run of ${bot.spec.name}`)).toBeVisible();
  });
});
