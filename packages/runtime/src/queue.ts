import { errorMessage } from '@orbit/core';

/** A unit of work for the queue: start a queued Run or resume a parked / rate-limited one. */
export interface QueueJob {
  kind: 'start' | 'resume';
  runId: string;
  botId: string;
  /** Higher first; FIFO within the same priority. */
  priority: number;
}

export interface QueuedJob extends QueueJob {
  /** Enqueue order (FIFO tie-break). */
  order: number;
  enqueuedAt: string;
  /** Why it is not dispatched right now (kill switch, paused Bot, usage limit), or null. */
  heldBy: string | null;
}

export interface QueueSnapshot {
  limit: number;
  active: QueueJob[];
  queued: QueuedJob[];
}

export interface RunQueueDeps {
  /** Global concurrency limit (CLI mode default 2), read on every dispatch. */
  concurrency: () => number;
  /** Reason a job must wait right now, or null to dispatch it. */
  hold?: (job: QueueJob) => string | null;
  /** Run the job to the end of its segment. Never shares a Run between two calls. */
  execute: (job: QueueJob) => Promise<void>;
  /** A job whose execute() rejected (the Run's own outcome is already in its log). */
  onError?: (job: QueueJob, message: string) => void;
  now?: () => Date;
}

/** Resumes continue work already in flight, so they go before new Runs of equal priority. */
export const RESUME_PRIORITY_BOOST = 50;

/**
 * Priority run queue with a global concurrency limit. One entry per Run: a
 * Run that is queued or executing cannot be queued again (dedupe), so two
 * triggers or two approvals can never start it twice. The queue is in memory;
 * the daemon rebuilds it from the event log at startup (queued and
 * resumable Runs), so nothing depends on it surviving a restart.
 */
export class RunQueue {
  private readonly waiting = new Map<string, QueuedJob>();
  private readonly active = new Map<string, QueueJob>();
  private readonly idleWaiters: (() => void)[] = [];
  private order = 0;
  private frozen = false;
  private readonly now: () => Date;

  constructor(private readonly deps: RunQueueDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Add a job; false when the Run is already queued or executing. */
  push(job: QueueJob): boolean {
    if (this.waiting.has(job.runId) || this.active.has(job.runId)) return false;
    this.waiting.set(job.runId, {
      ...job,
      order: this.order++,
      enqueuedAt: this.now().toISOString(),
      heldBy: null,
    });
    this.pump();
    return true;
  }

  /** Drop a job that has not started; false when it is not waiting. */
  remove(runId: string): boolean {
    const removed = this.waiting.delete(runId);
    if (removed) this.settleIdle();
    return removed;
  }

  has(runId: string): boolean {
    return this.waiting.has(runId) || this.active.has(runId);
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Stop dispatching (daemon shutdown); queued jobs stay in the log as queued. */
  freeze(): void {
    this.frozen = true;
  }

  /** Dispatch as many waiting jobs as the limit and the holds allow. */
  pump(): void {
    if (this.frozen) return;
    const limit = this.deps.concurrency();
    for (const job of this.ordered()) {
      if (this.active.size >= limit) {
        job.heldBy = null;
        continue;
      }
      job.heldBy = this.deps.hold?.(job) ?? null;
      if (job.heldBy) continue;
      this.waiting.delete(job.runId);
      this.dispatch(job);
    }
    this.settleIdle();
  }

  snapshot(): QueueSnapshot {
    return {
      limit: this.deps.concurrency(),
      active: [...this.active.values()],
      queued: this.ordered().map((j) => ({ ...j })),
    };
  }

  /** Resolves when nothing is executing and nothing waiting can be dispatched (tests, shutdown). */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    if (this.active.size > 0) return false;
    return this.frozen || [...this.waiting.values()].every((j) => j.heldBy !== null);
  }

  private settleIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private ordered(): QueuedJob[] {
    const effective = (j: QueuedJob) =>
      j.priority + (j.kind === 'resume' ? RESUME_PRIORITY_BOOST : 0);
    return [...this.waiting.values()].sort(
      (a, b) => effective(b) - effective(a) || a.order - b.order,
    );
  }

  private dispatch(job: QueueJob): void {
    const plain: QueueJob = {
      kind: job.kind,
      runId: job.runId,
      botId: job.botId,
      priority: job.priority,
    };
    this.active.set(job.runId, plain);
    // Through a promise even if execute() throws synchronously.
    void Promise.resolve()
      .then(() => this.deps.execute(plain))
      .catch((err: unknown) => this.deps.onError?.(plain, errorMessage(err)))
      .finally(() => {
        this.active.delete(job.runId);
        this.pump();
      });
  }
}
