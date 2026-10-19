import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';

test.describe('browser security (ADR-011)', () => {
  test('the sign-in link works once and leaves no ticket in the address bar', async ({
    page,
    orbitd,
  }) => {
    const link = await orbitd.signInUrl();
    await page.goto(link);
    await page.waitForURL(/\/(welcome|inbox|chat|bots)/);
    expect(page.url()).not.toContain('ticket');
    // The session cookie is HttpOnly: scripts cannot see it; nothing is in storage.
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect(
      await page.evaluate(() =>
        JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
      ),
    ).not.toMatch(/token|session|ticket/i);
    const browser = page.context().browser();
    if (!browser) throw new Error('no browser');
    const fresh = await browser.newContext();
    const other = await fresh.newPage();
    await other.goto(link);
    await expect(
      other.getByText('This sign-in link was already used or has expired'),
    ).toBeVisible();
    await fresh.close();
  });

  test('a harvested session cookie is useless without the page-held CSRF secret', async ({
    signedIn: page,
    orbitd,
  }) => {
    // Cookies ignore ports: any listener on 127.0.0.1 could see this one.
    const cookies = await page.context().cookies(orbitd.url);
    const session = cookies.find((c) => c.name.startsWith('orbit_session_'));
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Strict');
    const replay = (csrf: string) =>
      fetch(`${orbitd.url}/v1/kill`, {
        method: 'POST',
        headers: {
          cookie: `${session?.name}=${session?.value}`,
          'x-orbit-csrf': csrf,
          'content-type': 'application/json',
        },
        body: '{"on":true}',
      });
    expect((await replay('1')).status).toBe(401);
    expect((await orbitd.api<{ engaged: boolean }>('GET', '/v1/kill')).engaged).toBe(false);
    // The App itself still works: it holds the secret in its own origin's storage.
    await page.goto(`${orbitd.url}/settings`);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Connection: live' })).toBeVisible();
  });

  test('the page is served with a strict CSP and no token anywhere in it', async ({
    request,
    orbitd,
  }) => {
    const res = await request.get(`${orbitd.url}/inbox`);
    expect(res.headers()['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers()['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers()['x-frame-options']).toBe('DENY');
    const token = (await import('node:fs'))
      .readFileSync(`${orbitd.home}/daemon.token`, 'utf8')
      .trim();
    expect(await res.text()).not.toContain(token);
  });

  test('a page on another loopback port cannot use the session', async ({
    signedIn: page,
    orbitd,
  }) => {
    // Same site (localhost), different origin: the cookie would ride along, the CORS + CSRF checks must stop it.
    const evil = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>evil</title>');
    });
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
    const port = (evil.address() as AddressInfo).port;
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      const outcome = await page.evaluate(async (target) => {
        const results: string[] = [];
        for (const init of [
          { credentials: 'include' as const },
          { credentials: 'include' as const, headers: { 'x-orbit-csrf': '1' } },
          {
            credentials: 'include' as const,
            method: 'POST',
            headers: { 'x-orbit-csrf': '1', 'content-type': 'application/json' },
            body: '{"on":true}',
          },
        ]) {
          try {
            const r = await fetch(`${target}${init.method ? '/v1/kill' : '/v1/bots'}`, init);
            results.push(`status ${r.status}`);
          } catch {
            results.push('blocked');
          }
        }
        return results;
      }, orbitd.url);
      for (const r of outcome) expect(r === 'blocked' || r === 'status 403').toBe(true);
      const kill = await orbitd.api<{ engaged: boolean }>('GET', '/v1/kill');
      expect(kill.engaged).toBe(false);
    } finally {
      evil.close();
    }
  });
});
