import type { RunEvent } from '@orbit/core/browser';
import type { OrbitClient } from '@orbit/sdk-client/browser';
import type { QueryClient } from '@tanstack/react-query';
import { authStore, isUnauthorized } from './api';
import { keys } from './queries';
import { createStore } from './store';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline';
export const connectionStore = createStore<Connection>('connecting');

/** Append one live event to a Run's cached log (each seq once, in order). */
export function appendEvent(list: RunEvent[] | undefined, e: RunEvent): RunEvent[] | undefined {
  if (!list) return list; // not loaded: the next fetch has it
  const last = list[list.length - 1];
  if (last && e.seq <= last.seq) return list;
  return [...list, e];
}

/** Which cached queries an event makes stale. */
export function staleKeysFor(e: RunEvent): (readonly unknown[])[] {
  const out: (readonly unknown[])[] = [keys.run(e.runId)];
  if (
    e.type === 'run.queued' ||
    e.type === 'run.started' ||
    e.type === 'run.parked' ||
    e.type === 'run.resumed' ||
    e.type === 'run.completed' ||
    e.type === 'run.failed' ||
    e.type === 'run.cancelled' ||
    e.type === 'run.rate_limited' ||
    e.type === 'run.resume_scheduled' ||
    e.type === 'usage' ||
    e.type === 'delegation.started' ||
    e.type === 'delegation.finished'
  ) {
    out.push(keys.runs, keys.queue, keys.schedules);
  }
  if (
    e.type === 'memory.written' ||
    e.type === 'memory.summarized' ||
    e.type === 'feedback.recorded'
  ) {
    out.push(keys.memory, keys.triage);
  }
  if (e.type === 'run.tainted') out.push(keys.memory);
  if (e.type === 'approval.requested' || e.type === 'approval.decided') out.push(keys.approvals);
  if (e.type === 'run.killed') out.push(keys.kill, keys.bots);
  return out;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * The App's one live feed: every RunEvent over SSE, forever. The client
 * already resumes with Last-Event-ID inside a burst of failures; this loop
 * keeps trying after it gives up (daemon restarted, laptop slept), resuming
 * after the last id it saw, and refetches everything after a gap so nothing
 * shown is stale.
 */
export function startLiveFeed(
  client: OrbitClient,
  qc: QueryClient,
  opts: { signal: AbortSignal; maxDelayMs?: number },
): void {
  let last: number | undefined;
  let delay = 500;
  let pending = new Set<string>();
  let flush: ReturnType<typeof setTimeout> | null = null;
  const invalidate = (key: readonly unknown[]) => {
    pending.add(JSON.stringify(key));
    flush ??= setTimeout(() => {
      const batch = pending;
      pending = new Set();
      flush = null;
      for (const k of batch) void qc.invalidateQueries({ queryKey: JSON.parse(k) as unknown[] });
    }, 120);
  };
  const aborted = () => opts.signal.aborted;
  void (async () => {
    let hadGap = false;
    const markLive = () => {
      if (connectionStore.get() !== 'live') connectionStore.set('live');
      if (hadGap) {
        // Events may have been missed while away: refetch everything shown.
        hadGap = false;
        void qc.invalidateQueries({ queryKey: keys.all });
      }
    };
    while (!opts.signal.aborted) {
      try {
        const stream = client.events({
          ...(last === undefined ? {} : { after: last }),
          signal: opts.signal,
          maxReconnects: 3,
          onOpen: markLive,
        });
        for await (const e of stream) {
          markLive();
          delay = 500;
          last = e.id;
          qc.setQueryData<RunEvent[]>(keys.runEvents(e.runId), (old) => appendEvent(old, e));
          for (const k of staleKeysFor(e)) invalidate(k);
        }
      } catch (err) {
        if (isUnauthorized(err)) {
          authStore.set('signed-out');
          connectionStore.set('offline');
          return;
        }
      }
      if (aborted()) return;
      hadGap = true;
      connectionStore.set('offline');
      await sleep(delay, opts.signal);
      delay = Math.min(delay * 2, opts.maxDelayMs ?? 15_000);
      connectionStore.set('reconnecting');
    }
  })();
}
