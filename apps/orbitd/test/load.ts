import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { directoryWorkspaces } from '@orbit/api/testing';
import { type RunState, errorMessage } from '@orbit/core';
import { type FetchLike, OrbitClient, daemonFiles } from '@orbit/sdk-client';
import { startDaemon } from '../src/daemon';

/**
 * The M8 load test (PLAN §3 M8): a real orbitd HTTP server in this process
 * (loopback, port 0, mock driver), N concurrent Runs across several Bots and
 * M SSE subscribers through `@orbit/sdk-client`. Every subscriber must see
 * every event exactly once, in id order, with no gaps — including the ones
 * whose connection is dropped mid-stream and resumed with Last-Event-ID —
 * every Run must reach a terminal state and the queue must drain.
 */

export interface LoadOptions {
  runs: number;
  clients: number;
  /** orbitd's concurrency limit for the mock driver (ORBIT_MAX_CONCURRENT_RUNS). */
  concurrency: number;
  bots: number;
  /** MockDriver pacing between replayed engine messages. */
  delayMs: number;
  /** Subscribers whose connection is cut twice mid-stream (they must resume losslessly). */
  drops: number;
  /** Give up (and report a violation) after this long. */
  timeoutMs: number;
}

export const DEFAULT_LOAD: LoadOptions = {
  runs: 200,
  clients: 50,
  concurrency: 32,
  bots: 5,
  delayMs: 2,
  drops: 2,
  timeoutMs: 120_000,
};

export interface LoadReport {
  options: LoadOptions;
  runs: { started: number; completed: number; failed: number; cancelled: number };
  events: number;
  /** Events × subscribers. */
  deliveries: number;
  durationMs: number;
  runsPerSecond: number;
  eventsPerSecond: number;
  deliveriesPerSecond: number;
  /** Event appended → received, over live subscribers; `resumedMax` over the ones that were cut. */
  latencyMs: { p50: number; p95: number; max: number; resumedMax: number };
  /** Connections the load test cut mid-stream, and how often subscribers reconnected. */
  cuts: number;
  reconnects: number;
  peakRssMb: number;
  violations: string[];
}

/** Built-in MockDriver scenarios that complete on their own (no approval parks). */
const FIXTURES = ['pong', 'many-reads', 'read-then-write-denied'];
const TERMINAL = new Set<RunState['status']>(['completed', 'failed', 'cancelled']);
/** Concurrent `POST /v1/bots/{bot}/runs` requests while starting the Runs. */
const START_WORKERS = 8;

/**
 * What is wrong with one subscriber's stream compared with the log: missing
 * ids (gaps), ids seen twice, ids out of order. Empty when it is exact.
 */
export function verifyStream(expected: readonly number[], received: readonly number[]): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  let last = -Infinity;
  for (const id of received) {
    if (seen.has(id)) problems.push(`event ${id} delivered twice`);
    if (id <= last) problems.push(`event ${id} after ${last} (out of order)`);
    seen.add(id);
    last = Math.max(last, id);
  }
  const missing = expected.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    problems.push(
      `${missing.length} event(s) never delivered (first: ${missing.slice(0, 5).join(', ')})`,
    );
  }
  const known = new Set(expected);
  const extra = [...seen].filter((id) => !known.has(id));
  if (extra.length > 0)
    problems.push(`${extra.length} unexpected event(s): ${extra.slice(0, 5).join(', ')}`);
  return problems;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

async function until(probe: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return probe();
}

/**
 * fetch that drops the event stream's connection after a few chunks, up to
 * `times` times, like a network failure (the request is aborted, so its
 * socket is gone); the client must resume after the last event it got.
 */
function droppingFetch(times: number): { fetch: FetchLike; cuts: () => number } {
  let cuts = 0;
  const fetchFn: FetchLike = async (url, init) => {
    if (cuts >= times || !url.includes('/v1/events')) return fetch(url, init);
    const connection = new AbortController();
    const signal = init?.signal
      ? AbortSignal.any([init.signal, connection.signal])
      : connection.signal;
    const res = await fetch(url, { ...init, signal });
    if (!res.body) return res;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (err) {
          controller.error(err);
          return;
        }
        if (++chunks >= 10 && cuts < times) {
          cuts += 1;
          const dropped = new Error('connection dropped by the load test');
          connection.abort(dropped);
          controller.error(dropped);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
  return { fetch: fetchFn, cuts: () => cuts };
}

interface Subscriber {
  received: { id: number; latency: number }[];
  opens: number;
  /** Connection cuts the load test made (dropped subscribers only). */
  cuts: () => number;
  done: Promise<void>;
  error: unknown;
}

export async function runLoad(options: Partial<LoadOptions> = {}): Promise<LoadReport> {
  const o: LoadOptions = { ...DEFAULT_LOAD, ...options };
  const violations: string[] = [];
  const home = mkdtempSync(join(tmpdir(), 'orbit-load-'));
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 50);
  sampler.unref();
  const abort = new AbortController();
  const daemon = await startDaemon({
    // An explicit allowlist: nothing else of this process's environment.
    env: {
      ORBIT_HOME: home,
      ORBIT_DRIVER: 'mock',
      ORBIT_PORT: '0',
      ORBIT_MAX_CONCURRENT_RUNS: String(o.concurrency),
      PATH: process.env.PATH ?? '',
    },
    port: 0,
    log: (level, message) => {
      if (level === 'error') violations.push(`orbitd: ${message}`);
    },
    service: {
      vaultKeySource: 'file',
      pluginsDir: null,
      memoryDir: null,
      mock: { delayMs: o.delayMs },
      workspaces: directoryWorkspaces(home),
    },
  });
  try {
    const token = readFileSync(daemonFiles(home).token, 'utf8').trim();
    const client = new OrbitClient({ baseUrl: daemon.url, token });
    const bots: string[] = [];
    for (let i = 0; i < o.bots; i++) {
      const bot = await client.bots.create({
        name: `Load ${i + 1}`,
        goal: 'Load test',
        mock: { fixture: FIXTURES[i % FIXTURES.length] ?? 'pong' },
        budgets: { maxRunsPerDay: 1_000_000 },
        memory: { summarize: 'off', inject: false, tools: false },
      });
      bots.push(bot.id);
    }

    // Subscribers connect before any Run starts and follow everything after this id.
    const startId = daemon.service.store.lastEventId();
    const subscribers: Subscriber[] = Array.from({ length: o.clients }, (_, i) => {
      const dropping = i < o.drops ? droppingFetch(2) : null;
      const sub = new OrbitClient({
        baseUrl: daemon.url,
        token,
        ...(dropping ? { fetch: dropping.fetch } : {}),
      });
      const s: Subscriber = {
        received: [],
        opens: 0,
        cuts: dropping?.cuts ?? (() => 0),
        done: Promise.resolve(),
        error: null,
      };
      s.done = (async () => {
        try {
          for await (const e of sub.events({
            after: startId,
            signal: abort.signal,
            reconnectDelayMs: 20,
            onOpen: () => {
              s.opens += 1;
            },
          })) {
            s.received.push({ id: e.id, latency: Date.now() - Date.parse(e.ts) });
          }
        } catch (err) {
          if (!abort.signal.aborted) s.error = err;
        }
      })();
      return s;
    });
    if (!(await until(() => subscribers.every((s) => s.opens > 0), 10_000))) {
      violations.push('not every subscriber connected');
    }

    const t0 = performance.now();
    // A few HTTP workers start all Runs at once, as real clients would (a
    // separate connection per request would only measure the accept backlog);
    // the Runs themselves pile up in orbitd's queue against its concurrency.
    const runIds: string[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: START_WORKERS }, async () => {
        while (next < o.runs) {
          const i = next++;
          runIds[i] = (await client.runs.start(bots[i % bots.length] ?? '')).runId;
        }
      }),
    );
    const drained = await until(async () => {
      const q = await client.queue();
      return (
        q.active.length === 0 &&
        q.queued.length === 0 &&
        runIds.every((id) => TERMINAL.has(daemon.service.store.getRun(id)?.status ?? 'queued'))
      );
    }, o.timeoutMs);
    const t1 = performance.now();
    if (!drained) violations.push(`the queue did not drain within ${o.timeoutMs} ms`);

    const states = runIds.map((id) => daemon.service.store.getRun(id));
    const count = (s: RunState['status']) => states.filter((r) => r?.status === s).length;
    for (const r of states) {
      if (!r || !TERMINAL.has(r.status)) violations.push(`run ${r?.runId ?? '?'} is ${r?.status}`);
      else if (r.status !== 'completed') violations.push(`run ${r.runId} ended ${r.status}`);
    }

    // Every event after startId, as the log has it.
    const expected: number[] = [];
    for (let after = startId; ;) {
      const page = daemon.service.store.listEventsAfter(after, 5000);
      if (page.length === 0) break;
      expected.push(...page.map((e) => e.id));
      after = page.at(-1)?.id ?? after;
    }
    const lastId = expected.at(-1) ?? startId;
    const delivered = await until(
      () => subscribers.every((s) => (s.received.at(-1)?.id ?? startId) >= lastId),
      Math.max(10_000, o.timeoutMs / 4),
    );
    const t2 = performance.now();
    if (!delivered) violations.push('not every subscriber caught up with the log');
    abort.abort();
    await Promise.all(subscribers.map((s) => s.done));

    subscribers.forEach((s, i) => {
      if (s.error) violations.push(`subscriber ${i}: ${errorMessage(s.error)}`);
      for (const p of verifyStream(
        expected,
        s.received.map((r) => r.id),
      )) {
        violations.push(`subscriber ${i}: ${p}`);
      }
      if (i < o.drops && s.cuts() === 0) violations.push(`subscriber ${i} was never dropped`);
      if (s.opens - 1 < s.cuts()) {
        violations.push(
          `subscriber ${i} was dropped ${s.cuts()} time(s) but reconnected ${s.opens - 1}`,
        );
      }
    });

    // Live delivery latency: subscribers that were never cut (a resumed one
    // gets the events it missed late, by design; its worst case is reported apart).
    const sorted = (list: readonly Subscriber[]) =>
      list.flatMap((s) => s.received.map((r) => r.latency)).sort((a, b) => a - b);
    const latencies = sorted(subscribers.filter((s) => s.cuts() === 0));
    const resumed = sorted(subscribers.filter((s) => s.cuts() > 0));
    const deliveries = subscribers.reduce((n, s) => n + s.received.length, 0);
    const seconds = (ms: number) => Math.max(ms, 1) / 1000;
    return {
      options: o,
      runs: {
        started: runIds.length,
        completed: count('completed'),
        failed: count('failed'),
        cancelled: count('cancelled'),
      },
      events: expected.length,
      deliveries,
      durationMs: Math.round(t1 - t0),
      runsPerSecond: Math.round(runIds.length / seconds(t1 - t0)),
      eventsPerSecond: Math.round(expected.length / seconds(t1 - t0)),
      deliveriesPerSecond: Math.round(deliveries / seconds(t2 - t0)),
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        max: latencies.at(-1) ?? 0,
        resumedMax: resumed.at(-1) ?? 0,
      },
      cuts: subscribers.reduce((n, s) => n + s.cuts(), 0),
      reconnects: subscribers.reduce((n, s) => n + Math.max(0, s.opens - 1), 0),
      peakRssMb: Math.round(peakRss / 1024 / 1024),
      violations,
    };
  } finally {
    abort.abort();
    clearInterval(sampler);
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
}
