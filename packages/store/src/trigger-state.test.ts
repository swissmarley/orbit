import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OrbitDb, openDatabase } from './db';
import { TriggerStateRepo } from './trigger-state';

describe('TriggerStateRepo', () => {
  let db: OrbitDb;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => db.close());

  it('records and updates the last fire of a trigger', () => {
    const repo = new TriggerStateRepo(db);
    expect(repo.get('k1')).toBeUndefined();
    repo.record({
      key: 'k1',
      botId: 'bot_1',
      lastFiredAt: '2026-10-04T09:00:00.000Z',
      lastRunId: 'run_1',
    });
    repo.record({
      key: 'k1',
      botId: 'bot_1',
      lastFiredAt: '2026-10-04T10:00:00.000Z',
      lastRunId: 'run_2',
    });
    repo.record({
      key: 'k2',
      botId: 'bot_2',
      lastFiredAt: '2026-10-04T10:00:00.000Z',
      lastRunId: null,
    });
    expect(repo.get('k1')).toEqual({
      key: 'k1',
      botId: 'bot_1',
      lastFiredAt: '2026-10-04T10:00:00.000Z',
      lastRunId: 'run_2',
    });
    expect(repo.listForBot('bot_2').map((f) => f.key)).toEqual(['k2']);
  });
});
