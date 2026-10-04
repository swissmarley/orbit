# ADR-007: SQLite + Drizzle, append-only events, hash-chained audit

Status: Accepted (M0, implemented in M1/M2)

## Decision

- `better-sqlite3` (verified: installs, FTS5 available) + Drizzle ORM. Schema
  uses only Postgres-compatible types (text, integer, JSON as text, ISO
  timestamps) so a Postgres adapter is a driver swap.
- `events` is append-only: SQLite `BEFORE UPDATE/DELETE` triggers raise; the
  repository exposes `append` and reads only.
- Projections (bot status, inbox, run summaries) are derived and rebuildable.
- `audit` records carry `prev_hash` and `hash = sha256(prev_hash ‖ record)`;
  `orbit audit verify` detects tampering; `orbit audit export` writes JSONL.
- WAL mode; one writer (orbitd) per database file.
