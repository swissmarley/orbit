import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveExecutable } from './browser';

const PLUGIN_DIR = join(import.meta.dirname, '..');
const chromiumAvailable = existsSync(resolveExecutable(process.env));

interface Manifest {
  tools: { name: string; tier: string; egress?: boolean }[];
}
const manifest = JSON.parse(
  readFileSync(join(PLUGIN_DIR, 'orbit-plugin.json'), 'utf8'),
) as Manifest;

/** The server as orbitd starts it (`${node} --import ${tsx} …/src/server.ts`) with an allowlisted env. */
function start() {
  const child = spawn(process.execPath, ['--import', 'tsx', join(PLUGIN_DIR, 'src', 'server.ts')], {
    cwd: PLUGIN_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
      BROWSER_ALLOWED_DOMAINS: '127.0.0.1',
    },
  });
  const pending = new Map<number, (r: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line) as { id: number; result: Record<string, unknown> };
    pending.get(msg.id)?.(msg.result);
  });
  let next = 1;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  return { child, rpc, exited };
}

/** Live (non-zombie) descendants of a process, from /proc. */
function descendants(root: number): number[] {
  const parent = new Map<number, number>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parent.set(Number(d), Number(fields[1]));
    } catch {
      // gone
    }
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const [pid, pp] of parent) {
      if (pp === p) {
        out.push(pid);
        walk(pid);
      }
    }
  };
  walk(root);
  return out;
}
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

describe('browser plugin server', () => {
  let child: ChildProcess | undefined;
  afterAll(() => {
    child?.kill('SIGKILL');
  });

  it('serves exactly the tools its manifest declares', async () => {
    const s = start();
    child = s.child;
    const init = await s.rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.serverInfo).toEqual({ name: 'browser', version: '0.1.0' });
    const listed = (await s.rpc('tools/list')).tools as { name: string; description: string }[];
    expect(listed.map((t) => t.name)).toEqual(manifest.tools.map((t) => t.name));
    expect(manifest.tools.map((t) => [t.name, t.tier, t.egress ?? false])).toEqual([
      ['open_page', 'READ', true],
      ['get_text', 'READ', false],
      ['list_links', 'READ', false],
      ['click', 'EXTERNAL', false],
      ['fill', 'EXTERNAL', false],
    ]);
    for (const t of listed.filter((t) =>
      ['open_page', 'get_text', 'list_links'].includes(t.name),
    )) {
      expect(t.description).toMatch(/untrusted data/);
    }
    s.child.stdin.end();
    expect(await s.exited).toBe(0);
  }, 30_000);
});

describe.skipIf(!chromiumAvailable || process.platform !== 'linux')(
  'browser plugin server lifecycle',
  () => {
    let site: Server;
    let port: number;
    beforeAll(async () => {
      site = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<title>Lifecycle</title><p>Still here</p>');
      });
      await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
      port = (site.address() as AddressInfo).port;
    });
    afterAll(
      () =>
        new Promise<void>((done) => {
          site.closeAllConnections();
          site.close(() => done());
        }),
    );

    const openThen = async (end: (c: ChildProcess) => void) => {
      const s = start();
      try {
        await s.rpc('initialize');
        const r = (await s.rpc('tools/call', {
          name: 'open_page',
          arguments: { url: `http://127.0.0.1:${port}/` },
        })) as { content: { text: string }[]; isError: boolean };
        expect(r.content[0]?.text).toContain('Still here');
        const browserPids = descendants(s.child.pid ?? -1);
        expect(browserPids.length).toBeGreaterThan(0);
        end(s.child);
        await s.exited;
        // Give the kernel a moment to reap the killed process group.
        for (let i = 0; i < 50 && browserPids.some(alive); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(browserPids.filter(alive)).toEqual([]);
      } finally {
        s.child.kill('SIGKILL');
      }
    };

    it(
      'closes the browser when orbitd closes stdin',
      () => openThen((c) => c.stdin?.end()),
      60_000,
    );
    it('closes the browser on SIGTERM', () => openThen((c) => c.kill('SIGTERM')), 60_000);
  },
);
