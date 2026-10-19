import { test as base, expect, type Page } from '@playwright/test';
import { type Orbitd, startOrbitd } from './orbitd';

/** One orbitd per test file (worker), always stopped afterwards. */
export const test = base.extend<{ signedIn: Page }, { orbitd: Orbitd }>({
  orbitd: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const o = await startOrbitd();
      try {
        await use(o);
      } finally {
        await o.stop();
      }
    },
    { scope: 'worker' },
  ],
  signedIn: async ({ page, orbitd }, use) => {
    await page.goto(await orbitd.signInUrl());
    await page.waitForURL(/\/(welcome|inbox|chat|bots)/);
    await use(page);
  },
});

export { expect };

export interface Bot {
  id: string;
  spec: { name: string };
}
export interface Run {
  runId: string;
  status: string;
}
export interface Approval {
  id: string;
  status: string;
  runId: string;
  decision: { reason: string | null; editedInput: Record<string, unknown> | null } | null;
}

let n = 0;
/** A Bot whose mock run asks to send an email (EXTERNAL → approval), parking at once. */
export async function mailer(o: Orbitd, fixture = 'send-email'): Promise<Bot> {
  n += 1;
  return o.api<Bot>('POST', '/v1/bots', {
    name: `Mailer ${n}`,
    goal: 'Reply to Ada about Tuesday',
    tools: ['Read', 'Write'],
    mock: { fixture },
    approvals: { parkWindowSeconds: 0 },
  });
}

/** Deny whatever earlier tests left pending, so each test starts with an empty inbox. */
export async function clearInbox(o: Orbitd): Promise<void> {
  for (const a of await o.api<Approval[]>('GET', '/v1/approvals')) {
    await o.api('POST', `/v1/approvals/${a.id}/deny`, { reason: 'test cleanup', resume: false });
  }
}

export async function until<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 15_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
