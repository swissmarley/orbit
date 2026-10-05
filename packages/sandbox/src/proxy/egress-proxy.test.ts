import { type AddressInfo, type Server, type Socket, connect, createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAllowlist } from './addresses';
import {
  type Lookup,
  type ProxyServer,
  createEgressProxy,
  decideEgress,
  parseAuthority,
} from './egress-proxy';
import type { ProxyRefusal } from './stats';

const servers: (Server | { close(): void })[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A TCP upstream that answers every line with `echo:<line>`. */
async function echoServer(): Promise<number> {
  return listen(
    createServer((s) => {
      s.on('data', (d) => s.write(`echo:${d.toString()}`));
      s.on('error', () => undefined);
    }),
  );
}

interface Harness {
  proxy: ProxyServer;
  port: number;
  refusals: ProxyRefusal[];
  lookups: string[];
  armed: { value: boolean };
}

async function harness(
  allowed: string[],
  answers: Record<string, string[]> = {},
  extra: { maxTunnels?: number } = {},
): Promise<Harness> {
  const refusals: ProxyRefusal[] = [];
  const lookups: string[] = [];
  const armed = { value: true };
  const lookup: Lookup = (host) => {
    lookups.push(host);
    const a = answers[host];
    return a === undefined
      ? Promise.reject(new Error('ENOTFOUND'))
      : Promise.resolve(a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
  const list = parseAllowlist(allowed);
  const proxy = createEgressProxy({
    allowlist: () => list,
    armed: () => armed.value,
    lookup,
    onRefusal: (r) => refusals.push(r),
    ...extra,
  });
  servers.push({ close: () => proxy.server.close() });
  const port = await new Promise<number>((resolve) => {
    proxy.server.listen(0, '127.0.0.1', () =>
      resolve((proxy.server.address() as AddressInfo).port),
    );
  });
  return { proxy, port, refusals, lookups, armed };
}

/** Send raw bytes to the proxy and collect what comes back until `until` matches or the socket ends. */
function exchange(
  port: number,
  request: string,
  until = /\r\n\r\n/,
): Promise<{ text: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    const done = () => resolve({ text, socket });
    socket.on('data', (d) => {
      text += d.toString();
      if (until.test(text)) done();
    });
    socket.on('end', done);
    socket.on('error', reject);
    socket.write(request);
  });
}

const connectTo = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

describe('parseAuthority', () => {
  it('accepts host:port and [v6]:port only', () => {
    expect(parseAuthority('pypi.org:443')).toEqual({ host: 'pypi.org', port: 443 });
    expect(parseAuthority('[fd00::1]:8443')).toEqual({ host: 'fd00::1', port: 8443 });
    for (const bad of [
      'pypi.org',
      'pypi.org:0',
      'pypi.org:70000',
      'fd00::1:443',
      '[nope]:443',
      ':443',
      'a:b',
    ]) {
      expect(parseAuthority(bad), bad).toBeNull();
    }
  });
});

describe('decideEgress', () => {
  const lookupOf =
    (answers: Record<string, string[]>): Lookup =>
    (host) =>
      answers[host]
        ? Promise.resolve(
            answers[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
          )
        : Promise.reject(new Error('ENOTFOUND'));
  const list = parseAllowlist(['pypi.org', '*.example.com', 'internal.example.org', '10.0.0.5']);

  const table: [string, number, Record<string, string[]>, string][] = [
    ['pypi.org', 443, { 'pypi.org': ['151.101.0.223'] }, 'allow 151.101.0.223'],
    ['pypi.org', 80, { 'pypi.org': ['151.101.0.223'] }, '403 host is not on the allowlist'],
    ['evil.com', 443, { 'evil.com': ['1.2.3.4'] }, '403 host is not on the allowlist'],
    [
      'a.example.com',
      443,
      { 'a.example.com': ['127.0.0.1'] },
      '403 host resolves to a loopback address',
    ],
    [
      'a.example.com',
      443,
      { 'a.example.com': ['169.254.169.254'] },
      '403 host resolves to a link-local address',
    ],
    [
      'a.example.com',
      443,
      { 'a.example.com': ['::ffff:10.0.0.9'] },
      '403 host resolves to a private address',
    ],
    [
      'a.example.com',
      443,
      { 'a.example.com': ['fd00::1'] },
      '403 host resolves to a unique-local address',
    ],
    [
      'a.example.com',
      443,
      { 'a.example.com': ['10.0.0.9', '93.184.215.14'] },
      'allow 93.184.215.14',
    ],
    // The owner allowlisted 10.0.0.5 literally: a name resolving to it may use it.
    ['internal.example.org', 443, { 'internal.example.org': ['10.0.0.5'] }, 'allow 10.0.0.5'],
    [
      'internal.example.org',
      443,
      { 'internal.example.org': ['10.0.0.6'] },
      '403 host resolves to a private address',
    ],
    ['10.0.0.5', 443, {}, 'allow 10.0.0.5'],
    ['10.0.0.6', 443, {}, '403 address is not on the allowlist'],
    ['93.184.215.14', 443, {}, '403 address is not on the allowlist'],
    ['a.example.com', 443, {}, '502 host name did not resolve'],
    ['a.example.com', 443, { 'a.example.com': [] }, '502 host name did not resolve'],
    ['bad_name.example.com', 443, {}, '403 not a valid host name'],
  ];
  for (const [host, port, answers, expected] of table) {
    it(`${host}:${port} → ${expected}`, async () => {
      const d = await decideEgress(list, host, port, lookupOf(answers));
      expect(d.allow ? `allow ${d.address}` : `${d.status} ${d.reason}`).toBe(expected);
    });
  }
});

describe('egress proxy (CONNECT over a socket)', () => {
  it('tunnels to an allowlisted host at the address it checked, once', async () => {
    const upstream = await echoServer();
    // The owner allowlisted the literal loopback address, so a name resolving to it is allowed.
    const h = await harness([`echo.example.com:${upstream}`, `127.0.0.1:${upstream}`], {
      'echo.example.com': ['127.0.0.1'],
    });
    const { text, socket } = await exchange(h.port, connectTo(`echo.example.com:${upstream}`));
    expect(text).toBe('HTTP/1.1 200 Connection Established\r\n\r\n');
    const echoed = await new Promise<string>((resolve) => {
      socket.once('data', (d) => resolve(d.toString()));
      socket.write('hello');
    });
    expect(echoed).toBe('echo:hello');
    socket.destroy();
    expect(h.lookups).toEqual(['echo.example.com']);
    expect(h.proxy.stats()).toMatchObject({ forwarded: 1, refused: 0, failed: 0 });
  });

  it('refuses hosts off the allowlist, private answers and inactive Bots, and counts each', async () => {
    const upstream = await echoServer();
    const h = await harness([`echo.example.com:${upstream}`], {
      'echo.example.com': ['127.0.0.1'],
    });
    const offList = await exchange(h.port, connectTo('evil.com:443'));
    expect(offList.text).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(offList.text).toMatch(/evil\.com:443 refused: host is not on the allowlist/);
    // Allowlisted name, but it resolves to loopback (not allowlisted literally).
    const rebinding = await exchange(h.port, connectTo(`echo.example.com:${upstream}`));
    expect(rebinding.text).toMatch(/^HTTP\/1\.1 403/);
    expect(rebinding.text).toMatch(/loopback/);
    h.armed.value = false;
    const idle = await exchange(h.port, connectTo(`echo.example.com:${upstream}`));
    expect(idle.text).toMatch(/no Run of this Bot is active/);
    expect(h.proxy.stats()).toMatchObject({ forwarded: 0, refused: 3 });
    expect(h.refusals.map((r) => [r.target, r.reason])).toEqual([
      ['evil.com:443', 'host is not on the allowlist'],
      [`echo.example.com:${upstream}`, 'host resolves to a loopback address'],
      [`echo.example.com:${upstream}`, 'no Run of this Bot is active'],
    ]);
    expect(h.proxy.stats().recent).toHaveLength(3);
  });

  it('refuses plain-HTTP proxying without recording paths or query strings', async () => {
    const h = await harness(['pypi.org']);
    const r = await exchange(
      h.port,
      'GET http://pypi.org/simple/?token=s3cret HTTP/1.1\r\nHost: pypi.org\r\n\r\n',
      /only HTTPS/,
    );
    expect(r.text).toMatch(/^HTTP\/1\.1 405/);
    r.socket.destroy();
    expect(h.refusals.map((x) => [x.target, x.reason])).toEqual([
      ['pypi.org:80', 'only HTTPS tunnels (CONNECT) are allowed'],
    ]);
    expect(JSON.stringify(h.proxy.stats())).not.toMatch(/s3cret|simple/);
  });

  it('answers malformed targets with 400 and DNS failures with 502 (counted as failed)', async () => {
    const h = await harness(['nxdomain.example.com']);
    expect((await exchange(h.port, connectTo('no-port-here'))).text).toMatch(/^HTTP\/1\.1 400/);
    expect((await exchange(h.port, connectTo('nxdomain.example.com:443'))).text).toMatch(
      /^HTTP\/1\.1 502/,
    );
    expect(h.proxy.stats()).toMatchObject({ refused: 1, failed: 1 });
  });

  it('answers 502 when the checked address refuses the connection', async () => {
    const closed = await listen(createServer());
    servers.pop()?.close();
    await new Promise((r) => setTimeout(r, 20));
    const h = await harness([`127.0.0.1:${closed}`]);
    const r = await exchange(h.port, connectTo(`127.0.0.1:${closed}`));
    expect(r.text).toMatch(/^HTTP\/1\.1 502/);
    expect(h.proxy.stats()).toMatchObject({ forwarded: 0, failed: 1 });
  });

  it('limits concurrent tunnels and drops them all when the Run ends', async () => {
    const upstream = await echoServer();
    const h = await harness([`127.0.0.1:${upstream}`], {}, { maxTunnels: 1 });
    const first = await exchange(h.port, connectTo(`127.0.0.1:${upstream}`));
    expect(first.text).toMatch(/^HTTP\/1\.1 200/);
    const second = await exchange(h.port, connectTo(`127.0.0.1:${upstream}`));
    expect(second.text).toMatch(/^HTTP\/1\.1 503/);
    const closed = new Promise<void>((resolve) => first.socket.once('close', () => resolve()));
    h.proxy.dropConnections();
    await closed;
  });
});
