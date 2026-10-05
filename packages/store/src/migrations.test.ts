import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, migrationAppliedAt } from './migrations';

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
});
afterEach(() => {
  sqlite.close();
});

/** A database as an M7 orbitd left it: migrations 1–5 only. */
function m7Database(): void {
  sqlite.exec(`CREATE TABLE schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const m of MIGRATIONS.filter((x) => x.id <= 5)) {
    sqlite.exec(m.sql);
    sqlite
      .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
      .run(m.id, m.name, '2026-09-01T00:00:00.000Z');
  }
  sqlite
    .prepare(
      `INSERT INTO audit (id, ts, actor, action, subject, data, prev_hash, hash)
       VALUES ('aud_old', '2026-09-01T00:00:00.000Z', 'owner', 'bot.created', NULL, '{}', ?, ?)`,
    )
    .run('0'.repeat(64), 'f'.repeat(64));
}

describe('migration 6 (audit-mac)', () => {
  it('adds a nullable mac column to an existing audit log and keeps it append-only', () => {
    m7Database();
    expect(migrate(sqlite)).toEqual([6]);
    expect(migrationAppliedAt(sqlite, 6)).not.toBeNull();
    const cols = (sqlite.prepare('PRAGMA table_info(audit)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('mac');
    expect(sqlite.prepare('SELECT mac FROM audit').get()).toEqual({ mac: null });
    expect(() => sqlite.prepare("UPDATE audit SET mac = 'x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare('DELETE FROM audit').run()).toThrow(/append-only/);
    // re-running is a no-op
    expect(migrate(sqlite)).toEqual([]);
  });

  it('applies on a fresh database', () => {
    expect(migrate(sqlite)).toEqual(MIGRATIONS.map((m) => m.id));
    sqlite
      .prepare(
        `INSERT INTO audit (id, ts, actor, action, subject, data, prev_hash, hash, mac)
         VALUES ('aud_1', 't', 'owner', 'x', NULL, '{}', 'p', 'h', 'm')`,
      )
      .run();
    expect(sqlite.prepare('SELECT mac FROM audit').get()).toEqual({ mac: 'm' });
  });
});
