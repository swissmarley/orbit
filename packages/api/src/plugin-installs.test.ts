import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { PluginCatalogListing, PluginStatus } from '@orbit/core';
import type { PluginSandboxSupport } from '@orbit/sandbox';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { type Harness, harness } from '../test/harness';
import type { DoctorReport, InstallPluginResult } from './contract';

/** A minimal ustar + gzip packer for the test package. */
function tgz(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const sri = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

const PACKAGE = tgz({
  'package/package.json': JSON.stringify({ name: 'orbit-plugin-clock', version: '1.0.0' }),
  'package/orbit-plugin.json': JSON.stringify({
    schemaVersion: 1,
    id: 'clock',
    name: 'Clock',
    version: '1.0.0',
    server: { transport: 'stdio', command: '${node}', args: ['${pluginDir}/server.js'] },
    tools: [{ name: 'get_time', tier: 'READ' }],
  }),
  'package/server.js': `
const { createInterface } = require('node:readline');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'clock', version: '1' } } });
  send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'get_time', description: '', inputSchema: { type: 'object' } }] } });
});
`,
});
const INTEGRITY = sri(PACKAGE);

const NO_SANDBOX: PluginSandboxSupport = {
  available: false,
  engine: null,
  path: null,
  reason: 'bubblewrap (bwrap) is not installed',
  platform: 'linux',
};

let server: Server;
let base: string;
let store: string;
let current: Harness | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/orbit-plugin-clock/-/orbit-plugin-clock-1.0.0.tgz') {
      res.end(PACKAGE);
    } else if (req.url === '/catalog.json') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          plugins: [
            {
              id: 'clock',
              name: 'Clock',
              package: 'orbit-plugin-clock',
              version: '1.0.0',
              integrity: INTEGRITY,
            },
          ],
        }),
      );
    } else res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));
afterEach(async () => {
  await current?.close();
  current = undefined;
  rmSync(store, { recursive: true, force: true });
});

function start(sandbox: 'auto' | 'required' | 'off' = 'auto'): Harness {
  store = mkdtempSync(join(tmpdir(), 'orbit-store-'));
  current = harness({
    config: {
      plugins: { sandbox, catalogUrl: `${base}/catalog.json`, npmRegistry: base, storeDir: store },
    },
    service: { pluginsDir: null, pluginSandbox: NO_SANDBOX },
  });
  return current;
}

describe('plugin installs (ADR-019)', () => {
  it('lists the catalog, previews an install, installs it off, and removes its files', async () => {
    const h = start();
    const listing = await h.json<PluginCatalogListing>('GET', '/v1/plugin-catalog');
    expect(listing.status).toBe(200);
    expect(listing.body).toMatchObject({
      error: null,
      entries: [{ id: 'clock', package: 'orbit-plugin-clock', installed: false }],
    });

    const dry = await h.json<z.infer<typeof InstallPluginResult>>('POST', '/v1/plugin-installs', {
      source: 'catalog',
      id: 'clock',
      dryRun: true,
    });
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.plugin).toBeNull();
    expect(dry.body.preview).toMatchObject({
      id: 'clock',
      integrity: INTEGRITY,
      fromCatalog: true,
    });
    expect((await h.json<PluginStatus[]>('GET', '/v1/plugins')).body).toEqual([]);

    const done = await h.json<z.infer<typeof InstallPluginResult>>('POST', '/v1/plugin-installs', {
      source: 'npm',
      package: 'orbit-plugin-clock',
      version: '1.0.0',
      integrity: INTEGRITY,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.plugin).toMatchObject({
      id: 'clock',
      state: 'disabled',
      source: { kind: 'npm', package: 'orbit-plugin-clock', integrity: INTEGRITY },
      sandbox: { state: 'unsandboxed', reason: NO_SANDBOX.reason },
    });
    expect(existsSync(join(store, 'clock@1.0.0'))).toBe(true);

    const again = await h.json<{ error: { code: string } }>('POST', '/v1/plugin-installs', {
      source: 'catalog',
      id: 'clock',
    });
    expect(again.status).toBe(409);

    expect((await h.call('DELETE', '/v1/plugins/clock')).status).toBe(200);
    expect(existsSync(join(store, 'clock@1.0.0'))).toBe(false);
  });

  it('validates the request: exact versions and a sha512 integrity only', async () => {
    const h = start();
    for (const body of [
      { source: 'npm', package: 'orbit-plugin-clock', version: '^1.0.0', integrity: INTEGRITY },
      { source: 'npm', package: 'orbit-plugin-clock', version: 'latest', integrity: INTEGRITY },
      { source: 'npm', package: 'orbit-plugin-clock', version: '1.0.0', integrity: 'sha1-abc' },
      { source: 'npm', package: 'Not A Package', version: '1.0.0', integrity: INTEGRITY },
      { source: 'git', url: 'https://example.com/x.git' },
    ]) {
      expect((await h.call('POST', '/v1/plugin-installs', body)).status, JSON.stringify(body)).toBe(
        400,
      );
    }
    const wrong = await h.json<{ error: { message: string } }>('POST', '/v1/plugin-installs', {
      source: 'npm',
      package: 'orbit-plugin-clock',
      version: '1.0.0',
      integrity: sri(Buffer.from('other')),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toMatch(/does not match its integrity/);
  });

  it('doctor reports the plugin sandbox, and warns when it is off or a plugin runs without it', async () => {
    const off = start('off');
    let d = (await off.json<DoctorReport>('GET', '/v1/doctor')).body;
    expect(d.sandbox.plugins).toMatchObject({
      mode: 'off',
      available: false,
      reason: NO_SANDBOX.reason,
    });
    expect(d.warnings.map((w) => w.code)).toContain('plugin_sandbox_off');
    await off.close();
    current = undefined;

    const auto = start('auto');
    await auto.json('POST', '/v1/plugin-installs', {
      source: 'catalog',
      id: 'clock',
    });
    await auto.service.plugins.enable('clock', 'owner');
    d = (await auto.json<DoctorReport>('GET', '/v1/doctor')).body;
    expect(d.sandbox.plugins.notSandboxed).toEqual([
      { id: 'clock', state: 'unsandboxed', reason: NO_SANDBOX.reason },
    ]);
    expect(d.warnings).toContainEqual({
      code: 'plugin_unsandboxed',
      message: `Plugin clock runs without an OS sandbox: ${NO_SANDBOX.reason}.`,
    });
  }, 20_000);
});
