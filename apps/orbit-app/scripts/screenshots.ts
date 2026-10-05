/**
 * Screenshots of every App screen for UI review: a real orbitd (mock driver,
 * ORBIT_PORT=0, throwaway home) with seeded Bots and Runs, captured in light
 * and dark at 1440, 1024 and 768 px. Build the App first.
 *
 *   pnpm --filter @orbit/app exec tsx scripts/screenshots.ts <out-dir> [width,…]
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { startOrbitd } from '../e2e/orbitd';

const out = process.argv[2] ?? 'screenshots';
const widths = (process.argv[3] ?? '1440,1024,768').split(',').map(Number);
mkdirSync(out, { recursive: true });

const o = await startOrbitd();
const browser = await chromium.launch();
const errors: string[] = [];
try {
  const bot = await o.api<{ id: string }>('POST', '/v1/bots', {
    name: 'Mailer',
    goal: 'Reply to Ada about Tuesday’s launch window',
    tools: ['Read', 'Write'],
    mock: { fixture: 'send-email' },
    approvals: { parkWindowSeconds: 0 },
  });
  const notes = await o.api<{ id: string }>('POST', '/v1/bots', {
    name: 'Notes digest',
    goal: 'Summarize new notes into a digest every weekday at 9',
    tools: ['Read', 'Glob', 'Grep', 'Write'],
    mock: { fixture: 'read-then-write-denied' },
    triggers: [{ kind: 'cron', cron: '0 9 * * 1-5' }],
  });
  const research = await o.api<{ id: string }>('POST', '/v1/bots', {
    name: 'Researcher',
    goal: 'Research competitors with subagents',
    mock: { fixture: 'subagent-delegation' },
  });
  const run = await o.api<{ runId: string }>('POST', `/v1/bots/${bot.id}/runs`, {});
  await o.api('POST', `/v1/bots/${notes.id}/runs`, {});
  const sub = await o.api<{ runId: string }>('POST', `/v1/bots/${research.id}/runs`, {});
  await o.api('PUT', `/v1/bots/${notes.id}`, {
    name: 'Notes digest',
    goal: 'Summarize new notes into a digest every weekday at 9',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
    triggers: [{ kind: 'cron', cron: '0 9 * * 1-5' }],
    budgets: { maxRunsPerDay: 5 },
  });
  // M6: a team (delegation tree), memory with provenance, feedback, workspace taint.
  const lead = await o.api<{ id: string }>('POST', '/v1/bots', {
    name: 'Launch lead',
    goal: 'Coordinate the launch and keep notes',
    mock: { fixture: 'delegate-to-peer' },
    delegation: { allowedBots: ['Researcher'] },
    subagents: {
      reader: {
        description: 'Reads files and reports',
        prompt: 'Read and report.',
        model: 'haiku',
      },
    },
  });
  const web = await o.api<{ id: string }>('POST', '/v1/bots', {
    name: 'Web watcher',
    goal: 'Watch the launch page and save it',
    mock: { fixture: 'web-then-write' },
    memory: { summarize: 'triage' },
  });
  const team = await o.api<{ runId: string }>('POST', `/v1/bots/${lead.id}/runs`, {});
  await o.api('POST', `/v1/bots/${web.id}/runs`, {});
  await o.api('POST', `/v1/bots/${lead.id}/memory`, {
    title: 'House style',
    body: 'Short answers. Name the source of every fact.',
    pinned: true,
  });
  await new Promise((r) => setTimeout(r, 4000));
  await o.api('POST', `/v1/runs/${team.runId}/feedback`, {
    rating: 'down',
    comment: 'Name the source next time',
  });

  const screens: [string, string][] = [
    ['inbox', '/inbox'],
    ['bots', '/bots'],
    ['bot-overview', `/bots/${notes.id}`],
    ['bot-config-diff', `/bots/${notes.id}?tab=config`],
    ['run-parked', `/runs/${run.runId}`],
    ['run-subagents', `/runs/${sub.runId}`],
    ['runs', '/runs'],
    ['new-bot', '/bots/new'],
    ['settings', '/settings'],
    ['settings-engine', '/settings?tab=engine'],
    ['settings-policies', '/settings?tab=policies'],
    ['settings-audit', '/settings?tab=audit'],
    ['settings-budgets', '/settings?tab=budgets'],
    ['run-delegation', `/runs/${team.runId}`],
    ['memory', '/memory'],
    ['memory-web', `/memory?bot=${web.id}`],
    ['bot-memory-team', `/bots/${lead.id}?tab=memory`],
    ['bot-web-taint', `/bots/${web.id}?tab=memory`],
    ['welcome', '/welcome'],
  ];
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of widths) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('response', (r) => {
        if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      });
      await page.goto(await o.signInUrl());
      await page.waitForURL(/\/(welcome|inbox)/);
      for (const [name, path] of screens) {
        await page.goto(o.url + path);
        await page.locator('main h1').first().waitFor();
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${out}/${name}-${scheme}-${width}.png`, fullPage: true });
      }
      await page.goto(`${o.url}/inbox`);
      await page.getByTestId('inbox-row').first().waitFor();
      await page.keyboard.press('Enter');
      await page.getByTestId('approval-card').waitFor();
      await page.screenshot({ path: `${out}/approval-card-${scheme}-${width}.png` });
      await page.keyboard.press('e');
      await page.screenshot({ path: `${out}/approval-edit-${scheme}-${width}.png` });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/palette-${scheme}-${width}.png` });
      await page.keyboard.press('Escape');
      await page.keyboard.press('?');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/help-${scheme}-${width}.png` });
      await context.close();
    }
  }
  console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
} finally {
  await browser.close();
  await o.stop();
}
