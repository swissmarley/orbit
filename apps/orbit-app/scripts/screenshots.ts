import { chromium } from '@playwright/test';
import { startOrbitd } from '../e2e/orbitd';

const out =
  process.argv[2] ??
  '/tmp/claude-0/-home-user-orbit/bcfe95c4-922a-5b94-9163-2d18301d904f/scratchpad';
const o = await startOrbitd();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  await page.goto(await o.signInUrl());
  await page.waitForURL(/\/(welcome|inbox)/);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/01-welcome.png`, fullPage: true });
  const bot = await o.api<{ id: string }>('POST', '/v1/bots', {
    name: 'Mailer',
    goal: 'Reply to Ada about Tuesday',
    tools: ['Read', 'Write'],
    mock: { fixture: 'send-email' },
    approvals: { parkWindowSeconds: 0 },
  });
  await o.api('POST', '/v1/bots', {
    name: 'Notes digest',
    goal: 'Summarize notes every weekday at 9',
    triggers: [{ kind: 'cron', cron: '0 9 * * 1-5' }],
  });
  const run = await o.api<{ runId: string }>('POST', `/v1/bots/${bot.id}/runs`, {});
  await page.goto(o.url + '/inbox');
  await page.getByTestId('inbox-row').first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${out}/02-inbox.png`, fullPage: true });
  await page.keyboard.press('Enter');
  await page.getByTestId('approval-card').waitFor();
  await page.screenshot({ path: `${out}/03-card.png` });
  await page.keyboard.press('Escape');
  await page.goto(o.url + '/bots');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/04-bots.png`, fullPage: true });
  await page.goto(`${o.url}/runs/${run.runId}`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/05-run.png`, fullPage: true });
  await page.goto(`${o.url}/bots/${bot.id}?tab=config`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/06-bot.png`, fullPage: true });
  await page.goto(`${o.url}/settings?tab=engine`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/07-settings.png`, fullPage: true });
  await page.goto(`${o.url}/bots/new`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/08-new.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(o.url + '/inbox');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/09-inbox-dark.png`, fullPage: true });
  console.log('errors:', errors);
} finally {
  await browser.close();
  await o.stop();
}
