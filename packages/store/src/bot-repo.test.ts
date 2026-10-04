import { Redactor } from '@orbit/core';
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

  it('stores specs redacted when given a redactor', () => {
    const redacting = new BotRepo(db, () => new Date(), new Redactor(['hunter2-secret-value']));
    const bot = redacting.create({
      name: 'Leaky',
      goal: 'Use token hunter2-secret-value to call the API',
      instructions: 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(bot.spec.goal).not.toContain('hunter2-secret-value');
    const raw = JSON.stringify(
      db.sqlite.prepare('SELECT spec FROM bots UNION ALL SELECT spec FROM bot_versions').all(),
    );
    expect(raw).not.toContain('hunter2-secret-value');
    expect(raw).not.toContain('sk-ant-api03-AAAA');
    expect(raw).toContain('[REDACTED:');
  });

  it('accepts cron and interval triggers with defaults', () => {
    const bot = repo.create({
      name: 'Sched',
      goal: 'g',
      triggers: [
        { kind: 'cron', cron: '0 9 * * 1-5' },
        { kind: 'interval', everyMinutes: 30, prompt: 'check in' },
      ],
    });
    expect(bot.spec.triggers).toEqual([
      { kind: 'cron', cron: '0 9 * * 1-5', enabled: true },
      { kind: 'interval', everyMinutes: 30, prompt: 'check in', enabled: true },
    ]);
    expect(bot.spec.priority).toBe(0);
    expect(() =>
      repo.create({ name: 'Bad', goal: 'g', triggers: [{ kind: 'interval', everyMinutes: 0 }] }),
    ).toThrow();
  });
});
