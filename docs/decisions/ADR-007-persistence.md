# ADR-007: SQLite + Drizzle, append-only events, hash-chained audit

Status: Accepted (M0, implemented in M1/M2)

## Decision

- Persistence lives in its own package, **`@orbit/store`** (additive deviation
  from the brief's package list): policy (audit), memory and runtime all need
  the database, and none of them should depend on another for it.

- `better-sqlite3` (verified: installs, FTS5 available) + Drizzle ORM. Schema
  uses only Postgres-compatible types (text, integer, JSON as text, ISO
  timestamps) so a Postgres adapter is a driver swap.
- `events` is append-only: SQLite `BEFORE UPDATE/DELETE` triggers raise; the
  repository exposes `append` and reads only.
- Projections (bot status, inbox, run summaries) are derived and rebuildable.
- `audit` records carry `prev_hash` and `hash = sha256(prev_hash ‖ record)`;
  `orbit audit verify` detects tampering; `orbit audit export` writes JSONL.
- WAL mode; one writer (orbitd) per database file.

## M8: keyed audit chain and checkpoints

The hash chain detects edits, reorders and deletions in the middle, but
someone who can write the database can recompute every hash after a change.
M8 adds a key that is never in the database:

- **Audit key.** 32 random bytes kept like the vault's data key
  (`@orbit/policy` `loadLocalKey`): the OS keychain (service `orbit`, account
  `audit-key`) when it holds or can durably hold it, else
  `<ORBIT_HOME>/audit.key` (0600, in a 0700 directory), created on first
  use. orbitd uses the same `keySource` for both keys.
- **Per-record MAC.** Migration 6 adds a nullable `audit.mac` column
  (`ALTER TABLE … ADD COLUMN`, so the append-only triggers stay). Every new
  record stores `mac = HMAC-SHA256(key, hash)`. `verify` checks hashes and
  MACs (constant-time comparison); a wrong MAC is tampering ("rewritten
  without the audit key, or the audit key changed").
- **Upgrades.** Records written before the key existed have no MAC and are
  reported as `unkeyed` (a count and `lastUnkeyedSeq`), never as tampering.
  When orbitd starts with a key and the newest record is unkeyed, it appends
  an `audit.keyed` record (itself keyed) that marks the switch. After the
  first keyed record every record must be keyed, and an `audit.keyed` record
  without a MAC is tampering, so stripping MACs from the keyed part is
  detected.
- **Checkpoints.** `orbit audit checkpoint [--out file]` (and Settings →
  Audit → Download checkpoint) appends an `audit.checkpoint` record and
  returns `{kind, v, seq, hash, ts, count, mac}`, where `mac` is an HMAC over
  the canonical JSON of the other fields. The owner keeps it outside
  `ORBIT_HOME`. `orbit audit verify --checkpoint file` (and the App's upload)
  checks that the checkpoint is signed by this key, that the record at its
  `seq` still exists with the same hash, timestamp and a valid MAC, and that
  the whole chain verifies. This catches a truncated tail (which the chain
  alone cannot see) and a rewrite that strips every MAC to pass the log off
  as never keyed.
- **Key loss.** A lost or replaced key is not fatal: orbitd logs an error at
  start when it had to create a key while keyed records exist, and `verify`
  reports the first keyed record as a MAC mismatch until the original key is
  restored. Failing closed (as the vault does) would stop the daemon over a
  key that protects only evidence.

Routes (owner, like every API route): `GET /v1/audit/status` (keyed since,
unkeyed count, head; no hashing), `POST /v1/audit/checkpoint`,
`POST /v1/audit/checkpoint/verify`. `AuditRecord` carries `mac`; `verify`
returns `unkeyed`, `lastUnkeyedSeq` and `keyedSince`.

Limits: someone who holds the key (the owner's account on this machine, or
the keychain) can still rewrite the log; checkpoints kept elsewhere bound
that to the records written after the newest checkpoint.
