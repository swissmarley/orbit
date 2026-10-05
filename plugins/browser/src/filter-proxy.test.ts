import { type IncomingMessage, type Server, createServer, request } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllowlist, requestVerdict } from './allowlist';
import { type FilterProxy, bypassesUpstream, startFilterProxy } from './filter-proxy';

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
