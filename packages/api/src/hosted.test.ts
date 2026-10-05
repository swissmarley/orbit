import { createHmac } from 'node:crypto';
import type { Bot, RunState } from '@orbit/core';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN, type Harness, harness } from '../test/harness';
import { type MockIssuer, mockIssuer } from '../test/oidc-issuer';
import { HOSTED_SESSION_COOKIE, HSTS, OIDC_STATE_COOKIE, createApp } from './app';
import { type Approval, CSRF_HEADER, OIDC_CALLBACK_PATH, OIDC_LOGIN_PATH } from './contract';
import { OidcSignIn } from './oidc';
import { SessionStore } from './session';

/**
 * Hosted mode through the app (ADR-015): OIDC sign-in against a mock issuer
 * on loopback, the ticket → session hand-off, `__Host-` cookies, HSTS, the
 * public origin, role limits and the actor recorded for each principal.
 */

const PUBLIC = 'https://orbit.example.com';
const HOST = 'orbit.example.com';

const PRINCIPALS = [
  { id: 'ada', kind: 'human', name: 'Ada', role: 'owner', oidc: { subject: 'sub-ada' } },
  { id: 'bob', kind: 'human', name: 'Bob', role: 'operator', oidc: { subject: 'sub-bob' } },
  { id: 'cy', kind: 'human', name: 'Cy', role: 'viewer', oidc: { email: 'cy@example.com' } },
  // A principal that names a subject signs in by subject only, never by email.
  {
    id: 'dee',
    kind: 'human',
    name: 'Dee',
    role: 'owner',
    oidc: { subject: 'sub-dee', email: 'dee@example.com' },
  },
] as const;

let h: Harness | undefined;
let issuer: MockIssuer | undefined;
afterEach(async () => {
  await h?.close();
  await issuer?.close();
  h = undefined;
  issuer = undefined;
});

async function setup(opts: { clientSecret?: string; authMethods?: string[] } = {}) {
  issuer = await mockIssuer({
    clientSecret: opts.clientSecret ?? null,
    ...(opts.authMethods ? { authMethods: opts.authMethods } : {}),
  });
  const iss = issuer;
  h = harness({
    config: {
      mode: 'hosted',
      principals: PRINCIPALS.map((p) => ({ ...p })),
      hosted: {
        publicUrl: PUBLIC,
        oidc: { issuer: iss.issuer, clientId: iss.clientId },
      },
    },
  });
  const service = h.service;
  const sessions = new SessionStore();
  const oidc = new OidcSignIn({
    issuer: iss.issuer,
    clientId: iss.clientId,
    clientSecret: () => opts.clientSecret ?? null,
    scopes: ['openid', 'email', 'profile'],
    redirectUri: `${PUBLIC}${OIDC_CALLBACK_PATH}`,
    principals: () => service.config.principals,
    now: h.clock.now,
  });
  const app = createApp({
    service,
    token: TOKEN,
    allowedHosts: [HOST, '127.0.0.1:7420', 'localhost:7420', '[::1]:7420'],
    sessions,
    hosted: { publicUrl: PUBLIC, oidc, tls: false },
    validateResponses: true,
  });
  const req = (
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ) =>
    Promise.resolve(
      app.request(`${PUBLIC}${path}`, { ...init, headers: { host: HOST, ...init.headers } }),
    );

  /** Steps 1–2: orbitd redirects to the issuer and sets the state cookie. */
  const login = async () => {
    const res = await req(OIDC_LOGIN_PATH, {
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    const state = new RegExp(`${OIDC_STATE_COOKIE}=([^;]+)`).exec(setCookie)?.[1] ?? '';
    return { res, location: res.headers.get('location') ?? '', setCookie, state };
  };
  /** Step 3: the issuer sends the browser back (a cross-site top-level navigation). */
  const callback = (query: Record<string, string>, stateCookie: string | null) =>
    req(`${OIDC_CALLBACK_PATH}?${new URLSearchParams(query).toString()}`, {
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        ...(stateCookie === null ? {} : { cookie: `${OIDC_STATE_COOKIE}=${stateCookie}` }),
      },
    });
  /** Step 4: the App's /login page redeems the ticket for the session cookie. */
  const redeem = (ticket: string) =>
    req('/v1/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', origin: PUBLIC },
      body: JSON.stringify({ ticket }),
    });
  /** The whole browser flow as one identity; returns the App's credentials. */
  const signIn = async (claims: Record<string, unknown>) => {
    const l = await login();
    const code = iss.authorize(l.location, claims);
    const cb = await callback(
      { code, state: new URL(l.location).searchParams.get('state')! },
      l.state,
    );
    expect(cb.status, await cb.clone().text()).toBe(302);
    const ticket = /#ticket=([\w-]+)$/.exec(cb.headers.get('location') ?? '')?.[1] ?? '';
    const res = await redeem(ticket);
    expect(res.status).toBe(201);
    const set = res.headers.get('set-cookie') ?? '';
    const cookie = new RegExp(`${HOSTED_SESSION_COOKIE}=([^;]+)`).exec(set)?.[1] ?? '';
    const { csrf } = (await res.json()) as { csrf: string };
    const headers = { cookie: `${HOSTED_SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrf };
    return { set, headers, ticket };
  };
  const as = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
    req(path, {
      method,
      headers: {
        ...headers,
        origin: PUBLIC,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const clock = h.clock;
  return { app, req, login, callback, redeem, signIn, as, bearer, service, sessions, iss, clock };
}

describe('hosted mode: OIDC sign-in (ADR-015)', () => {
  it('login → issuer → callback → ticket → __Host- session, as the mapped principal', async () => {
    const t = await setup();
    const l = await t.login();
    expect(l.res.status).toBe(302);
    expect(l.res.headers.get('cache-control')).toBe('no-store');
    const auth = new URL(l.location);
    expect(`${auth.origin}${auth.pathname}`).toBe(`${t.iss.issuer}/authorize`);
    const p = Object.fromEntries(auth.searchParams);
    expect(p).toMatchObject({
      response_type: 'code',
      client_id: t.iss.clientId,
      redirect_uri: `${PUBLIC}${OIDC_CALLBACK_PATH}`,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    expect(p.state).toBe(l.state);
    expect(p.nonce?.length).toBeGreaterThanOrEqual(43);
    expect(p.code_challenge?.length).toBe(43);
    // The state cookie: short-lived, HttpOnly, Secure, Lax, only for the callback.
    expect(l.setCookie).toMatch(new RegExp(`^${OIDC_STATE_COOKIE}=`));
    for (const flag of [
      /HttpOnly/,
      /Secure/,
      /SameSite=Lax/,
      /Max-Age=600/,
      new RegExp(`Path=${OIDC_CALLBACK_PATH.replace(/\//g, '\\/')}`),
    ]) {
      expect(l.setCookie).toMatch(flag);
    }

    const code = t.iss.authorize(l.location, { sub: 'sub-bob' });
    const cb = await t.callback({ code, state: l.state }, l.state);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toMatch(/^\/login#ticket=[\w-]{43}$/);
    // The state cookie is cleared; the token request carried the PKCE verifier.
    expect(cb.headers.get('set-cookie')).toMatch(new RegExp(`${OIDC_STATE_COOKIE}=;.*Max-Age=0`));
    expect(t.iss.tokenRequests[0]?.form).toMatchObject({
      grant_type: 'authorization_code',
      client_id: t.iss.clientId,
      redirect_uri: `${PUBLIC}${OIDC_CALLBACK_PATH}`,
    });
    expect(t.iss.tokenRequests[0]?.form.code_verifier?.length).toBe(43);

    const ticket = /#ticket=([\w-]+)$/.exec(cb.headers.get('location') ?? '')?.[1] ?? '';
    const res = await t.redeem(ticket);
    expect(res.status).toBe(201);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(new RegExp(`^${HOSTED_SESSION_COOKIE}=`));
    for (const flag of [/HttpOnly/, /Secure/, /SameSite=Strict/, /Path=\//]) {
      expect(set).toMatch(flag);
    }
    expect(set).not.toMatch(/Domain=/i);
    expect(res.headers.get('strict-transport-security')).toBe(HSTS);
    // A ticket works once.
    expect((await t.redeem(ticket)).status).toBe(401);

    const cookie = new RegExp(`${HOSTED_SESSION_COOKIE}=([^;]+)`).exec(set)?.[1] ?? '';
    const { csrf } = (await res.json()) as { csrf: string };
    const app = { cookie: `${HOSTED_SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrf };
    const who = await t.as(app, 'GET', '/v1/session');
    expect(await who.json()).toEqual({
      via: 'session',
      principal: { id: 'bob', name: 'Bob', role: 'operator' },
    });
    // The per-port local cookie name means nothing here.
    const local = await t.as(
      { cookie: `orbit_session_443=${cookie}`, [CSRF_HEADER]: csrf },
      'GET',
      '/v1/bots',
    );
    expect(local.status).toBe(401);
    // The sign-in is audited with the principal, never with token text.
    const signedIn = t.service.auditTail('session.signed_in', 10);
    expect(signedIn).toHaveLength(1);
    expect(signedIn[0]).toMatchObject({ actor: 'bob', data: { via: 'oidc', role: 'operator' } });
  });

  it('health tells the App to offer OIDC sign-in and names the public URL', async () => {
    const t = await setup();
    const health = await t.req('/v1/health');
    expect(await health.json()).toMatchObject({ signIn: 'oidc', publicUrl: PUBLIC });
    expect(health.headers.get('strict-transport-security')).toBe(HSTS);
  });

  it('maps by verified email only, and only for principals without a subject', async () => {
    const t = await setup();
    const cy = await t.signIn({ sub: 'sub-cy-x', email: 'Cy@Example.com', email_verified: true });
    expect(await (await t.as(cy.headers, 'GET', '/v1/session')).json()).toMatchObject({
      principal: { id: 'cy', role: 'viewer' },
    });
    for (const claims of [
      { sub: 'sub-cy-y', email: 'cy@example.com' },
      { sub: 'sub-cy-z', email: 'cy@example.com', email_verified: 'true' },
      { sub: 'sub-other', email: 'dee@example.com', email_verified: true },
      { sub: 'sub-unknown' },
    ]) {
      const l = await t.login();
      const code = t.iss.authorize(l.location, claims);
      const cb = await t.callback({ code, state: l.state }, l.state);
      expect(cb.status, JSON.stringify(claims)).toBe(403);
      const page = await cb.text();
      expect(page).toMatch(/no access to this Orbit/);
      // Nothing about who could sign in.
      for (const p of PRINCIPALS) {
        expect(page).not.toContain(p.id === 'cy' ? 'cy@example.com' : p.name);
      }
      expect(cb.headers.get('location')).toBeNull();
    }
  });

  it('refuses ID tokens with a wrong issuer, audience, nonce, expiry or algorithm', async () => {
    const t = await setup();
    const now = Math.floor(Date.now() / 1000);
    const pem = await t.iss.publicPem();
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const cases: {
      name: string;
      claims?: Record<string, unknown>;
      token?: (nonce: string) => Promise<string> | string;
    }[] = [
      { name: 'wrong iss', claims: { iss: 'https://evil.example' } },
      { name: 'wrong aud', claims: { aud: 'someone-else' } },
      { name: 'two audiences without azp', claims: { aud: [t.iss.clientId, 'other'] } },
      { name: 'foreign azp', claims: { azp: 'other' } },
      { name: 'expired', claims: { iat: now - 7200, exp: now - 3600 } },
      { name: 'bad nonce', claims: { nonce: 'not-the-nonce' } },
      {
        name: 'alg none',
        token: (nonce) =>
          `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: t.iss.issuer, aud: t.iss.clientId, sub: 'sub-ada', iat: now, exp: now + 300, nonce })}.`,
      },
      {
        name: 'HS256 signed with the public key',
        token: (nonce) => {
          const head = b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' });
          const body = b64({
            iss: t.iss.issuer,
            aud: t.iss.clientId,
            sub: 'sub-ada',
            iat: now,
            exp: now + 300,
            nonce,
          });
          const sig = createHmac('sha256', pem).update(`${head}.${body}`).digest('base64url');
          return `${head}.${body}.${sig}`;
        },
      },
      {
        name: 'unknown key id',
        token: (nonce) =>
          t.iss.sign(
            {
              iss: t.iss.issuer,
              aud: t.iss.clientId,
              sub: 'sub-ada',
              iat: now,
              exp: now + 300,
              nonce,
            },
            { kid: 'k2' },
          ),
      },
    ];
    for (const c of cases) {
      const l = await t.login();
      const nonce = new URL(l.location).searchParams.get('nonce') ?? '';
      const code = t.iss.authorize(
        l.location,
        { sub: 'sub-ada', ...c.claims },
        c.token ? { token: await c.token(nonce) } : {},
      );
      const cb = await t.callback({ code, state: l.state }, l.state);
      expect(cb.status, c.name).toBe(403);
      expect(await cb.text(), c.name).toMatch(/could not be verified/);
    }
    // The positive control: the same flow with an honest token signs in.
    await t.signIn({ sub: 'sub-ada' });
  });

  it('refuses a replayed state, a missing or mismatched state cookie, and IdP errors', async () => {
    const t = await setup();
    const l = await t.login();
    const code = t.iss.authorize(l.location, { sub: 'sub-ada' });
    // No cookie: the callback was not started in this browser (login CSRF).
    expect((await t.callback({ code, state: l.state }, null)).status).toBe(400);
    // That attempt consumed nothing: state is checked against the cookie first.
    const other = await t.login();
    expect((await t.callback({ code, state: l.state }, other.state)).status).toBe(400);
    const ok = await t.callback({ code, state: l.state }, l.state);
    expect(ok.status).toBe(302);
    // Each state works once.
    const again = await t.callback({ code, state: l.state }, l.state);
    expect(again.status).toBe(400);
    expect(await again.text()).toMatch(/expired or was started in another browser/);
    // The issuer said no (user cancelled): no exchange, a 403 page.
    const n = t.iss.tokenRequests.length;
    const denied = await t.login();
    const cb = await t.callback(
      { error: 'access_denied', error_description: '<script>x</script>', state: denied.state },
      denied.state,
    );
    expect(cb.status).toBe(403);
    const page = await cb.text();
    expect(page).toMatch(/access_denied/);
    expect(page).not.toContain('<script>');
    expect(t.iss.tokenRequests.length).toBe(n);
    // A cross-site request elsewhere is still refused (only the callback navigation is exempt).
    const cross = await t.req('/v1/health', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(cross.status).toBe(403);
  });

  it('a started sign-in expires after ten minutes', async () => {
    const t = await setup();
    const l = await t.login();
    const code = t.iss.authorize(l.location, { sub: 'sub-ada' });
    t.clock.advance(11 * 60_000);
    expect((await t.callback({ code, state: l.state }, l.state)).status).toBe(400);
    expect(t.iss.tokenRequests).toHaveLength(0);
  });

  it('a confidential client authenticates with Basic, or POST when that is all the issuer takes', async () => {
    const t = await setup({ clientSecret: 'TEST-oidc-secret' });
    await t.signIn({ sub: 'sub-ada' });
    const basic = `Basic ${Buffer.from(`${t.iss.clientId}:TEST-oidc-secret`).toString('base64')}`;
    expect(t.iss.tokenRequests.at(-1)?.authorization).toBe(basic);
    expect(t.iss.tokenRequests.at(-1)?.form.client_secret).toBeUndefined();
    await h?.close();
    await issuer?.close();
    const p = await setup({
      clientSecret: 'TEST-oidc-secret',
      authMethods: ['client_secret_post'],
    });
    await p.signIn({ sub: 'sub-ada' });
    expect(p.iss.tokenRequests.at(-1)).toMatchObject({
      authorization: null,
      form: { client_id: p.iss.clientId, client_secret: 'TEST-oidc-secret' },
    });
  });

  it('refuses an issuer whose discovery names another issuer or a plain-http endpoint', async () => {
    const t = await setup();
    t.iss.discovery.issuer = 'https://evil.example';
    const res = await t.req(OIDC_LOGIN_PATH);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/different issuer/);
    expect(res.headers.get('set-cookie')).toBeNull();
    t.iss.discovery.issuer = t.iss.issuer;
    t.iss.discovery.token_endpoint = 'http://idp.example/token';
    expect((await t.req(OIDC_LOGIN_PATH)).status).toBe(502);
  });

  it('the public origin is orbitd’s own; other origins and hosts are refused', async () => {
    const t = await setup();
    const own = await t.req('/v1/bots', { headers: { ...t.bearer, origin: PUBLIC } });
    expect(own.status).toBe(200);
    expect(own.headers.get('access-control-allow-origin')).toBeNull();
    // A proxy may forward the loopback Host; the public origin still counts as own.
    const proxied = await t.app.request('http://127.0.0.1:7420/v1/bots', {
      headers: { ...t.bearer, host: '127.0.0.1:7420', origin: PUBLIC },
    });
    expect(proxied.status).toBe(200);
    for (const origin of [
      'http://orbit.example.com',
      'https://evil.example',
      'https://x.orbit.example.com',
    ]) {
      expect((await t.req('/v1/bots', { headers: { ...t.bearer, origin } })).status, origin).toBe(
        403,
      );
    }
    const foreign = await t.app.request(`https://evil.example/v1/health`, {
      headers: { host: 'evil.example' },
    });
    expect(foreign.status).toBe(403);
  });

  it('webhooks are announced at the public address', async () => {
    const t = await setup();
    const bot = (await (
      await t.as(t.bearer, 'POST', '/v1/bots', {
        name: 'Hooked',
        goal: 'React to pushes',
        triggers: [{ kind: 'webhook', name: 'push' }],
      })
    ).json()) as Bot;
    const secret = (await (
      await t.as(t.bearer, 'POST', `/v1/bots/${bot.id}/webhooks/push/secret`)
    ).json()) as { url: string; path: string };
    expect(secret.url).toBe(`${PUBLIC}/hooks/${bot.id}/push`);
    const listed = (await (await t.as(t.bearer, 'GET', '/v1/triggers')).json()) as {
      url: string | null;
    }[];
    expect(listed[0]?.url).toBe(`${PUBLIC}/hooks/${bot.id}/push`);
  });
});

describe('hosted mode: roles and actors (ADR-015)', () => {
  it('each role reaches what it may and gets a 403 naming the needed role otherwise', async () => {
    const t = await setup();
    await t.as(t.bearer, 'POST', '/v1/bots', {
      name: 'Mailer',
      goal: 'Send the mail',
      mock: { fixture: 'send-email' },
      approvals: { parkWindowSeconds: 0 },
    });
    const viewer = (await t.signIn({ sub: 'x', email: 'cy@example.com', email_verified: true }))
      .headers;
    const operator = (await t.signIn({ sub: 'sub-bob' })).headers;
    const owner = (await t.signIn({ sub: 'sub-ada' })).headers;

    expect((await t.as(viewer, 'GET', '/v1/bots')).status).toBe(200);
    const refused = await t.as(viewer, 'POST', '/v1/bots/mailer/runs', {});
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: 'forbidden', message: 'This needs the operator role; Cy is a viewer' },
    });
    // Secret-ish reads stay with the owner.
    expect((await t.as(viewer, 'GET', '/v1/secrets')).status).toBe(403);
    expect((await t.as(operator, 'GET', '/v1/audit/export')).status).toBe(403);

    const started = await t.as(operator, 'POST', '/v1/bots/mailer/runs', {});
    expect(started.status).toBe(202);
    const run = (await started.json()) as RunState;
    await t.service.queue.idle();
    const ownerOnly = await t.as(operator, 'PUT', '/v1/secrets/team_token', { value: 'team token value 42' });
    expect(ownerOnly.status).toBe(403);
    expect(await ownerOnly.json()).toMatchObject({
      error: { message: 'This needs the owner role; Bob is an operator' },
    });
    expect((await t.as(operator, 'POST', '/v1/kill', { on: true })).status).toBe(403);
    expect(t.service.killStatus().engaged).toBe(false);

    // The operator decides the approval; the audit and the decision name Bob.
    const [approval] = (await (await t.as(viewer, 'GET', '/v1/approvals')).json()) as Approval[];
    expect((await t.as(viewer, 'POST', `/v1/approvals/${approval!.id}/approve`, {})).status).toBe(
      403,
    );
    const decided = await t.as(operator, 'POST', `/v1/approvals/${approval!.id}/approve`, {});
    expect(decided.status).toBe(200);
    expect(((await decided.json()) as { approval: Approval }).approval.decision?.by).toBe('bob');
    await t.service.queue.idle();
    const audit = t.service.auditTail(undefined, 500);
    expect(audit.find((r) => r.action === 'approval.decided')?.actor).toBe('bob');

    // The owner may do owner things, recorded as Ada; the token as `owner`.
    expect((await t.as(owner, 'PUT', '/v1/secrets/team_token', { value: 'team token value 42' })).status).toBe(200);
    expect((await t.as(t.bearer, 'DELETE', '/v1/secrets/team_token')).status).toBe(200);
    const secrets = t.service
      .auditTail(undefined, 500)
      .filter((r) => r.action.startsWith('secret.'));
    expect(secrets.map((r) => [r.action, r.actor])).toEqual([
      ['secret.set', 'ada'],
      ['secret.removed', 'owner'],
    ]);
    // Feedback is the operator's, and names Bob.
    const fb = await t.as(operator, 'POST', `/v1/runs/${run.runId}/feedback`, { rating: 'up' });
    expect(fb.status).toBe(201);
    expect(t.service.auditTail('feedback.recorded', 5).at(-1)?.actor).toBe('bob');
    // A viewer can still sign out.
    expect((await t.as(viewer, 'DELETE', '/v1/session')).status).toBe(200);
    expect((await t.as(viewer, 'GET', '/v1/bots')).status).toBe(401);
  });
});
