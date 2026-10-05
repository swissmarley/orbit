import { existsSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { type Tool, type ToolContext, handle } from '@orbit/plugin-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSession, resolveExecutable } from './browser';
import { browserTools } from './tools';

/** CI's unit job has no browsers; the e2e job (and a dev machine after `playwright install`) does. */
const chromiumAvailable = existsSync(resolveExecutable(process.env));

const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, port: (server.address() as AddressInfo).port };
};
const stop = (server: Server) =>
  new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });

const html = (res: ServerResponse, body: string, title = 'Test page') => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
};

const ctxFor = (domains: string, extra: Record<string, string> = {}): ToolContext => ({
  workspace: tmpdir(),
  // What Orbit would pass: an allowlisted env, no proxies (so the browser gets the drop-all proxy).
  env: {
    BROWSER_ALLOWED_DOMAINS: domains,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    ...extra,
  },
});

const call = async (
  tools: Tool[],
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const r = await handle(
    { name: 'browser', version: '0', tools },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ctx,
  );
  const result = r?.result as { content: { text: string }[]; isError: boolean };
  return { text: result.content[0]?.text ?? '', isError: result.isError };
};

const fails = (r: { text: string; isError: boolean }, message: RegExp) => {
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(message);
};

describe('browser tools without a browser', () => {
  const session = new BrowserSession();
  const tools = browserTools(session);
  afterAll(() => session.close());

  it('refuses disallowed and non-web URLs before starting a browser', async () => {
    const ctx = ctxFor('example.com');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@example.com/']) {
      expect(await call(tools, ctx, 'open_page', { url })).toMatchObject({ isError: true });
    }
    fails(
      await call(tools, ctx, 'open_page', { url: 'https://evil.org/' }),
      /evil\.org is not in the domains/,
    );
    expect(session.openPage()).toBeUndefined();
  });

  it('says clearly when it is not set up, or there is no page yet', async () => {
    const unset = { workspace: tmpdir(), env: {} };
    fails(
      await call(tools, unset, 'open_page', { url: 'https://x.org/' }),
      /BROWSER_ALLOWED_DOMAINS/,
    );
    fails(await call(tools, ctxFor('example.com'), 'get_text'), /open_page first/);
    const long = { selector: '#q', value: 'x'.repeat(2001) };
    fails(await call(tools, ctxFor('example.com'), 'fill', long), /Invalid arguments/);
  });
});

describe.skipIf(!chromiumAvailable)('browser tools in headless Chromium', () => {
  /** The allowed site, reached as 127.0.0.1. */
  let site: { server: Server; port: number };
  /** Another origin, reached as localhost: never allowed except in the control. */
  let other: { server: Server; port: number };
  const seen: string[] = [];
  const upgrades: string[] = [];
  const siteUpgrades: string[] = [];
  let session: BrowserSession;
  let tools: Tool[];
  const ctx = ctxFor('127.0.0.1');
  const url = (path: string) => `http://127.0.0.1:${site.port}${path}`;
  const elsewhere = (path: string) => `http://localhost:${other.port}${path}`;

  /** A page that reaches the other origin every way it can: image, script, fetch, worker, WebSocket. */
  const leaky = () => `
    <p>Leaky page</p>
    <img src="${elsewhere('/img.png')}">
    <script src="${elsewhere('/script.js')}"></script>
    <script>
      const mark = (id) => { const d = document.createElement('div'); d.id = id; document.body.append(d); };
      fetch('${elsewhere('/fetch')}', { mode: 'no-cors' }).catch(() => {}).finally(() => mark('fetch-done'));
      navigator.sendBeacon('${elsewhere('/beacon')}', 'secret');
      const w = new Worker(URL.createObjectURL(new Blob([
        "fetch('${elsewhere('/worker')}', { mode: 'no-cors' }).catch(() => {}).finally(() => postMessage(1))"
      ])));
      w.onmessage = () => mark('worker-done');
      try {
        const ws = new WebSocket('ws://localhost:${other.port}/ws');
        ws.onclose = () => mark('ws-done');
      } catch { mark('ws-done'); }
    </script>`;

  beforeAll(async () => {
    other = await listen((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('other');
    });
    other.server.on('upgrade', (req, socket) => {
      upgrades.push(req.url ?? '');
      socket.destroy();
    });
    site = await listen((req, res) => {
      const path = req.url ?? '/';
      if (path === '/') {
        html(
          res,
          `<h1>Welcome</h1><p>Allowed page text</p>
           <a href="/form">The form</a> <a href="${elsewhere('/x')}">Elsewhere</a> <a href="mailto:a@b.c">Mail</a>`,
          'Hello Orbit',
        );
      } else if (path === '/leaky') html(res, leaky());
      else if (path === '/redirect-out') {
        res.writeHead(302, { location: elsewhere('/landing') });
        res.end();
      } else if (path === '/redirect-in') {
        res.writeHead(302, { location: '/' });
        res.end();
      } else if (path === '/form') {
        html(
          res,
          `<form action="/result" method="get"><input id="q" name="q"><button id="go" type="submit">Search</button></form>`,
          'Form',
        );
      } else if (path.startsWith('/result')) {
        const q = new URL(path, 'http://x').searchParams.get('q') ?? '';
        html(res, `<p id="out">You searched: ${q.replace(/[<&]/g, '')}</p>`, 'Result');
      } else if (path === '/ws-self') {
        html(
          res,
          `<script>const ws = new WebSocket('ws://127.0.0.1:${site.port}/ws');
            ws.onclose = () => { const d = document.createElement('div'); d.id = 'ws-done'; document.body.append(d); };</script>`,
        );
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    site.server.on('upgrade', (req, socket) => {
      siteUpgrades.push(req.url ?? '');
      socket.destroy();
    });
  });

  beforeEach(() => {
    session = new BrowserSession();
    tools = browserTools(session);
    seen.length = 0;
    upgrades.length = 0;
  });

  afterAll(async () => {
    await session.close();
    await stop(site.server);
    await stop(other.server);
  });

  const waitFor = async (id: string) => {
    await session.openPage()?.waitForSelector(`#${id}`, { state: 'attached', timeout: 10_000 });
  };

  it('opens an allowed page and reads its title and text; lists links', async () => {
    try {
      const r = await call(tools, ctx, 'open_page', { url: url('/') });
      expect(r.isError).toBe(false);
      expect(r.text).toContain(`URL: ${url('/')}`);
      expect(r.text).toContain('Title: Hello Orbit');
      expect(r.text).toContain('Allowed page text');
      expect((await call(tools, ctx, 'get_text', { selector: 'h1' })).text).toBe('Welcome');
      expect(await call(tools, ctx, 'get_text', { selector: '#missing' })).toMatchObject({
        isError: true,
      });
      const links = (await call(tools, ctx, 'list_links')).text;
      expect(links).toContain(`- The form — ${url('/form')}\n`);
      expect(links).toContain(`- Elsewhere — ${elsewhere('/x')} (not allowed)`);
      expect(links).toContain('mailto:a@b.c (not a web page)');
      expect((await call(tools, ctx, 'open_page', { url: url('/nope') })).text).toContain(
        'Status: 404',
      );
    } finally {
      await session.close();
    }
  }, 60_000);

  it('control: when the other origin is allowed, the leaky page does reach it', async () => {
    try {
      // localhost is a loopback name: the owner allows private addresses for it (ADR-019).
      const both = ctxFor('127.0.0.1, localhost', { BROWSER_ALLOW_PRIVATE_ADDRESSES: 'true' });
      expect((await call(tools, both, 'open_page', { url: url('/leaky') })).isError).toBe(false);
      await waitFor('fetch-done');
      await waitFor('worker-done');
      await waitFor('ws-done');
      await session.openPage()?.waitForTimeout(500);
      expect(seen).toEqual(
        expect.arrayContaining(['/img.png', '/script.js', '/fetch', '/beacon', '/worker']),
      );
      // Workers' requests go through the filter too (or fail closed); WebSockets are always blocked.
      expect(upgrades).toEqual([]);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('blocks every request to a host that is not allowed: subresources, fetch, beacon, worker, WebSocket', async () => {
    try {
      const r = await call(tools, ctx, 'open_page', { url: url('/leaky') });
      expect(r.isError).toBe(false);
      expect(r.text).toContain('Leaky page');
      await waitFor('fetch-done');
      await waitFor('worker-done');
      await waitFor('ws-done');
      await session.openPage()?.waitForTimeout(500);
      expect(seen).toEqual([]);
      expect(upgrades).toEqual([]);
      expect(r.text).toMatch(/Blocked requests to hosts outside the allowed domains: localhost/);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('blocks WebSockets also to an allowed host', async () => {
    try {
      siteUpgrades.length = 0;
      await call(tools, ctx, 'open_page', { url: url('/ws-self') });
      await waitFor('ws-done');
      expect(siteUpgrades).toEqual([]);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('follows a redirect inside the allowlist and blocks one that leaves it', async () => {
    try {
      const inside = await call(tools, ctx, 'open_page', { url: url('/redirect-in') });
      expect(inside.isError).toBe(false);
      expect(inside.text).toContain(`URL: ${url('/')}`);
      // Playwright does not route redirect targets: the filter proxy refuses this one.
      const out = await call(tools, ctx, 'open_page', { url: url('/redirect-out') });
      fails(out, /Blocked: .*localhost/);
      expect(seen).toEqual([]);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('refuses an allowed name that resolves to a loopback address (DNS check, ADR-019)', async () => {
    try {
      const r = await call(tools, ctxFor('localhost'), 'open_page', {
        url: `http://localhost:${other.port}/secret`,
      });
      fails(r, /Blocked: opening localhost led to localhost \(refused: .* is a loopback address\)/);
      expect(seen).toEqual([]);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('resolves names only in the proxy: Chromium never looks one up itself', async () => {
    // site.example exists only in the proxy's resolver; Chromium maps every name to "not found".
    const dnsSession = new BrowserSession((host) =>
      Promise.resolve(host === 'site.example' ? [{ address: '127.0.0.1', family: 4 }] : []),
    );
    const dnsTools = browserTools(dnsSession);
    try {
      const allowed = ctxFor('site.example', { BROWSER_ALLOW_PRIVATE_ADDRESSES: 'true' });
      const r = await call(dnsTools, allowed, 'open_page', {
        url: `http://site.example:${site.port}/`,
      });
      expect(r.isError).toBe(false);
      expect(r.text).toContain('Allowed page text');
      // Without the owner's yes, the same answer is refused.
      await dnsSession.close();
      const refused = await call(dnsTools, ctxFor('site.example'), 'open_page', {
        url: `http://site.example:${site.port}/`,
      });
      fails(refused, /refused: 127\.0\.0\.1 is a loopback address/);
    } finally {
      await dnsSession.close();
    }
  }, 60_000);

  it('fills and clicks on a form', async () => {
    try {
      await call(tools, ctx, 'open_page', { url: url('/form') });
      expect(await call(tools, ctx, 'fill', { selector: '#q', value: 'orbit bots' })).toMatchObject(
        {
          isError: false,
          text: 'Filled #q (10 characters)',
        },
      );
      const clicked = await call(tools, ctx, 'click', { selector: '#go' });
      expect(clicked.isError).toBe(false);
      expect(clicked.text).toContain(`Now at ${url('/result?q=orbit+bots')} (Result)`);
      expect((await call(tools, ctx, 'get_text')).text).toBe('You searched: orbit bots');
      fails(
        await call(tools, ctx, 'click', { selector: '#nothing' }),
        /No usable element matches #nothing/,
      );
    } finally {
      await session.close();
    }
  }, 60_000);
});
