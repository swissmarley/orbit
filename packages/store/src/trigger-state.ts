import { eq } from 'drizzle-orm';
import type { OrbitDb } from './db';
import { triggerState } from './schema';

export interface TriggerFire {
  key: string;
  botId: string;
  lastFiredAt: string;
  lastRunId: string | null;
}

/** When each scheduled trigger last fired (survives daemon restarts). */
export class TriggerStateRepo {
  constructor(private readonly db: OrbitDb) {}

  get(key: string): TriggerFire | undefined {
    return this.db.orm.select().from(triggerState).where(eq(triggerState.key, key)).get();
  }

  listForBot(botId: string): TriggerFire[] {
    return this.db.orm.select().from(triggerState).where(eq(triggerState.botId, botId)).all();
  }

  record(fire: TriggerFire): void {
    this.db.orm
      .insert(triggerState)
      .values(fire)
      .onConflictDoUpdate({
        target: triggerState.key,
        set: { lastFiredAt: fire.lastFiredAt, lastRunId: fire.lastRunId },
      })
      .run();
  }
}
