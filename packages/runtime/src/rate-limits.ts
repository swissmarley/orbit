import { type Bot, type RunEvent, type RunEventBody, type RunState, event } from '@orbit/core';

export interface RateLimitDeps {
  store: {
    subscribe(listener: (e: RunEvent) => void): () => void;
    append(runId: string, botId: string, bodies: readonly RunEventBody[]): unknown;
    getRun(runId: string): RunState | undefined;
    listRuns(opts: { status?: readonly RunState['status'][]; limit?: number }): RunState[];
  };
  bots: { find(idOrSlug: string): Bot | undefined };
  /** Queue a resume of this rate-limited Run. */
  resume: (run: RunState) => void;
  /** Pause when the engine does not say when the limit resets. Default 30 min. */
  fallbackMs?: number;
  /** Wait this long after the reset before resuming. Default 30 s. */
  marginMs?: number;
  now?: () => Date;
}

/**
 * Usage-limit handling (R5). A subscription limit is account-wide, so when
 * any Run hits one, the queue holds every new start until the reset; each
 * rate-limited Run whose Bot allows it gets a `run.resume_scheduled` event
 * ("resumes at <time>") and is resumed automatically after the reset.
 * State lives in the event log, so `recover()` rebuilds it after a restart.
 */
export class RateLimitManager {
  private pausedUntil: Date | null = null;
  private readonly scheduled = new Map<string, Date>();
  private readonly now: () => Date;
  private readonly fallbackMs: number;
  private readonly marginMs: number;

  constructor(private readonly deps: RateLimitDeps) {
    this.now = deps.now ?? (() => new Date());
    this.fallbackMs = deps.fallbackMs ?? 30 * 60_000;
    this.marginMs = deps.marginMs ?? 30_000;
  }

  /** Listen for usage limits; returns the unsubscribe function. */
  start(): () => void {
    return this.deps.store.subscribe((e) => {
      // Deferred: appending from inside a store listener would reach other
      // listeners (SSE) before the event that triggered it.
      if (e.type === 'run.rate_limited') queueMicrotask(() => this.onLimited(e.runId));
    });
  }

  /** Rebuild holds and scheduled resumes from the log (daemon start). */
  recover(): void {
    for (const run of this.deps.store.listRuns({ status: ['rate_limited'], limit: 1000 })) {
      this.extendPause(this.resetOf(run));
      if (run.resumeAt) this.scheduled.set(run.runId, new Date(run.resumeAt));
      else this.schedule(run);
    }
  }

  /** Reason the queue must not start Runs now, or null. */
  hold(): string | null {
    if (!this.pausedUntil || this.now() >= this.pausedUntil) return null;
    return `usage limit reached — resumes at ${this.pausedUntil.toISOString()}`;
  }

  /** When the usage-limit hold ends (null = no hold). */
  pausedUntilIso(): string | null {
    return this.hold() ? (this.pausedUntil?.toISOString() ?? null) : null;
  }

  /** Resume every Run whose scheduled time has come (called every second). */
  tick(): void {
    const now = this.now();
    if (this.pausedUntil && now >= this.pausedUntil) this.pausedUntil = null;
    for (const [runId, at] of this.scheduled) {
      if (at > now) continue;
      this.scheduled.delete(runId);
      const run = this.deps.store.getRun(runId);
      // Resumed by hand, stopped, or limited again with a new schedule: nothing to do.
      if (run?.status !== 'rate_limited') continue;
      this.deps.resume(run);
    }
  }

  private onLimited(runId: string): void {
    const run = this.deps.store.getRun(runId);
    if (run?.status !== 'rate_limited') return;
    this.extendPause(this.resetOf(run));
    this.schedule(run);
  }

  private resetOf(run: RunState): Date {
    const iso = run.usageLimit?.resetsAt;
    const parsed = iso ? new Date(iso) : null;
    return parsed && !Number.isNaN(parsed.getTime())
      ? parsed
      : new Date(this.now().getTime() + this.fallbackMs);
  }

  private extendPause(until: Date): void {
    if (until > this.now() && (!this.pausedUntil || until > this.pausedUntil)) {
      this.pausedUntil = until;
    }
  }

  private schedule(run: RunState): void {
    const bot = this.deps.bots.find(run.botId);
    if (!bot?.spec.autoResumeAfterUsageLimit) return;
    const reset = this.resetOf(run);
    const earliest = this.now().getTime() + this.marginMs;
    const at = new Date(Math.max(reset.getTime() + this.marginMs, earliest));
    this.deps.store.append(run.runId, run.botId, [
      event('run.resume_scheduled', { at: at.toISOString(), reason: 'usage_limit' }),
    ]);
    this.scheduled.set(run.runId, at);
  }
}
