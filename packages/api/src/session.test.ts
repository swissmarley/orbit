import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN, harness, type Harness } from '../test/harness';
import { APP_CSP, createApp } from './app';
import { CSRF_HEADER } from './contract';
import { SessionStore } from './session';

const BASE = 'http://127.0.0.1:7420';
const HOSTS = ['127.0.0.1:7420', 'localhost:7420'];
const COOKIE = 'orbit_session_7420';

let h: Harness | undefined;
let dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function clockAt(iso: string) {
  let t = Date.parse(iso);
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function setup(opts: { appRoot?: string | null; allowedOrigins?: string[] } = {}) {
  h = harness();
  const sessions = new SessionStore();
  const app = createApp({
    service: h.service,
    token: TOKEN,
    allowedHosts: HOSTS,
    allowedOrigins: opts.allowedOrigins ?? [],
    sessions,
    appRoot: opts.appRoot ?? null,
  });
  const req = (
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ) =>
    Promise.resolve(
      app.request(`${BASE}${path}`, {
        ...init,
        headers: { host: '127.0.0.1:7420', ...init.headers },
      }),
    );
  const bearer = { authorization: `Bearer ${TOKEN}` };
  /** A signed-in App: ticket from the CLI, redeemed by the page. */
  const signIn = async () => {
    const t = (await (
      await req('/v1/session/tickets', { method: 'POST', headers: bearer })
    ).json()) as {
      ticket: string;
    };
    const res = await req('/v1/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', origin: BASE },
      body: JSON.stringify({ ticket: t.ticket }),
    });
    const cookie = /orbit_session_7420=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
    const body = res.status === 201 ? ((await res.clone().json()) as { csrf: string }) : null;
    return { res, cookie: `${COOKIE}=${cookie ?? ''}`, csrf: body?.csrf ?? '' };
  };
  return { app, req, bearer, signIn, sessions };
}

describe('SessionStore', () => {
  it('tickets are single-use and expire after two minutes', () => {
    const clock = clockAt('2026-10-05T10:00:00Z');
    const s = new SessionStore({ now: clock.now });
    const a = s.mintTicket();
    expect(a.expiresAt).toBe('2026-10-05T10:02:00.000Z');
    expect(s.redeem(a.ticket)).not.toBeNull();
    expect(s.redeem(a.ticket)).toBeNull();
    const b = s.mintTicket();
    clock.advance(121_000);
    expect(s.redeem(b.ticket)).toBeNull();
    expect(s.redeem('x'.repeat(43))).toBeNull();
  });

  it('sessions slide on use, expire when idle and after seven days at most', () => {
    const clock = clockAt('2026-10-05T10:00:00Z');
    const s = new SessionStore({ now: clock.now });
    const one = s.redeem(s.mintTicket().ticket);
    const check = (x: typeof one) => s.check(x?.session ?? '', x?.csrf);
    clock.advance(11 * 3_600_000);
    expect(check(one)).toBe('ok');
    clock.advance(11 * 3_600_000);
    expect(check(one)).toBe('ok');
    clock.advance(13 * 3_600_000);
    expect(check(one)).toBe('none');
    const long = s.redeem(s.mintTicket().ticket);
    for (let i = 0; i < 16; i++) {
      clock.advance(11 * 3_600_000);
      check(long);
    }
    expect(check(long)).toBe('none');
  });

  it('a session needs its own CSRF secret, not just the cookie (review HIGH-1)', () => {
    const s = new SessionStore();
    const a = s.redeem(s.mintTicket().ticket);
    const b = s.redeem(s.mintTicket().ticket);
    expect(s.check(a?.session ?? '', a?.csrf)).toBe('ok');
    expect(s.check(a?.session ?? '', undefined)).toBe('bad_csrf');
    expect(s.check(a?.session ?? '', '1')).toBe('bad_csrf');
    expect(s.check(a?.session ?? '', b?.csrf)).toBe('bad_csrf');
    expect(a?.csrf).not.toBe(a?.session);
  });

  it('revoke and the session cap drop sessions', () => {
    const s = new SessionStore({ maxSessions: 2 });
    const [a, b, c] = [1, 2, 3].map(() => s.redeem(s.mintTicket().ticket));
    expect(s.check(a?.session ?? '', a?.csrf)).toBe('none');
    expect(s.check(b?.session ?? '', b?.csrf)).toBe('ok');
    s.revoke(c?.session ?? '');
    expect(s.check(c?.session ?? '', c?.csrf)).toBe('none');
  });
});

describe('App sign-in (ADR-011)', () => {
  it('ticket → HttpOnly SameSite=Strict per-port cookie plus a CSRF secret; the ticket works once', async () => {
    const t = setup();
    const { res, cookie, csrf } = await t.signIn();
    expect(res.status).toBe(201);
    expect(csrf.length).toBeGreaterThanOrEqual(43);
    expect(res.headers.get('set-cookie')).not.toContain(csrf);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^orbit_session_7420=/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\//);
    const ok = await t.req('/v1/session', { headers: { cookie, [CSRF_HEADER]: csrf } });
    expect(await ok.json()).toEqual({ via: 'session' });
    expect(
      (await t.req('/v1/bots', { headers: { cookie, [CSRF_HEADER]: csrf, origin: BASE } })).status,
    ).toBe(200);
  });

  it('refuses a used, unknown or CSRF-less redemption', async () => {
    const t = setup();
    const ticket = (
      (await (
        await t.req('/v1/session/tickets', { method: 'POST', headers: t.bearer })
      ).json()) as { ticket: string }
    ).ticket;
    const redeem = (headers: Record<string, string>) =>
      t.req('/v1/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ ticket }),
      });
    expect((await redeem({})).status).toBe(403);
    expect((await redeem({ [CSRF_HEADER]: '1' })).status).toBe(201);
    const again = await redeem({ [CSRF_HEADER]: '1' });
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: { hint: string } }).error.hint).toMatch(/orbit app/);
  });

  it('a cookie alone is not enough: the CSRF header, a known origin and a live session are', async () => {
    const t = setup();
    const { cookie, csrf } = await t.signIn();
    expect((await t.req('/v1/bots', { headers: { cookie } })).status).toBe(401);
    // Review HIGH-1: a cookie harvested by another loopback listener, replayed
    // without an Origin and with a guessable header, gets nothing.
    for (const value of ['1', 'x', '']) {
      expect((await t.req('/v1/bots', { headers: { cookie, [CSRF_HEADER]: value } })).status).toBe(
        401,
      );
    }
    expect(
      (
        await t.req('/v1/kill', {
          method: 'POST',
          headers: { cookie, [CSRF_HEADER]: '1', 'content-type': 'application/json' },
          body: '{"on":false}',
        })
      ).status,
    ).toBe(401);
    expect((await t.req('/v1/bots', { headers: { cookie, [CSRF_HEADER]: csrf } })).status).toBe(
      200,
    );
    // Another loopback port is same-site (the cookie is sent) but not same-origin.
    const sibling = await t.req('/v1/bots', {
      headers: { cookie, [CSRF_HEADER]: csrf, origin: 'http://127.0.0.1:3000' },
    });
    expect(sibling.status).toBe(403);
    expect(
      (await t.req('/v1/bots', { headers: { cookie: `${COOKIE}=forged`, [CSRF_HEADER]: csrf } }))
        .status,
    ).toBe(401);
    // A cookie for another daemon's port is ignored.
    const other = cookie.replace(COOKIE, 'orbit_session_7421');
    expect(
      (await t.req('/v1/bots', { headers: { cookie: other, [CSRF_HEADER]: csrf } })).status,
    ).toBe(401);
  });

  it('only the bearer token mints tickets; sign-out ends the session', async () => {
    const t = setup();
    const { cookie, csrf } = await t.signIn();
    const app = { cookie, [CSRF_HEADER]: csrf };
    expect((await t.req('/v1/session/tickets', { method: 'POST', headers: app })).status).toBe(403);
    const out = await t.req('/v1/session', { method: 'DELETE', headers: app });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/orbit_session_7420=;.*Max-Age=0/);
    expect((await t.req('/v1/bots', { headers: app })).status).toBe(401);
  });
});

describe('origin allowlist', () => {
  it('an allowlisted dev origin gets CORS headers and preflights; others do not', async () => {
    const t = setup({ allowedOrigins: ['http://localhost:5173'] });
    const pre = await t.req('/v1/bots', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(pre.headers.get('access-control-allow-credentials')).toBe('true');
    expect(pre.headers.get('access-control-allow-headers')).toMatch(CSRF_HEADER);
    const res = await t.req('/v1/bots', {
      headers: { ...t.bearer, origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    for (const origin of ['https://evil.example', 'http://localhost:5174', 'null']) {
      expect((await t.req('/v1/bots', { method: 'OPTIONS', headers: { origin } })).status).toBe(
        403,
      );
      expect((await t.req('/v1/bots', { headers: { ...t.bearer, origin } })).status).toBe(403);
    }
  });

  it('a request without a Host header is refused when hosts are pinned (review L5)', async () => {
    const t = setup();
    const res = await t.app.request(`${BASE}/v1/health`);
    expect(res.status).toBe(400);
  });

  it('same-origin requests need no CORS headers; cross-site without an origin is refused', async () => {
    const t = setup();
    const same = await t.req('/v1/bots', { headers: { ...t.bearer, origin: BASE } });
    expect(same.status).toBe(200);
    expect(same.headers.get('access-control-allow-origin')).toBeNull();
    expect(same.headers.get('x-content-type-options')).toBe('nosniff');
    const cross = await t.req('/v1/bots', {
      headers: { ...t.bearer, 'sec-fetch-site': 'cross-site' },
    });
    expect(cross.status).toBe(403);
  });
});

describe('serving the App', () => {
  function built(): string {
    const parent = mkdtempSync(join(tmpdir(), 'orbit-app-'));
    dirs.push(parent);
    const dir = join(parent, 'dist');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Orbit</title>');
    writeFileSync(join(dir, 'assets', 'app-1.js'), 'console.log(1)');
    writeFileSync(join(parent, 'secret.txt'), 'nope');
    return dir;
  }

  it('serves the page (with its CSP) for client routes and assets without a token', async () => {
    const t = setup({ appRoot: built() });
    for (const path of ['/', '/inbox', '/bots/bot_x', '/runs/run_1?x=1']) {
      const res = await t.req(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.headers.get('content-security-policy')).toBe(APP_CSP);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
    const js = await t.req('/assets/app-1.js');
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(js.headers.get('cache-control')).toMatch(/immutable/);
    expect((await t.req('/assets/missing.js')).status).toBe(404);
  });

  it('never serves files outside the App directory, and the API stays protected', async () => {
    const t = setup({ appRoot: built() });
    for (const path of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const res = await t.req(path);
      expect(await res.text()).not.toBe('nope');
    }
    expect((await t.req('/v1/bots')).status).toBe(401);
    expect((await t.req('/v1/nothing')).status).toBe(401);
    expect((await t.req('/', { method: 'POST' })).status).toBe(401);
  });

  it('explains how to build the App when it is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-app-'));
    dirs.push(dir);
    const t = setup({ appRoot: dir });
    const res = await t.req('/');
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/pnpm --filter @orbit\/app build/);
  });
});
