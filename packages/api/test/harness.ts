import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { OrbitConfig, type OrbitConfigInput } from '@orbit/core';
import type { WorkspaceProvider } from '@orbit/runtime';
import { type OrbitDb, openDatabase } from '@orbit/store';
import { type AppOptions, createApp } from '../src/app';
import { OrbitService, type ServiceOptions } from '../src/service';

export const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

export interface Harness {
  home: string;
  db: OrbitDb;
  service: OrbitService;
  app: ReturnType<typeof createApp>;
  clock: { now: () => Date; advance(ms: number): void; set(iso: string): void };
  /** app.request with the token and JSON handling. */
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  json<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  listen(): Promise<string>;
  close(): Promise<void>;
}

/** A minimal ustar + gzip packer for test npm packages (plugin installs, ADR-019). */
export function packTarball(files: Record<string, string>): Buffer {
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

/** Plain private directories: no sandbox detection, no git, no docker. */
export function directoryWorkspaces(home: string): WorkspaceProvider {
  return (bot) => {
    const path = join(home, 'workspaces', bot.id);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return Promise.resolve({ path, shellContained: false, engineSandbox: null });
  };
}

export function harness(
  options: {
    config?: Partial<OrbitConfigInput>;
    env?: Record<string, string>;
    service?: Partial<ServiceOptions>;
    home?: string;
    db?: OrbitDb;
    start?: boolean;
    /** Extra createApp options (hosted mode, sessions). */
    app?: Partial<Omit<AppOptions, 'service' | 'token'>>;
  } = {},
): Harness {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'orbit-api-'));
  const db = options.db ?? openDatabase(join(home, 'orbit.db'));
  let t = Date.now();
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
    set: (iso: string) => {
      t = Date.parse(iso);
    },
  };
  const service = new OrbitService({
    config: OrbitConfig.parse({ home, driver: 'mock', ...options.config }),
    env: { PATH: process.env.PATH ?? '', ...options.env },
    db,
    version: '0.1.0-test',
    mock: { delayMs: 0 },
    workspaces: directoryWorkspaces(home),
    vaultKeySource: 'file',
    tickMs: 3_600_000,
    killPollMs: 20,
    log: () => undefined,
    now: clock.now,
    ...options.service,
  });
  if (options.start !== false) service.start();
  const app = createApp({
    service,
    token: TOKEN,
    validateResponses: true,
    heartbeatMs: 50,
    ...options.app,
  });
  let server: ReturnType<typeof serve> | undefined;
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    Promise.resolve(
      app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return {
    home,
    db,
    service,
    app,
    clock,
    call,
    async json<T>(method: string, path: string, body?: unknown) {
      const res = await call(method, path, body);
      return { status: res.status, body: (await res.json()) as T };
    },
    listen: () =>
      new Promise((resolve) => {
        server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info: AddressInfo) =>
          resolve(`http://127.0.0.1:${info.port}`),
        );
      }),
    async close() {
      await service.stop();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      if (!options.db) db.close();
      if (!options.home) rmSync(home, { recursive: true, force: true });
    },
  };
}
