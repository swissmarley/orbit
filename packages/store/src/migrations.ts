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
  {
    id: 2,
    name: 'policy-approvals-audit-controls-secrets',
    sql: `
      ALTER TABLE bots ADD COLUMN paused_at TEXT;

      -- Approval cards. status: pending | approved | denied | expired | cancelled
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        tool_use_id TEXT,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        tier TEXT NOT NULL,
        card TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX approvals_status_idx ON approvals (status, created_at);
      CREATE INDEX approvals_run_idx ON approvals (run_id);

      -- One-shot permissions created by an approval, bound to (bot, tool, input hash).
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        updated_input TEXT,
        created_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX grants_lookup_idx ON grants (bot_id, tool_name, input_hash);

      -- Standing, user-authored rules ("always allow" / "never allow"), scoped and expiring.
      CREATE TABLE rules (
        id TEXT PRIMARY KEY,
        bot_id TEXT,
        tool_pattern TEXT NOT NULL,
        input_pattern TEXT,
        effect TEXT NOT NULL,
        reason TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );

      -- Tamper-evident audit log: each record hashes its predecessor.
      CREATE TABLE audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        subject TEXT,
        data TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
        BEGIN SELECT RAISE(ABORT, 'audit records are append-only'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
        BEGIN SELECT RAISE(ABORT, 'audit records are append-only'); END;

      -- Kill switches and other cross-process controls (global_kill, stop_run:<id>).
      CREATE TABLE controls (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Encrypted secrets vault (AES-256-GCM); values never stored in plaintext.
      CREATE TABLE secrets (
        name TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: 'daemon-queue-scheduler',
    sql: `
      -- Grants are scoped to the driver segment after their decision (M2 review L4).
      ALTER TABLE grants ADD COLUMN revoked_at TEXT;
      -- Last fire of each scheduled trigger, so restarts neither double-fire nor reset intervals.
      CREATE TABLE trigger_state (
        key TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        last_fired_at TEXT NOT NULL,
        last_run_id TEXT
      );
      CREATE INDEX trigger_state_bot_idx ON trigger_state (bot_id);
      CREATE INDEX approvals_expiry_idx ON approvals (status, expires_at);
    `,
  },
  {
    id: 4,
    name: 'memory-feedback-taint-triage',
    sql: `
      -- Bot memory (ADR-012). seq is the FTS rowid; id is the public id.
      CREATE TABLE memories (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        taint TEXT NOT NULL,
        run_id TEXT,
        approval_id TEXT,
        signal TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        edited_at TEXT
      );
      CREATE INDEX memories_bot_idx ON memories (bot_id, created_at);
      CREATE INDEX memories_run_idx ON memories (run_id);

      -- Full-text index over title and body (SQLite FTS5; a Postgres adapter uses tsvector).
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        title, body, content='memories', content_rowid='seq', tokenize='porter unicode61'
      );
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts (rowid, title, body) VALUES (new.seq, new.title, new.body);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, title, body)
          VALUES ('delete', old.seq, old.title, old.body);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, title, body)
          VALUES ('delete', old.seq, old.title, old.body);
        INSERT INTO memories_fts (rowid, title, body) VALUES (new.seq, new.title, new.body);
      END;

      -- Workspace files written by tainted Runs (M2 review M1): reading one taints a later Run.
      -- path is relative to the Bot workspace; '*' marks the whole workspace (a tainted shell).
      CREATE TABLE workspace_taint (
        bot_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sources TEXT NOT NULL,
        run_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, path)
      );

      -- Every call on the triage path (summaries, Create Bot proposals): metered and capped.
      CREATE TABLE triage_calls (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        bot_id TEXT,
        run_id TEXT,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_micro_usd INTEGER,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX triage_calls_created_idx ON triage_calls (created_at);
    `,
  },
];

/** When migration `id` was applied to this database, or null. */
export function migrationAppliedAt(db: Database.Database, id: number): string | null {
  const row = db.prepare('SELECT applied_at FROM schema_migrations WHERE id = ?').get(id) as
    { applied_at: string } | undefined;
  return row?.applied_at ?? null;
}

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
