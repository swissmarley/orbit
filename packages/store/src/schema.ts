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
    pausedAt: text('paused_at'),
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

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  botId: text('bot_id').notNull(),
  toolUseId: text('tool_use_id'),
  toolName: text('tool_name').notNull(),
  input: text('input', { mode: 'json' }).notNull(),
  inputHash: text('input_hash').notNull(),
  tier: text('tier').notNull(),
  card: text('card', { mode: 'json' }).notNull(),
  status: text('status').notNull(),
  decision: text('decision', { mode: 'json' }),
  createdAt: text('created_at').notNull(),
  decidedAt: text('decided_at'),
  expiresAt: text('expires_at'),
});

export const grants = sqliteTable('grants', {
  id: text('id').primaryKey(),
  approvalId: text('approval_id').notNull(),
  botId: text('bot_id').notNull(),
  runId: text('run_id').notNull(),
  toolName: text('tool_name').notNull(),
  inputHash: text('input_hash').notNull(),
  updatedInput: text('updated_input', { mode: 'json' }),
  createdAt: text('created_at').notNull(),
  usedAt: text('used_at'),
  revokedAt: text('revoked_at'),
});

export const triggerState = sqliteTable('trigger_state', {
  key: text('key').primaryKey(),
  botId: text('bot_id').notNull(),
  lastFiredAt: text('last_fired_at').notNull(),
  lastRunId: text('last_run_id'),
});

export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  botId: text('bot_id'),
  toolPattern: text('tool_pattern').notNull(),
  inputPattern: text('input_pattern'),
  effect: text('effect').notNull(),
  reason: text('reason'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
});

export const audit = sqliteTable('audit', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull(),
  ts: text('ts').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  subject: text('subject'),
  data: text('data').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
  /** HMAC-SHA256(audit key, hash); null for records written before the key existed. */
  mac: text('mac'),
});

export const controls = sqliteTable('controls', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
