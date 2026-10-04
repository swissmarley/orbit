import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from './migrations';
import * as schema from './schema';

export type OrbitDrizzle = BetterSQLite3Database<typeof schema>;

export interface OrbitDb {
  sqlite: Database.Database;
  orm: OrbitDrizzle;
  close(): void;
}

/** Open (and migrate) the Orbit database. Use ':memory:' for tests. */
export function openDatabase(path: string): OrbitDb {
  // 0700: the database holds approval payloads and the audit log.
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  migrate(sqlite);
  const orm = drizzle(sqlite, { schema });
  return { sqlite, orm, close: () => sqlite.close() };
}
