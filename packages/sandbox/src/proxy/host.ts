import { chmodSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OrbitError, type BotSandbox } from '@orbit/core';
import { type ParsedAllowlist, parseAllowlist } from './addresses';
import { type ApiProxyOptions, createApiProxy, parseUpstream, type Upstream } from './api-proxy';
import { type Lookup, type ProxyServer, createEgressProxy } from './egress-proxy';
import type { ApiKeySource } from './key-source';
import type { ProxyCounters, ProxyRefusal } from './stats';

/** Socket names inside a Bot's socket directory (mounted at CONTAINER_SOCKET_DIR). */
export const API_SOCKET = 'api.sock';
export const EGRESS_SOCKET = 'egress.sock';

/** Linux `sun_path` holds 108 bytes including the terminating NUL. */
const MAX_SOCKET_PATH = 107;

export interface BotProxyStatus {
  botId: string;
  network: 'none' | 'allowlist';
  /** Runs of this Bot holding the proxies open right now. */
  activeRuns: number;
  api: ProxyCounters;
  /** Null when the Bot has no network (no egress proxy runs). */
  egress: ProxyCounters | null;
  /** allowedDomains entries that are not a host, `*.` wildcard or IP literal (they never match). */
  invalidAllowlistEntries: string[];
}

export interface ProxyHostOptions {
  /** orbitd's API base URL (ANTHROPIC_BASE_URL, default https://api.anthropic.com). */
  upstream: string;
  key: ApiKeySource | null;
  lookup?: Lookup;
  /** Test hooks for the API upstream (self-signed CA, custom agent). */
  api?: Pick<ApiProxyOptions, 'ca' | 'agent' | 'maxBodyBytes'>;
  onRefusal?: (botId: string, proxy: 'api' | 'egress', r: ProxyRefusal) => void;
  now?: () => Date;
}

interface Listening {
  proxy: ProxyServer;
  path: string;
}

interface BotEntry {
  dir: string;
  network: 'none' | 'allowlist';
  allowlist: ParsedAllowlist;
  leases: number;
  api: Listening;
  egress: Listening | null;
}

/** Bind a proxy to a fresh 0600 Unix socket (a stale one from an earlier orbitd is replaced). */
async function listen(proxy: ProxyServer, path: string): Promise<Listening> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    throw new OrbitError('invalid_config', `Socket path ${path} is too long for a Unix socket`, {
      hint: 'Set ORBIT_HOME to a shorter path (Unix socket paths are limited to 107 bytes).',
    });
  }
  try {
    if (lstatSync(path).isSocket()) rmSync(path, { force: true });
  } catch {
    // nothing there
  }
  await new Promise<void>((resolve, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(path, () => {
      proxy.server.off('error', reject);
      resolve();
    });
  });
  proxy.server.unref();
  chmodSync(path, 0o600);
  return { proxy, path };
}

async function close(l: Listening): Promise<void> {
  l.proxy.dropConnections();
  await new Promise<void>((resolve) => {
    l.proxy.server.close(() => resolve());
  });
  rmSync(l.path, { force: true });
}

/**
 * orbitd's host-side proxies for container Bots (ADR-018): per Bot, a
 * key-injecting API proxy and (with `network: allowlist`) an egress proxy,
 * each on a Unix socket in the Bot's 0700 socket directory. They forward
 * only while a Run of the Bot holds a lease, so a process the Bot left
 * behind in its container cannot use them between Runs.
 */
export class ProxyHost {
  private readonly upstream: Upstream;
  private readonly bots = new Map<string, BotEntry>();

  constructor(private readonly opts: ProxyHostOptions) {
    this.upstream = parseUpstream(opts.upstream);
  }

  /** Start (or reconfigure) a Bot's proxies in `dir`. Idempotent. */
  async ensure(botId: string, dir: string, sandbox: BotSandbox): Promise<void> {
    let entry = this.bots.get(botId);
    if (entry !== undefined && entry.dir !== dir) {
      await this.stop(botId);
      entry = undefined;
    }
    const allowlist = parseAllowlist(sandbox.network === 'allowlist' ? sandbox.allowedDomains : []);
    if (entry === undefined) {
      const created: BotEntry = {
        dir,
        network: sandbox.network,
        allowlist,
        leases: 0,
        api: await listen(
          createApiProxy({
            upstream: this.upstream,
            key: this.opts.key,
            armed: () => created.leases > 0,
            webTools: () => created.network === 'allowlist',
            ...this.opts.api,
            ...(this.opts.onRefusal
              ? { onRefusal: (r: ProxyRefusal) => this.opts.onRefusal?.(botId, 'api', r) }
              : {}),
            ...(this.opts.now ? { now: this.opts.now } : {}),
          }),
          join(dir, API_SOCKET),
        ),
        egress: null,
      };
      this.bots.set(botId, created);
      entry = created;
    }
    entry.network = sandbox.network;
    entry.allowlist = allowlist;
    if (sandbox.network === 'allowlist' && entry.egress === null) {
      const e = entry;
      entry.egress = await listen(
        createEgressProxy({
          allowlist: () => e.allowlist,
          armed: () => e.leases > 0,
          ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
          ...(this.opts.onRefusal
            ? { onRefusal: (r: ProxyRefusal) => this.opts.onRefusal?.(botId, 'egress', r) }
            : {}),
          ...(this.opts.now ? { now: this.opts.now } : {}),
        }),
        join(dir, EGRESS_SOCKET),
      );
    } else if (sandbox.network === 'none' && entry.egress !== null) {
      await close(entry.egress);
      entry.egress = null;
    }
  }

  /** Hold a Bot's proxies open for one Run segment; the returned function releases it once. */
  acquire(botId: string): () => void {
    const entry = this.bots.get(botId);
    if (entry === undefined) {
      throw new OrbitError('internal', `No sandbox proxies for Bot ${botId}`);
    }
    entry.leases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.leases -= 1;
      // The last Run ended: cut whatever is still streaming or tunnelling.
      if (entry.leases === 0) {
        entry.api.proxy.dropConnections();
        entry.egress?.proxy.dropConnections();
      }
    };
  }

  /** Runs of the Bot that currently hold its proxies. */
  activeRuns(botId: string): number {
    return this.bots.get(botId)?.leases ?? 0;
  }

  status(): BotProxyStatus[] {
    return [...this.bots.entries()].map(([botId, e]) => ({
      botId,
      network: e.network,
      activeRuns: e.leases,
      api: e.api.proxy.stats(),
      egress: e.egress?.proxy.stats() ?? null,
      invalidAllowlistEntries: [...e.allowlist.invalid],
    }));
  }

  async stop(botId: string): Promise<void> {
    const entry = this.bots.get(botId);
    if (entry === undefined) return;
    this.bots.delete(botId);
    await close(entry.api);
    if (entry.egress) await close(entry.egress);
  }

  async close(): Promise<void> {
    await Promise.all([...this.bots.keys()].map((id) => this.stop(id)));
  }
}
