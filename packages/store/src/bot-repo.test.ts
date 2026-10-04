import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotRepo } from './bot-repo';
import { type OrbitDb, openDatabase } from './db';

describe('BotRepo', () => {
  let db: OrbitDb;
  let repo: BotRepo;
  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new BotRepo(db);
  });
  afterEach(() => db.close());

  it('creates, finds by id or name, and versions updates', () => {
    const bot = repo.create({ name: 'Inbox Triage', goal: 'Triage my inbox' });
    expect(bot.version).toBe(1);
    expect(bot.spec.instructions).toBe('');
    expect(repo.get('inbox-triage').id).toBe(bot.id);
    expect(repo.get('Inbox Triage').id).toBe(bot.id);
    const v2 = repo.update(bot.id, { ...bot.spec, goal: 'Triage and draft replies' });
    expect(v2.version).toBe(2);
    expect(repo.versions(bot.id).map((v) => v.spec.goal)).toEqual([
      'Triage my inbox',
      'Triage and draft replies',
    ]);
  });

  it('rejects duplicate names and invalid specs', () => {
    repo.create({ name: 'A', goal: 'x' });
    expect(() => repo.create({ name: 'a', goal: 'y' })).toThrow(/already exists/);
    expect(() => repo.create({ name: '', goal: 'y' })).toThrow();
  });

  it('reports missing bots with a not_found error', () => {
    expect(() => repo.get('nope')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});
