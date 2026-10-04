import type Database from 'better-sqlite3';

interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Forward-only, hand-written SQL migrations. Kept as plain SQL so the schema
 * stays reviewable and portable to Postgres (ADR-007).
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        version INTEGER NOT NULL,
        spec TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX bots_slug_idx ON bots (slug);

      CREATE TABLE bot_versions (
        bot_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        spec TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, version)
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX events_run_seq_idx ON events (run_id, seq);
      CREATE INDEX events_bot_idx ON events (bot_id);

      -- The event log is the source of truth and is immutable.
      CREATE TRIGGER events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX runs_bot_idx ON runs (bot_id, created_at);
      CREATE INDEX runs_status_idx ON runs (status);
    `,
  },
];

export function migrate(db: Database.Database): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
  );
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        new Date().toISOString(),
      );
    })();
    ran.push(m.id);
  }
  return ran;
}
