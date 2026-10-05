import AxeBuilder from '@axe-core/playwright';
import { type Bot, type Run, expect, test, until } from './fixtures';

interface Memory {
  id: string;
  title: string;
  source: string;
  taint: string[];
}

test.describe('memory and teams (M6)', () => {
  test('a delegating Run shows its live tree; feedback becomes memory you can edit and delete', async ({
    signedIn: page,
    orbitd,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now().toString(36);
    await orbitd.api<Bot>('POST', '/v1/bots', {
      // The delegate-to-peer scenario asks for "Researcher" by name.
      name: 'Researcher',
      goal: 'Research things',
      mock: { fixture: 'subagent-delegation' },
    });
    const lead = await orbitd.api<Bot>('POST', '/v1/bots', {
      name: `Lead ${stamp}`,
      goal: 'Lead the work',
      mock: { fixture: 'delegate-to-peer' },
      delegation: { allowedBots: ['Researcher'] },
    });
    const run = await orbitd.api<Run>('POST', `/v1/bots/${lead.id}/runs`, {});
    await page.goto(`${orbitd.url}/runs/${run.runId}`);
    const tree = page.getByRole('list', { name: 'Delegation tree' });
    await expect(tree).toBeVisible({ timeout: 20_000 });
    await expect(tree.getByRole('link', { name: 'Researcher' })).toBeVisible();
    await until(
      () => orbitd.api<Run>('GET', `/v1/runs/${run.runId}`),
      (r) => r.status === 'completed',
      30_000,
    );
    await expect(tree.getByText(/done/).first()).toBeVisible();

    // Thumbs down with a comment → a feedback memory.
    await page.getByRole('button', { name: /Not good/ }).click();
    await page.getByLabel('What was good or bad (optional)').fill('Name the source next time');
    await page.getByRole('button', { name: 'Save feedback' }).click();
    const feedback = await until(
      () => orbitd.api<Memory[]>('GET', `/v1/memory?bot=${lead.id}&kind=feedback`),
      (l) => l.length === 1,
    );
    expect(feedback[0]?.source).toBe('feedback');

    // The memory browser: provenance in words, edit, delete.
    await page.goto(`${orbitd.url}/memory?bot=${lead.id}`);
    const list = page.getByRole('region', { name: 'Memories' });
    await expect(list.getByText('Owner disliked a result')).toBeVisible();
    await expect(list.getByText('untrusted').first()).toBeVisible(); // the summary of a tainted Run
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      axe.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
    await list.getByText('Owner disliked a result').click();
    const detail = page.getByRole('region', { name: 'Selected memory' });
    await detail.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit memory' });
    await dialog.getByLabel('Title').fill('Cite sources');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await until(
      () => orbitd.api<Memory>('GET', `/v1/memory/${feedback[0]?.id ?? ''}`),
      (m) => m.title === 'Cite sources',
    );
    await page
      .getByRole('region', { name: 'Selected memory' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await page
      .getByRole('dialog', { name: /Delete this memory/ })
      .getByRole('button', { name: /^Delete/ })
      .click();
    await until(
      () => orbitd.api<Memory[]>('GET', `/v1/memory?bot=${lead.id}&kind=feedback`),
      (l) => l.length === 0,
    );
  });

  test('Create Bot: Ask Claude names its cost and fills the wizard (mock: free)', async ({
    signedIn: page,
    orbitd,
  }) => {
    await page.goto(`${orbitd.url}/bots/new`);
    await page
      .getByLabel('What should this Bot achieve?')
      .fill('Every morning, search the web for launch news and write a report');
    await expect(page.getByText(/triage calls left today/)).toBeVisible();
    await page.getByRole('button', { name: /Ask Claude to propose/ }).click();
    await expect(page.getByText(/Proposed by mock/)).toBeVisible();
    const usage = await orbitd.api<{ callsToday: number }>('GET', '/v1/triage');
    expect(usage.callsToday).toBeGreaterThanOrEqual(1);
  });
});
