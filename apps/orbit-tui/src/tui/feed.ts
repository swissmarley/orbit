import { type RunEvent, errorMessage } from '@orbit/core';
import type { OrbitClient } from '@orbit/sdk-client';
import { scrubDeep } from '../render';
import { type Data, EMPTY_DATA } from './model';

/** What the TUI needs from orbitd (an OrbitClient, or a fake in tests). */
export type TuiClient = Pick<
  OrbitClient,
  'bots' | 'runs' | 'approvals' | 'kill' | 'queue' | 'doctor' | 'events' | 'memory'
>;

/** Events that change a memory browser or a delegation tree. */
const MEMORY_EVENTS = new Set<RunEvent['type']>([
  'memory.written',
  'memory.summarized',
  'feedback.recorded',
]);
const TREE_EVENTS = new Set<RunEvent['type']>([
  'delegation.started',
  'delegation.finished',
  'run.started',
  'run.parked',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

/** Events that change lists (runs, approvals, queue), not just the timeline. */
const LIST_EVENTS = new Set<RunEvent['type']>([
  'run.queued',
  'run.started',
  'run.parked',
  'run.resumed',
  'run.resume_scheduled',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.rate_limited',
  'approval.requested',
  'approval.decided',
  'run.killed',
]);

/**
 * Keeps `Data` in sync with orbitd: one initial load, then the SSE feed.
 * Every event of the selected Run is appended to the timeline; lifecycle
 * events trigger a (coalesced) refetch of the lists. Listeners get a fresh
 * snapshot after each change.
 */
export class Feed {
  private data: Data = EMPTY_DATA;
  private readonly listeners = new Set<(d: Data) => void>();
  private readonly abort = new AbortController();
  private selectedRun: string | null = null;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | null = null;
  private memoryWatch: { botId: string; query: string } | null = null;
  private treeWatch: string | null = null;

  constructor(
    private readonly client: TuiClient,
    private readonly opts: { refreshDelayMs?: number } = {},
  ) {}

  snapshot(): Data {
    return this.data;
  }

  subscribe(listener: (d: Data) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<Data>): void {
    this.data = { ...this.data, ...patch };
    for (const l of this.listeners) l(this.data);
  }

  /** Load everything, then follow the live feed until `close()`. */
  async start(): Promise<void> {
    const doctor = await this.client.doctor().catch(() => null);
    this.set({ doctor });
    await this.refresh();
    void this.follow();
  }

  close(): void {
    clearTimeout(this.refreshTimer);
    this.abort.abort();
  }

  async refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const [bots, runs, approvals, queue, kill] = await Promise.all([
          this.client.bots.list(),
          this.client.runs.list({ limit: 200 }),
          this.client.approvals.list(),
          this.client.queue(),
          this.client.kill.status(),
        ]);
        // Names, prompts and cards are model- or user-written: scrubbed once, here.
        this.set({
          bots: scrubDeep(bots),
          runs: scrubDeep(runs),
          approvals: scrubDeep(approvals),
          queue,
          kill,
          loaded: true,
          error: null,
        });
      } catch (err) {
        this.set({ error: errorMessage(err) });
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Load the memory browser's list and keep it fresh; null stops. */
  async watchMemory(watch: { botId: string; query: string } | null): Promise<void> {
    this.memoryWatch = watch;
    if (!watch) {
      this.set({ memories: [] });
      return;
    }
    try {
      const memories = await this.client.memory.list({
        bot: watch.botId,
        ...(watch.query ? { q: watch.query } : {}),
        limit: 200,
      });
      if (this.memoryWatch !== watch) return;
      // Memory text is model- or user-written: scrubbed once, here.
      this.set({ memories: scrubDeep(memories) });
    } catch (err) {
      this.set({ error: errorMessage(err) });
    }
  }

  /** Load a Run's delegation tree and keep it fresh; null stops. */
  async watchTree(runId: string | null): Promise<void> {
    this.treeWatch = runId;
    if (!runId) {
      this.set({ tree: null });
      return;
    }
    try {
      const tree = await this.client.runs.tree(runId);
      if (this.treeWatch !== runId) return;
      this.set({ tree: scrubDeep(tree) });
    } catch (err) {
      this.set({ error: errorMessage(err) });
    }
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), this.opts.refreshDelayMs ?? 100);
  }

  /** Show this Run's events in the timeline (replayed from the log, then live). */
  async select(runId: string | null): Promise<void> {
    if (runId === this.selectedRun) return;
    this.selectedRun = runId;
    if (!runId) {
      this.set({ events: [] });
      return;
    }
    try {
      const events = await this.client.runs.events(runId);
      if (this.selectedRun !== runId) return; // selection moved on meanwhile
      // Live events may have arrived during the fetch: keep each id once, in order.
      const merged = new Map(events.map((e) => [e.id, e]));
      for (const e of this.data.events) if (e.runId === runId) merged.set(e.id, e);
      this.set({ events: [...merged.values()].sort((a, b) => a.id - b.id) });
    } catch (err) {
      this.set({ error: errorMessage(err) });
    }
  }

  private async follow(): Promise<void> {
    try {
      const after = Math.max(0, ...this.data.runs.map((r) => r.lastEventId));
      this.set({ connected: true });
      for await (const e of this.client.events({ after, signal: this.abort.signal })) {
        if (e.runId === this.selectedRun && !this.data.events.some((x) => x.id === e.id)) {
          this.set({ events: [...this.data.events, e] });
        }
        if (LIST_EVENTS.has(e.type)) this.scheduleRefresh();
        if (this.memoryWatch && MEMORY_EVENTS.has(e.type) && e.botId === this.memoryWatch.botId) {
          void this.watchMemory(this.memoryWatch);
        }
        if (
          this.treeWatch &&
          TREE_EVENTS.has(e.type) &&
          this.data.tree?.runs.some((r) => r.runId === e.runId)
        ) {
          void this.watchTree(this.treeWatch);
        }
      }
    } catch (err) {
      if (!this.abort.signal.aborted) this.set({ error: errorMessage(err) });
    } finally {
      if (!this.abort.signal.aborted) this.set({ connected: false });
    }
  }
}
