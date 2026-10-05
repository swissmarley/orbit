import { eq, like } from 'drizzle-orm';
import type { OrbitDb } from './db';
import { controls } from './schema';

const GLOBAL_KILL = 'global_kill';
const stopKey = (runId: string) => `stop_run:${runId}`;
const takeoverKey = (botId: string) => `takeover:${botId}`;

/**
 * An open take-over of a Bot's workspace (`orbit shell`, ADR-016): the CLI
 * process holding it, and whether the Bot was paused before (the hold is
 * released afterwards only if it was not).
 */
export interface Takeover {
  botId: string;
  pid: number;
  startedAt: string;
  wasPaused: boolean;
  by: string;
}

/**
 * Cross-process control flags (kill switches). Stored in the database so an
 * `orbit stop` / `orbit kill` in another terminal reaches a running orbitd.
 */
export class Controls {
  constructor(
    private readonly db: OrbitDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private set(key: string, value: string): void {
    const ts = this.now().toISOString();
    this.db.orm
      .insert(controls)
      .values({ key, value, updatedAt: ts })
      .onConflictDoUpdate({ target: controls.key, set: { value, updatedAt: ts } })
      .run();
  }

  private get(key: string): string | undefined {
    return this.db.orm.select().from(controls).where(eq(controls.key, key)).get()?.value;
  }

  setGlobalKill(on: boolean, by: string): void {
    if (on) this.set(GLOBAL_KILL, by);
    else this.db.orm.delete(controls).where(eq(controls.key, GLOBAL_KILL)).run();
  }

  /** Who engaged the global kill switch, or null when it is off. */
  globalKill(): string | null {
    return this.get(GLOBAL_KILL) ?? null;
  }

  requestStop(runId: string, by: string): void {
    this.set(stopKey(runId), by);
  }

  stopRequested(runId: string): string | null {
    return this.get(stopKey(runId)) ?? null;
  }

  clearStop(runId: string): void {
    this.db.orm
      .delete(controls)
      .where(eq(controls.key, stopKey(runId)))
      .run();
  }

  setTakeover(t: Takeover): void {
    this.set(takeoverKey(t.botId), JSON.stringify(t));
  }

  takeover(botId: string): Takeover | null {
    const raw = this.get(takeoverKey(botId));
    return raw === undefined ? null : (JSON.parse(raw) as Takeover);
  }

  clearTakeover(botId: string): void {
    this.db.orm
      .delete(controls)
      .where(eq(controls.key, takeoverKey(botId)))
      .run();
  }

  listStopRequests(): string[] {
    return this.db.orm
      .select()
      .from(controls)
      .where(like(controls.key, 'stop_run:%'))
      .all()
      .map((r) => r.key.slice('stop_run:'.length));
  }
}
