import { type IncomingMessage, type Server, createServer, request } from 'node:http';
import { type AddressInfo, connect, createServer as createNetServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addressRefusal } from './address';
import { isIpLiteral, parseAllowlist, requestVerdict } from './allowlist';
import {
  type FilterProxy,
  type Resolver,
  bypassesUpstream,
  checkHost,
  startFilterProxy,
} from './filter-proxy';

const listen = async (server: Server) => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
};
const stop = (server: Server) =>
  new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });

/** GET `url` through the proxy (absolute-form, as a browser does for http). */
const viaProxy = (port: number, url: string) =>
  new Promise<{ status: number; body: string } | 'refused'>((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: url,
      method: 'GET',
      headers: { host: new URL(url).host },
    });
    req.on('response', (res: IncomingMessage) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', () => resolve('refused'));
    req.end();
  });

/** CONNECT through the proxy; resolves with the proxy's status line. */
const tunnel = (port: number, authority: string) =>
  new Promise<string>((resolve) => {
    const s = connect(port, '127.0.0.1', () =>
      s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    );
    s.once('data', (d: Buffer) => {
      resolve(d.toString().split('\r\n')[0] ?? '');
      s.destroy();
    });
    s.on('error', () => resolve('error'));
  });

describe('filter proxy', () => {
  const hits: string[] = [];
  let target: Server;
  let targetPort: number;
  let proxy: FilterProxy;
  const blocked: string[] = [];

  beforeAll(async () => {
    target = createServer((req, res) => {
      hits.push(`${req.headers.host ?? ''}${req.url ?? ''}`);
      res.end(`hello ${req.url ?? ''}`);
    });
    targetPort = await listen(target);
    const allow = parseAllowlist('127.0.0.1');
    proxy = await startFilterProxy({
      allowed: (url) => requestVerdict(allow, url).allowed,
      onBlocked: (h) => blocked.push(h),
    });
  });
  afterAll(async () => {
    await proxy.close();
    await stop(target);
  });

  it('forwards http requests to allowed hosts only; a refused one never connects', async () => {
    expect(await viaProxy(proxy.port, `http://127.0.0.1:${targetPort}/ok?x=1`)).toEqual({
      status: 200,
      body: 'hello /ok?x=1',
    });
    expect(await viaProxy(proxy.port, `http://localhost:${targetPort}/leak`)).toBe('refused');
    expect(await viaProxy(proxy.port, `http://user:pw@127.0.0.1:${targetPort}/creds`)).toBe(
      'refused',
    );
    expect(hits).toEqual([`127.0.0.1:${targetPort}/ok?x=1`]);
    expect(blocked).toEqual(['localhost', '127.0.0.1']);
  });

  it('opens tunnels to allowed hosts only', async () => {
    expect(await tunnel(proxy.port, `127.0.0.1:${targetPort}`)).toBe(
      'HTTP/1.1 200 Connection Established',
    );
    expect(await tunnel(proxy.port, `localhost:${targetPort}`)).toBe('HTTP/1.1 403 Forbidden');
    expect(await tunnel(proxy.port, 'example.com:443')).toBe('HTTP/1.1 403 Forbidden');
  });

  it('chains to the owner proxy, honouring NO_PROXY', async () => {
    const upstreamSeen: string[] = [];
    const upstream = createServer((req, res) => {
      upstreamSeen.push(`${req.url ?? ''} ${req.headers['proxy-authorization'] ?? ''}`);
      res.end('from upstream');
    });
    const upPort = await listen(upstream);
    const allow = parseAllowlist('127.0.0.1, example.com');
    const chained = await startFilterProxy({
      allowed: (url) => requestVerdict(allow, url).allowed,
      onBlocked: () => undefined,
      upstream: { server: `http://u:p@127.0.0.1:${upPort}`, bypass: '127.0.0.1,.internal' },
    });
    try {
      expect(await viaProxy(chained.port, 'http://example.com/page')).toEqual({
        status: 200,
        body: 'from upstream',
      });
      expect(upstreamSeen).toEqual([
        `http://example.com/page Basic ${Buffer.from('u:p').toString('base64')}`,
      ]);
      // 127.0.0.1 is in NO_PROXY: straight to the target.
      expect(await viaProxy(chained.port, `http://127.0.0.1:${targetPort}/direct`)).toMatchObject({
        status: 200,
      });
      expect(upstreamSeen).toHaveLength(1);
    } finally {
      await chained.close();
      await stop(upstream);
    }
  });

  it('sends the owner proxy the authority it checked, not the browser’s raw one', async () => {
    const seen: string[] = [];
    const upstream = createNetServer((s) => {
      s.once('data', (d: Buffer) => {
        seen.push(d.toString().split('\r\n')[0] ?? '');
        s.end('HTTP/1.1 200 Connection Established\r\n\r\n');
      });
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const upPort = (upstream.address() as AddressInfo).port;
    const allow = parseAllowlist('example.com');
    const chained = await startFilterProxy({
      allowed: (url) => requestVerdict(allow, url).allowed,
      onBlocked: () => undefined,
      upstream: { server: `http://127.0.0.1:${upPort}`, bypass: '' },
      resolve: () => Promise.resolve([{ address: '93.184.215.14', family: 4 }]),
    });
    try {
      expect(await tunnel(chained.port, 'EXAMPLE.com:0443')).toBe(
        'HTTP/1.1 200 Connection Established',
      );
      expect(seen).toEqual(['CONNECT example.com:443 HTTP/1.1']);
    } finally {
      await chained.close();
      await new Promise<void>((done) => upstream.close(() => done()));
    }
  });

  it('matches NO_PROXY entries', () => {
    expect(bypassesUpstream('localhost,.corp.example,*.lan', 'LOCALHOST')).toBe(true);
    expect(bypassesUpstream('localhost,.corp.example,*.lan', 'a.corp.example')).toBe(true);
    expect(bypassesUpstream('localhost,.corp.example,*.lan', 'printer.lan')).toBe(true);
    expect(bypassesUpstream('localhost,.corp.example,*.lan', 'corp.example.org')).toBe(false);
    expect(bypassesUpstream('example.com', 'www.example.com')).toBe(false);
    expect(bypassesUpstream('*', 'anything')).toBe(true);
    expect(bypassesUpstream(undefined, 'anything')).toBe(false);
    expect(bypassesUpstream('::1', '[::1]')).toBe(true);
  });
});

describe('filter proxy: DNS answers (ADR-019)', () => {
  const hits: string[] = [];
  let target: Server;
  let targetPort: number;
  /** Names the fake DNS knows; every lookup is counted. */
  const dns = new Map<string, string[]>();
  const lookups: string[] = [];
  const resolve: Resolver = (host) => {
    lookups.push(host);
    const answers = dns.get(host) ?? [];
    return Promise.resolve(
      answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  };

  beforeAll(async () => {
    target = createServer((req, res) => {
      hits.push(`${req.headers.host ?? ''}${req.url ?? ''}`);
      res.end('reached');
    });
    targetPort = await listen(target);
  });
  afterAll(() => stop(target));

  /** A proxy over an allowlist, with this policy for the addresses names resolve to. */
  const proxyFor = async (domains: string, allowPrivate = false) => {
    const allow = parseAllowlist(domains);
    const blocked: string[] = [];
    const proxy = await startFilterProxy({
      allowed: (url) => requestVerdict(allow, url).allowed,
      addressAllowed: (address) =>
        addressRefusal(address, {
          listed: new Set([...allow.exact].filter(isIpLiteral)),
          allowPrivate,
        }),
      resolve,
      onBlocked: (host, reason) => blocked.push(reason ? `${host}: ${reason}` : host),
    });
    return { proxy, blocked };
  };

  it('refuses an allowed name that resolves to a private, loopback or metadata address', async () => {
    dns.set('intranet.example.com', ['10.0.0.5']);
    dns.set('local.example.com', ['127.0.0.1']);
    dns.set('meta.example.com', ['169.254.169.254']);
    dns.set('mapped.example.com', ['::ffff:127.0.0.1']);
    dns.set('mixed.example.com', ['93.184.216.34', '192.168.1.1']);
    const { proxy, blocked } = await proxyFor('*.example.com');
    try {
      expect(await viaProxy(proxy.port, `http://local.example.com:${targetPort}/x`)).toBe(
        'refused',
      );
      expect(await tunnel(proxy.port, `intranet.example.com:${targetPort}`)).toBe(
        'HTTP/1.1 403 Forbidden',
      );
      expect(await tunnel(proxy.port, 'meta.example.com:80')).toBe('HTTP/1.1 403 Forbidden');
      expect(await tunnel(proxy.port, `mapped.example.com:${targetPort}`)).toBe(
        'HTTP/1.1 403 Forbidden',
      );
      // One bad answer among good ones refuses the name.
      expect(await tunnel(proxy.port, 'mixed.example.com:443')).toBe('HTTP/1.1 403 Forbidden');
      expect(hits).toEqual([]);
      expect(blocked).toEqual([
        'local.example.com: 127.0.0.1 is a loopback address',
        'intranet.example.com: 10.0.0.5 is a private address',
        'meta.example.com: 169.254.169.254 is a cloud metadata address',
        'mapped.example.com: [::ffff:7f00:1] is a loopback address',
        'mixed.example.com: 192.168.1.1 is a private address',
      ]);
    } finally {
      await proxy.close();
    }
  });

  it('connects to exactly the address it checked, resolving once (no DNS rebinding)', async () => {
    // A name whose first answer passes the policy (treated as public here) and whose
    // later answers would be private: only the first lookup is ever used.
    let calls = 0;
    const rebinding: Resolver = (host) => {
      calls += 1;
      lookups.push(host);
      return Promise.resolve([{ address: calls === 1 ? '127.0.0.1' : '10.9.9.9', family: 4 }]);
    };
    const allow = parseAllowlist('rebind.example.com');
    const proxy = await startFilterProxy({
      allowed: (url) => requestVerdict(allow, url).allowed,
      // Positive control: the checked address passes, so the request goes through.
      addressAllowed: (address) => (address === '127.0.0.1' ? null : `${address} is private`),
      resolve: rebinding,
      onBlocked: () => undefined,
    });
    try {
      expect(await viaProxy(proxy.port, `http://rebind.example.com:${targetPort}/page`)).toEqual({
        status: 200,
        body: 'reached',
      });
      // The name never resolves in real DNS: the connection used the pinned answer, and the
      // Host header still names the site.
      expect(hits.at(-1)).toBe(`rebind.example.com:${targetPort}/page`);
      expect(calls).toBe(1);
      expect(await tunnel(proxy.port, `rebind.example.com:${targetPort}`)).toBe(
        'HTTP/1.1 403 Forbidden',
      );
      expect(calls).toBe(2);
    } finally {
      await proxy.close();
    }
  });

  it('lets an owner reach a listed IP literal, or private addresses when allowed', async () => {
    dns.set('nas.example.com', ['127.0.0.1']);
    const literal = await proxyFor('127.0.0.1');
    const intranet = await proxyFor('nas.example.com', true);
    try {
      expect(
        await viaProxy(literal.proxy.port, `http://127.0.0.1:${targetPort}/lit`),
      ).toMatchObject({ status: 200 });
      expect(
        await viaProxy(intranet.proxy.port, `http://nas.example.com:${targetPort}/nas`),
      ).toEqual({
        status: 200,
        body: 'reached',
      });
      expect(await tunnel(intranet.proxy.port, `nas.example.com:${targetPort}`)).toBe(
        'HTTP/1.1 200 Connection Established',
      );
    } finally {
      await literal.proxy.close();
      await intranet.proxy.close();
    }
  });

  it('refuses a name that does not resolve, unless an owner proxy resolves it', async () => {
    const { proxy, blocked } = await proxyFor('*.example.com');
    try {
      expect(await tunnel(proxy.port, 'nowhere.example.com:443')).toBe('HTTP/1.1 403 Forbidden');
      expect(blocked).toEqual(['nowhere.example.com: nowhere.example.com does not resolve']);
    } finally {
      await proxy.close();
    }
    expect(await checkHost('nowhere.example.com', { resolve }, true)).toEqual({
      ok: true,
      addresses: null,
    });
    dns.set('private.example.com', ['10.1.1.1']);
    // Through the owner's proxy a private answer is still refused.
    expect(
      await checkHost(
        'private.example.com',
        {
          resolve,
          addressAllowed: (a) => addressRefusal(a, { listed: new Set(), allowPrivate: false }),
        },
        true,
      ),
    ).toEqual({ ok: false, reason: '10.1.1.1 is a private address' });
  });
});
