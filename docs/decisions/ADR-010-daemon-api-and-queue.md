# ADR-010: orbitd as single writer, contract-driven API, loopback token auth

Status: Accepted (M3)

## Context

Through M2 the CLI ran Bots in-process and several processes could write the
same database (a Run in one terminal, `orbit approve` in another). M3 makes
orbitd the always-on daemon: it must schedule Runs, enforce the CLI-mode
concurrency limit, pause on usage limits and resume later, and every client
(CLI now, TUI in M4, App in M5) must see the same state through one API. The
brief named Hono + OpenAPI generated from zod, with OIDC only in hosted mode;
risk R6 flagged zod v4 compatibility of the Hono OpenAPI tooling.

## Decision

**One process writes.** orbitd owns the database while it runs (lock file
`$ORBIT_HOME/daemon.lock`, one daemon per home). All Runs execute inside it
through one Orchestrator, one `RunQueue` and one approval queue. The CLI is a
thin client of orbitd (`@orbit/sdk-client` only; a repo guard forbids the CLI
from importing store, policy, sandbox, API or orchestration code) and starts
the daemon on demand, detached, with the `orbitd` child-env allowlist (Orbit's
settings and API credentials, never OAuth or session tokens; ADR-005).
Compare-and-set on the event log (`EventStore.append(…, { expectSeq })`) still
guards start, resume and stop, so a second writer could never double-run a
Run even if one existed.

**One contract table.** `@orbit/api/contract` lists every route with its zod
schemas. The same table drives request validation in Hono, the OpenAPI 3.1
document and the typed client, whose responses are validated too (a version
skew fails loudly). OpenAPI uses **zod's native `z.toJSONSchema`** (JSON
Schema 2020-12, which OpenAPI 3.1 embeds) instead of `@hono/zod-openapi` or
`zod-openapi`: no extra dependency, no zod-v4 adapter risk (resolves R6). The
document is checked in (`packages/api/openapi.json`) and a test keeps it
current. The client is "generated" at the type level from the same table
rather than by a code generator: nothing to regenerate, nothing to drift.

**Local auth.** orbitd binds to loopback only and refuses non-loopback
`ORBIT_HOST` and `ORBIT_MODE=hosted` until TLS + OIDC exist (M8; ADR-015 added both): a bearer
token over plain HTTP is not acceptable off the machine. Each start writes a
fresh random token to `daemon.token` (0600) and its address to `daemon.json`
(0600). Every route but `/v1/health` and `/openapi.json` needs the token
(timing-safe compare). Requests naming another Host are refused (DNS
rebinding) and requests carrying an `Origin` header are refused (no browser
access until the M5 app adds an explicit origin allowlist; ADR-011 replaced this refusal with one). The token is
registered with the process redactor.

**Events over SSE.** `/v1/events` replays from `Last-Event-ID` (or `after`)
page by page, then streams live events, each id once and in order, with
heartbeat comments every 15 s. The client reconnects with backoff and resumes
after the last id it received.

**Queue, scheduler, usage limits.**

- `RunQueue`: priority (manual Runs +10, resumes +50 within the queue), FIFO
  within a priority, a global concurrency limit per driver
  (`limits.maxConcurrentRuns`, CLI default 2), one entry per Run. Holds
  (global kill, paused Bot, usage limit) keep a job waiting; engaging the
  global kill switch or pausing a Bot cancels its queued, parked and
  rate-limited Runs outright, so nothing continues after the release.
- `Scheduler` (croner): cron and interval triggers in the Bot spec, ticked
  every second. Missed fires while the daemon was down are not replayed, and a
  trigger whose previous Run is still in flight is skipped, so always-on Bots
  cannot pile up Runs against a subscription limit.
- `RateLimitManager`: a usage limit is account-wide, so the queue holds every
  start until the reset; each rate-limited Run whose Bot allows it gets a
  `run.resume_scheduled` event ("resumes at <time>") and is resumed after the
  reset plus a margin. All of it is rebuilt from the log at startup.
- Restart recovery: Runs left `running` by a dead daemon end as
  `run.failed: interrupted` (retryable); queued Runs are queued again; parked
  Runs whose approvals are all decided auto-resume (a crash between decision
  and resume loses nothing).

**M2 deferrals closed here.** Approval expiry is set by the orchestrator from
`approvals.expireAfterHours` and swept every tick (an expired approval is "not
approved" for the Bot). One-shot grants are scoped to the driver segment after
their decision (`revokeGrants` at segment end). Workspaces, containers and
worktree branches are keyed by Bot id. Bot specs are stored redacted.
`PostToolUseFailure` cannot rewrite a failed tool's error text (the engine has
no `updatedToolOutput` for failures), so when a failure contains a secret
Orbit stops the engine with `continue: false` before the model's next turn and
fails the Run (`secret_exposure_blocked`); the hook script now fails closed
for post hooks as well.

## Consequences

- One daemon per `ORBIT_HOME`; two homes need two ports (`ORBIT_PORT`).
- The daemon reads its own environment; changing credentials means
  `orbit daemon restart`. `orbit doctor` shows the daemon's view and detects
  `CLAUDE_CODE_OAUTH_TOKEN` in the CLI's shell by name only.
- Webhook (HMAC) and file/git triggers move to M7 with the plugin and Slack
  triggers; the trigger router shape (`TriggerRef.kind`) already covers them.
- `continue: false` from `PostToolUseFailure` is covered by the driver
  contract tests and the mock driver; a live check is deferred with the
  other live verifications (PLAN §7).
