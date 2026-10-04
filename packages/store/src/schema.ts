import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Postgres-compatible column types only: text, integer, JSON stored as text,
// ISO-8601 timestamps as text (ADR-007).

export const bots = sqliteTable(
  'bots',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    version: integer('version').notNull(),
    spec: text('spec', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('bots_slug_idx').on(t.slug)],
);

export const botVersions = sqliteTable(
  'bot_versions',
  {
    botId: text('bot_id').notNull(),
    version: integer('version').notNull(),
    spec: text('spec', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.botId, t.version] })],
);

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    botId: text('bot_id').notNull(),
    seq: integer('seq').notNull(),
    ts: text('ts').notNull(),
    type: text('type').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
  },
  (t) => [
    uniqueIndex('events_run_seq_idx').on(t.runId, t.seq),
    index('events_bot_idx').on(t.botId),
  ],
);

/** Projection of the event log; rebuildable at any time from `events`. */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id').notNull(),
    status: text('status').notNull(),
    state: text('state', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('runs_bot_idx').on(t.botId, t.createdAt), index('runs_status_idx').on(t.status)],
);
