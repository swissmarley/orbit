import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { type IncomingHttpHeaders, createServer, request } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotSandbox, OrbitError } from '@orbit/core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ProxyHost } from './host';
import { staticApiKey } from './key-source';
import type { ProxyRefusal } from './stats';

const KEY = 'sk-ant-api03-HOSTTEST';
const root = mkdtempSync(join(tmpdir(), 'orbit-ph-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
const hosts: ProxyHost[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const s of servers.splice(0)) s.close();
});

let n = 0;
const dir = () => {
  n += 1;
  const d = join(root, `b${n}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const sandbox = (over: Partial<BotSandbox> = {}) => BotSandbox.parse({ kind: 'docker', ...over });

async function fakeApi(): Promise<{ base: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function host(base: string, refusals: [string, string, ProxyRefusal][] = []): ProxyHost {
  const h = new ProxyHost({
    upstream: base,
    key: staticApiKey(KEY),
    lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    onRefusal: (botId, proxy, r) => refusals.push([botId, proxy, r]),
  });
  hosts.push(h);
  return h;
}

function post(socketPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        // A fresh connection each time: a Run's end drops idle keep-alive connections.
        agent: false,
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end('{"model":"sonnet","messages":[]}');
  });
}

function connectThrough(socketPath: string, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, agent: false, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(String(res.statusCode));
    });
    req.on('response', (res) => {
      res.resume();
      resolve(String(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('ProxyHost', () => {
  it('serves a key-injecting API socket per Bot, forwarding only while a Run holds it', async () => {
    const api = await fakeApi();
    const refusals: [string, string, ProxyRefusal][] = [];
    const h = host(api.base, refusals);
    const d = dir();
    await h.ensure('bot_a', d, sandbox());
    const sock = join(d, 'api.sock');
    expect(statSync(sock).isSocket()).toBe(true);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(existsSync(join(d, 'egress.sock'))).toBe(false);

    // Between Runs: nothing goes through (a process left in the container cannot spend the key).
    expect(await post(sock)).toBe(403);
    const release = h.acquire('bot_a');
    expect(h.activeRuns('bot_a')).toBe(1);
    expect(await post(sock)).toBe(200);
    expect(api.seen[0]?.['x-api-key']).toBe(KEY);
    release();
    release(); // releasing twice is harmless
    expect(h.activeRuns('bot_a')).toBe(0);
    expect(await post(sock)).toBe(403);
    expect(refusals.map(([bot, proxy, r]) => [bot, proxy, r.reason])).toEqual([
      ['bot_a', 'api', 'no Run of this Bot is active'],
      ['bot_a', 'api', 'no Run of this Bot is active'],
    ]);
    expect(h.status()[0]?.api).toMatchObject({ forwarded: 1, refused: 2, failed: 0 });
    expect(h.status()).toMatchObject([
      {
        botId: 'bot_a',
        network: 'none',
        activeRuns: 0,
        egress: null,
        invalidAllowlistEntries: [],
      },
    ]);
  });

  it('starts the egress socket with an allowlist, reads the allowlist live and removes it for none', async () => {
    const api = await fakeApi();
    const echo = createNetServer((s) => s.on('error', () => undefined));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    servers.push(echo);
    const port = (echo.address() as AddressInfo).port;
    const h = host(api.base);
    const d = dir();
    await h.ensure(
      'bot_b',
      d,
      sandbox({ network: 'allowlist', allowedDomains: ['a.example.com', 'bad entry'] }),
    );
    const egress = join(d, 'egress.sock');
    expect(statSync(egress).mode & 0o777).toBe(0o600);
    const release = h.acquire('bot_b');
    // a.example.com resolves to 127.0.0.1 (fake DNS): refused, loopback is not allowlisted literally.
    expect(await connectThrough(egress, 'a.example.com:443')).toBe('403');
    await h.ensure(
      'bot_b',
      d,
      sandbox({
        network: 'allowlist',
        allowedDomains: [`a.example.com:${port}`, `127.0.0.1:${port}`],
      }),
    );
    expect(await connectThrough(egress, `a.example.com:${port}`)).toBe('200');
    expect(h.status()[0]).toMatchObject({
      network: 'allowlist',
      egress: { forwarded: 1, refused: 1 },
      invalidAllowlistEntries: [],
    });
    await h.ensure('bot_b', d, sandbox({ network: 'none' }));
    expect(existsSync(egress)).toBe(false);
    expect(h.status()[0]?.egress).toBeNull();
    release();
  });

  it('replaces a stale socket left by an earlier orbitd and removes its sockets on close', async () => {
    const api = await fakeApi();
    const d = dir();
    const first = host(api.base);
    await first.ensure('bot_c', d, sandbox());
    // Simulate a crash: the socket file stays behind.
    const stale = new ProxyHost({ upstream: api.base, key: null });
    hosts.push(stale);
    await stale.ensure('bot_c', d, sandbox());
    expect(statSync(join(d, 'api.sock')).isSocket()).toBe(true);
    await stale.close();
    expect(existsSync(join(d, 'api.sock'))).toBe(false);
  });

  it('refuses socket paths longer than a Unix socket allows', async () => {
    const api = await fakeApi();
    const long = join(root, 'x'.repeat(120));
    mkdirSync(long, { recursive: true });
    const err = await host(api.base)
      .ensure('bot_d', long, sandbox())
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(OrbitError);
    expect((err as OrbitError).hint).toMatch(/ORBIT_HOME/);
  });

  it('refuses an upstream that would carry the key in clear text to another machine', () => {
    expect(() => new ProxyHost({ upstream: 'http://gateway.internal', key: null })).toThrow(
      /only over https/,
    );
  });
});
