import {
  OrbitError,
  type Redactor,
  type RunEvent,
  RunEventBody,
  type RunState,
  type RunStatus,
  defaultRedactor,
  foldRun,
  normalizeRunState,
  replayRun,
} from '@orbit/core';
import { and, asc, desc, eq, gt, gte, inArray } from 'drizzle-orm';
import type { OrbitDb } from './db';
import { events, runs } from './schema';

type EventRow = typeof events.$inferSelect;

function toEvent(row: EventRow): RunEvent {
  return {
    id: row.id,
    runId: row.runId,
    botId: row.botId,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    data: row.data,
  } as RunEvent;
}

export interface AppendOptions {
  /** Injected clock for deterministic tests. */
  now?: () => Date;
}

export type EventListener = (event: RunEvent) => void;

export interface AppendGuard {
  /**
   * Compare-and-set: append only if the Run's last seq is exactly this
   * (0 = the Run must not exist yet). Otherwise throws a `conflict` error and
   * writes nothing — two processes cannot both resume or stop the same Run.
   */
  expectSeq?: number;
}

/**
 * Append-only event log with a synchronously maintained run projection.
 * Every body is validated and redacted before it is written; nothing that
 * reaches disk can contain a registered secret or a recognised credential.
 */
export class EventStore {
  private readonly listeners = new Set<EventListener>();
  private readonly now: () => Date;

  constructor(
    private readonly db: OrbitDb,
    private readonly redactor: Redactor = defaultRedactor,
    options: AppendOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Subscribe to events after they are committed (used by SSE fan-out). */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(
    runId: string,
    botId: string,
    bodies: readonly RunEventBody[],
    guard: AppendGuard = {},
  ): RunEvent[] {
    if (bodies.length === 0) return [];
    const validated = bodies.map((b) => RunEventBody.parse(this.redactor.redact(b)));
    const { orm } = this.db;

    const written = this.db.sqlite.transaction(() => {
      const existing = orm.select().from(runs).where(eq(runs.id, runId)).get();
      let state = existing ? normalizeRunState(existing.state as RunState) : undefined;
      if (state && state.botId !== botId) {
        throw new Error(`run ${runId} belongs to bot ${state.botId}, not ${botId}`);
      }
      if (guard.expectSeq !== undefined && (state?.lastSeq ?? 0) !== guard.expectSeq) {
        throw new OrbitError(
          'conflict',
          `Run ${runId} changed concurrently (at seq ${state?.lastSeq ?? 0}, expected ${guard.expectSeq})`,
        );
      }
      let seq = state?.lastSeq ?? 0;
      const out: RunEvent[] = [];
      let last: { state: RunState; ts: string } | undefined;
      for (const body of validated) {
        seq += 1;
        const ts = this.now().toISOString();
        const row = orm
          .insert(events)
          .values({ runId, botId, seq, ts, type: body.type, data: body.data })
          .returning()
          .get();
        const ev = toEvent(row);
        state = foldRun(state, ev);
        last = { state, ts };
        out.push(ev);
      }
      if (!last) return out;
      const { state: s, ts: updatedAt } = last;
      orm
        .insert(runs)
        .values({
          id: runId,
          botId,
          status: s.status,
          state: s,
          createdAt: s.createdAt,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: runs.id,
          set: { status: s.status, state: s, updatedAt },
        })
        .run();
      return out;
    })();

    for (const e of written) for (const l of this.listeners) l(e);
    return written;
  }

  listRunEvents(runId: string, opts: { afterSeq?: number } = {}): RunEvent[] {
    return this.db.orm
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), gt(events.seq, opts.afterSeq ?? 0)))
      .orderBy(asc(events.seq))
      .all()
      .map(toEvent);
  }

  /** Global feed after a given event id (SSE Last-Event-ID resume), optionally for one Run or Bot. */
  listEventsAfter(
    afterId: number,
    limit = 500,
    filter: { runId?: string; botId?: string } = {},
  ): RunEvent[] {
    return this.db.orm
      .select()
      .from(events)
      .where(
        and(
          gt(events.id, afterId),
          filter.runId ? eq(events.runId, filter.runId) : undefined,
          filter.botId ? eq(events.botId, filter.botId) : undefined,
        ),
      )
      .orderBy(asc(events.id))
      .limit(limit)
      .all()
      .map(toEvent);
  }

  getRun(runId: string): RunState | undefined {
    const row = this.db.orm.select().from(runs).where(eq(runs.id, runId)).get();
    return row ? normalizeRunState(row.state as RunState) : undefined;
  }

  listRuns(
    opts: { botId?: string; status?: readonly RunStatus[]; limit?: number } = {},
  ): RunState[] {
    const conds = [
      opts.botId ? eq(runs.botId, opts.botId) : undefined,
      opts.status ? inArray(runs.status, [...opts.status]) : undefined,
    ].filter((c) => c !== undefined);
    return this.db.orm
      .select()
      .from(runs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(opts.limit ?? 100)
      .all()
      .map((r) => normalizeRunState(r.state as RunState));
  }

  /** Newest event id in the log (0 when empty): where a live feed starts. */
  lastEventId(): number {
    const row = this.db.sqlite.prepare('SELECT MAX(id) AS id FROM events').get() as {
      id: number | null;
    };
    return row.id ?? 0;
  }

  /** Runs of a Bot created at or after `sinceIso` (daily budgets). */
  runsSince(botId: string, sinceIso: string): RunState[] {
    return this.db.orm
      .select()
      .from(runs)
      .where(and(eq(runs.botId, botId), gte(runs.createdAt, sinceIso)))
      .all()
      .map((r) => normalizeRunState(r.state as RunState));
  }

  /** Re-derive a run's projection from the log (replay). */
  replay(runId: string): RunState | undefined {
    return replayRun(this.listRunEvents(runId));
  }

  /** Drop and rebuild every run projection from the immutable log. */
  rebuildProjections(): number {
    const ids = this.db.sqlite.prepare('SELECT DISTINCT run_id AS id FROM events').all() as {
      id: string;
    }[];
    this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare('DELETE FROM runs').run();
      for (const { id } of ids) {
        const s = this.replay(id);
        if (!s) continue;
        this.db.orm
          .insert(runs)
          .values({
            id,
            botId: s.botId,
            status: s.status,
            state: s,
            createdAt: s.createdAt,
            updatedAt: s.endedAt ?? s.createdAt,
          })
          .run();
      }
    })();
    return ids.length;
  }
}
