# Orbit — Engineering Plan

> Working name: **Orbit**. Self-hostable platform of always-on, goal-driven AI
> agents ("Bots") powered by Claude Code and the Claude Agent SDK.
> Status: **M0–M8 complete (Orbit 0.1)**, then the chat-first App (ADR-020:
> conversations, Bot avatars, the Bot's computer). Next: the items in §7.
> Owner of this document: lead engineer (Claude). Update it at every milestone.

## 0. Starting point

- Repository on day 0: `LICENSE` (MIT, © 2026 Nakya) and a one-line `README.md`.
  No code, no constraints from existing code.
- Toolchain verified in the dev container: Node 22.22, pnpm 10.28, Claude Code
  CLI 2.1.289 (logged in, `claude auth status --json` works), Docker CLI 29 (no
  daemon in this container), Rust/cargo (Tauri possible), Playwright Chromium.
- Upstream APIs verified against the actual artifacts (not memory):
  - `@anthropic-ai/claude-agent-sdk@0.3.289` (bundles Claude Code 2.1.289):
    `query({prompt, options})` with `canUseTool`, `hooks`
    (`PreToolUse`/`PostToolUse`/`SubagentStart`/…), `agents`, `mcpServers`,
    `resume`, `maxTurns`, `maxBudgetUsd`, `env`, `systemPrompt.append`,
    `permissionMode`, `sandbox`, `spawnClaudeCodeProcess`, `extraArgs`.
    Peer deps: `zod@^4`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`.
  - Messages: `SDKMessage` union (`assistant`, `user`, `result`, `system`,
    `stream_event`, `rate_limit_event`, `task_*`, hook events, …). The CLI's
    `--output-format stream-json --verbose` emits the **same shapes**, which is
    what makes one shared normalizer possible (ADR-002).
  - Usage limits: `rate_limit_event.rate_limit_info = {status:
'allowed'|'allowed_warning'|'rejected', resetsAt, rateLimitType:
'five_hour'|'seven_day'|…, utilization}` and `assistant.error =
'rate_limit'|'authentication_failed'|…`.
  - CLI flags: `-p`, `--output-format stream-json`, `--verbose`, `--resume`,
    `--session-id`, `--allowedTools`, `--disallowedTools`, `--permission-mode`,
    `--permission-prompt-tool`, `--permission-prompts host|none`,
    `--append-system-prompt`, `--agents`, `--max-turns`, `--mcp-config`,
    `--strict-mcp-config`, `--settings`, `--setting-sources`, `--model`
    (accepts aliases `opus`/`sonnet`/`haiku`), `--include-hook-events`,
    `--bare` (auth strictly `ANTHROPIC_API_KEY`/`apiKeyHelper`; OAuth and
    keychain never read), `--restricted`.
  - `claude auth status [--json]` → `{loggedIn, authMethod, apiProvider}`.

## 1. Product in one paragraph

A **Bot** is a persistent agent (goal, model, tools/MCP, skills, memory,
triggers, policy, budgets, isolated workspace). **Triggers** (cron, webhook,
Slack, file/Git events, manual) start **Runs**. A Run executes through an
**AgentDriver** (SDK, CLI or Mock), every driver message becomes a typed
**RunEvent** appended to an immutable log, and clients (App, TUI, CLI) render
derived state from that log over REST + SSE. Bots only surface to humans for
**approvals**, **blockers** and **results**.

## 2. Architecture

```
                 ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
                 │  orbit-app    │  │ orbit (TUI)   │  │ orbit (CLI)   │
                 │ React/Vite/   │  │ Ink           │  │ commander     │
                 │ Tauri         │  │               │  │ --json        │
                 └──────┬────────┘  └──────┬────────┘  └──────┬────────┘
                        └───────── @orbit/sdk-client ─────────┘
                                   (typed, generated from OpenAPI)
                                          │ REST + SSE (Last-Event-ID)
┌─────────────────────────────── orbitd ──┴───────────────────────────────────┐
│ @orbit/api  Hono, zod→OpenAPI, local token auth (OIDC only in hosted mode)  │
│   ├─ /v1/bots /runs /approvals /events(SSE) /memory /audit /doctor          │
│   └─ /mcp/orbit  ← loopback MCP endpoint used by BOTH drivers (per-run token)│
│ @orbit/runtime                                                              │
│   Orchestrator ─ RunQueue(priority, concurrency) ─ RateLimitManager         │
│   Scheduler(cron) ─ TriggerRouter(webhook, slack, fs/git, manual)           │
│   AuthResolver → AgentDriver: SdkDriver | CliDriver | MockDriver            │
│        └─ shared normalizer: SDKMessage/stream-json → RunEvent              │
│ @orbit/policy   tiers, rules, approval queue, taint, budgets, audit log     │
│ @orbit/memory   markdown files + SQLite FTS index, feedback ingestion       │
│ @orbit/sandbox  DockerSandbox | WorktreeSandbox (+ Claude Code sandbox cfg) │
│ @orbit/core     domain types, zod schemas, RunEvent model, ids, redaction   │
│ SQLite (Drizzle, Postgres-compatible schema): events (append-only) + views  │
└─────────────────────────────────────────────────────────────────────────────┘
        │ SdkDriver: query() ─ API key / Bedrock / Vertex, `--bare` auth
        │ CliDriver: spawn `claude -p … --output-format stream-json --verbose`
        ▼            (user's own `claude login`; API-key env vars stripped)
   Claude Code engine (one per Run, cwd = Bot workspace)
```

### 2.1 Monorepo layout

```
apps/orbitd          composition root: config → wiring → HTTP server   (ADR-001)
apps/orbit-app       React 19 + Vite + Tailwind v4 + shadcn/ui + TanStack
                     Query/Router + Motion + lucide; Storybook; Tauri 2 shell
apps/orbit-tui       Ink TUI + commander CLI (`orbit` bin)
packages/core        domain types, zod schemas, RunEvent, config schema, redaction
packages/runtime     orchestrator, scheduler, triggers, drivers, AuthResolver,
                     rate-limit manager, run queue, fixtures for MockDriver
packages/sandbox     Docker + git-worktree workspaces, resource/network limits
packages/policy      permission engine, approval queue, budgets, audit log
packages/memory      memory store, summarizer, feedback ingestion
packages/api         Hono REST + SSE + MCP endpoint, OpenAPI generation
packages/sdk-client  generated client + SSE helper (reconnect, Last-Event-ID)
plugins/*            MCP plugin manifests (github, slack, google, fs, browser)
docs/                PLAN.md, decisions/ADR-*.md, security.md, architecture.md
```

Internal packages are consumed **as TypeScript source** (`exports` → `src/`);
Vite, Vitest and `tsx` compile on the fly, and esbuild (ADR-017) bundles only the
publishable artifacts (orbitd, `orbit` bin) in M8. No per-package build step
in the inner loop.

### 2.2 Authentication and drivers (the critical path)

`AuthResolver.resolve(env, probes) → { driver, authMethod, warnings[], onboarding? }`
runs at startup and on `orbit doctor`. Pure function over injected probes so
every branch is unit-tested without real credentials.

| Step | Condition                                                                                                                                                      | Result                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| d    | `ORBIT_DRIVER=sdk\|cli\|mock`                                                                                                                                  | forced driver (still subject to its own preconditions and the compliance guard)                           |
| a    | `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_USE_BEDROCK=1`, or `CLAUDE_CODE_USE_VERTEX=1`                                                                | **SdkDriver**, authMethod = `api_key` / `api_key_helper` / `bedrock` / `vertex`                           |
| b    | `claude` on PATH and `claude auth status --json` → `loggedIn: true` with a subscription method (probe runs with the **same scrubbed env** the driver will use) | **CliDriver**, authMethod = `subscription`                                                                |
| c    | neither                                                                                                                                                        | **onboarding** state (App/TUI first-run screen, `orbit login-help`); MockDriver demo mode still available |

Warnings: API key present **and** subscription login present → "pay-as-you-go
billing will be used; unset `ANTHROPIC_API_KEY` to use your subscription"
(shown in App header, TUI status bar, doctor).

**SdkDriver**

- `query()` with an explicit, minimal `env` (allowlist + the API key / cloud
  vars). `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` are removed.
  The engine is started in `--bare` auth mode (via `extraArgs`) so it can
  **never** fall back to the subscription OAuth on disk or in the keychain
  (to be verified by a live test in M1; documented fallback if `--bare`
  conflicts with SDK hooks: `settingSources: []` + env scrub).
- Only driver allowed when `ORBIT_MODE=hosted`, bind address is non-loopback,
  or more than one human principal is configured.
- In Docker sandbox mode the engine runs inside the container through
  `spawnClaudeCodeProcess` (`docker exec -i …`); the key is passed only to
  that process.

**CliDriver**

- Spawns `claude -p --output-format stream-json --verbose --include-hook-events
--setting-sources '' --strict-mcp-config --settings <Orbit PreToolUse hook>
--permission-mode default --permission-prompts none [--model <alias|id>]
[--max-turns N] [--resume <id> | --session-id <uuid>] [--append-system-prompt
<bot context>] [--tools <list>]` with the prompt on **stdin** (ADR-008).
- Every tool call goes through Orbit's PreToolUse command hook
  (`bin/orbit-hook.mjs` → loopback `HookBridge`, per-run bearer token); the hook
  fails closed and `--permission-prompts none` denies anything that would
  otherwise prompt. Verified live against Claude Code 2.1.289.
- Child env built from an **allowlist** (PATH, HOME, USER, LANG, TERM, SHELL,
  TMPDIR, XDG_*, proxy vars, `CLAUDE_CONFIG_DIR`); `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` are explicitly deleted even if allowlisted later.
  Orbit never reads `~/.claude/.credentials.json`, the keychain or
  `CLAUDE_CODE_OAUTH_TOKEN` (ADR-005; enforced by lint rule + tests).
- stdout lines → JSON → `SDKMessage` → shared normalizer → `RunEvent`.
- **Compliance guard** (`assertCliDriverAllowed`): refuse when the API is
  bound to a non-loopback address, when >1 human principal is configured, or
  when `ORBIT_MODE=hosted`. Error text explains _why_ (Anthropic does not allow
  third parties to offer claude.ai login/rate limits) and _how_ to supply an
  API key instead.
- Global concurrency default **2** concurrent Runs in CLI mode.

**MockDriver** replays recorded `SDKMessage` JSONL fixtures (recorded once from
real runs, scrubbed) through the same normalizer, honoring the same permission
callbacks so approvals work in demo mode and CI.

**Driver contract** (`packages/runtime/src/drivers/contract.ts`): one Vitest
suite run against all three drivers — event ordering, session id capture,
resume, tool permission round-trip (allow / deny / park), abort/kill,
usage-limit pause, error mapping, cost/usage accounting, env scrubbing. SdkDriver
is tested with an injected `queryFn`; CliDriver with a fake `claude` executable
(a Node script that replays a fixture and asserts its argv/env).

### 2.3 Model selection

`ORBIT_DEFAULT_MODEL` (default **`opus`** alias → Claude Code resolves it to
the newest Opus the account offers), `ORBIT_TRIAGE_MODEL` (default **`haiku`**
alias) for routine/triage subagents and summarization, per-Bot override. No
model ID is hardcoded in source (lint-checked). `orbit doctor` shows the
resolved model per driver (ADR-006).

### 2.4 Event model

- `events(id INTEGER PK AUTOINCREMENT, run_id, bot_id, seq, ts, type, payload
JSON, redacted BOOL)` — append-only (no UPDATE/DELETE in the repository
  layer; enforced by a trigger in SQLite and by tests). Global `id` is the SSE
  `Last-Event-ID`; `(run_id, seq)` orders a run.
- `RunEvent` (discriminated union, zod): `run.queued|started|paused|resumed|
completed|failed|cancelled`, `message.assistant`, `message.user`,
  `message.delta`, `tool.call`, `tool.result`, `subagent.started|stopped`
  (from `parent_tool_use_id` / task events), `hook`, `approval.requested|
decided|expired`, `policy.decision`, `usage` (tokens, cost, turns),
  `usage_limit.hit|cleared` (with `resetsAt`), `budget.exceeded`,
  `memory.written`, `feedback.recorded`, `error`.
- Read models (bots status, inbox, run summaries) are **projections** rebuilt
  from the log; replay = re-fold events. A Run resumes from its last
  `session_id` + `seq`.

### 2.5 Approvals: one queue, both drivers, park-and-resume (ADR-003)

```
tool call ──► PreToolUse hook (SDK callback | CLI command hook → orbitd)
               │  PolicyEngine.evaluate(call, ctx{bot, tier, taint, budgets, rules})
               ├─ allow  (READ; WRITE-LOCAL inside sandbox; matching standing rule)
               ├─ deny   (default-deny, FINANCIAL/IRREVERSIBLE, budget exhausted)
               └─ ask ─► ApprovalQueue (decided inside the same hook call, ADR-008)
                          └─► ApprovalQueue.request(card) ─► wait ≤ N s
                                ├─ decided in time → allow/deny (+updatedInput)
                                └─ not decided → deny+interrupt, Run → waiting_approval,
                                   concurrency slot released; on decision the Run
                                   resumes (`resume: session_id`) with a one-shot grant
                                   bound to (tool, input hash)
```

Approval card: what, why, exact payload/diff, risk tier, Bot, Run, untrusted
influences; actions Approve / Edit-then-approve / Deny-with-reason / Always
allow (scoped rule + expiry). All decisions → audit log.

### 2.6 Safety model mapping

| Requirement          | Mechanism                                                                                                                                                                                                                  | Proof (automated)                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Default-deny tiers   | tool classifier → `READ`, `WRITE_LOCAL`, `EXTERNAL`, `FINANCIAL`; unknown → deny                                                                                                                                           | policy unit tests, table-driven                                                   |
| Drafting ≠ sending   | send-type tools are `EXTERNAL`; `draft_*` tools are `WRITE_LOCAL`                                                                                                                                                          | policy tests, Inbox Triage e2e                                                    |
| FINANCIAL hand-back  | always deny with "prepared for human" result                                                                                                                                                                               | policy tests                                                                      |
| Budgets              | runtime counters (tokens, $, turns, tool calls, wall-clock, runs/day) checked in hooks + orchestrator; abort on exceed                                                                                                     | budget tests with MockDriver                                                      |
| Kill switches        | per Run / per Bot / global; AbortController + process kill + queue freeze                                                                                                                                                  | kill-switch tests                                                                 |
| Secrets              | OS keychain (`@napi-rs/keyring`) with encrypted-file fallback; injected only into the tool process that needs them; redaction in PostToolUse (`updatedToolOutput`) and in the event writer                                 | redaction tests, leak tests                                                       |
| Injection guardrails | taint: Run becomes tainted when untrusted content enters (web, email, Slack, external MCP); tainted Runs cannot auto-allow `EXTERNAL`; content wrapped in `<untrusted source=…>`; Bots cannot edit their own policy/config | injection corpus (`packages/api/test/corpus`)                                     |
| Audit                | append-only `audit` table, hash-chained, each record HMAC'd with the audit key (keychain or `audit.key`, never the DB), signed checkpoints, `orbit audit export` (JSONL)                                                   | tamper-detection tests (incl. whole-chain rewrite and truncation via checkpoints) |
| CLI compliance guard | `assertCliDriverAllowed`                                                                                                                                                                                                   | AuthResolver + guard tests (every branch)                                         |
| No credential leak   | env allowlists, lint ban on credential paths, redactor                                                                                                                                                                     | env snapshot tests via fake `claude`                                              |

## 3. Milestones

Each milestone ends green (format, lint, typecheck, tests), committed with
Conventional Commits, audited by the `safety-reviewer` subagent against the
SAFETY and AUTHENTICATION requirements, and reported (shipped / how to run /
verified / next).

### M0 — Scaffold ✅

pnpm workspace, TS strict base config, ESLint (flat) + Prettier, Vitest
projects, GitHub Actions CI (no credentials), package skeletons, CLAUDE.md,
PLAN.md, ADRs, `.claude/agents` + `.claude/skills`.
**Done when:** `pnpm check` (format+lint+typecheck+test) passes locally and in CI.

### M1 — Core + drivers + one Bot, one Run, minimal CLI ✅

- `@orbit/core`: ids, Bot/Run/Trigger/Policy schemas (zod), `RunEvent` union,
  config schema, redaction utilities.
- Event store (Drizzle + better-sqlite3), append-only guard, projections, replay.
- `AgentDriver` interface; shared normalizer; MockDriver + fixtures (recorded
  from real `claude` stream-json, scrubbed); CliDriver; SdkDriver; AuthResolver;
  compliance guard; env scrubbers.
- Driver contract suite (all three drivers); AuthResolver tests for every
  branch incl. stray-API-key warning and hosted-mode refusal.
- Minimal `orbit` CLI (no daemon yet): `orbit doctor`, `orbit login-help`,
  `orbit bot create|list`, `orbit run <bot> [--prompt …]` streaming events,
  `orbit runs`, `orbit logs <run>` (replay from the log); `--json`; exit codes.
- Baseline default-deny policy (`@orbit/policy`): read tools allowed, file
  writes only inside the Bot workspace, everything else denied.
- Shipped as specified, plus `@orbit/store` (ADR-007) and the hook bridge (ADR-008).
- Safety review findings F1–F12 fixed (workspace confinement for reads and
  writes, `~` paths, bypass detection, forged-hook rejection, auth-source
  checks, redaction gaps, process-group kill, subprocess env scrub).
- `pnpm test:live` (opt-in) runs the contract smoke against the real driver.
  **Done when:** with no credentials `orbit run` works via MockDriver; with a
  logged-in `claude` it works via CliDriver; with an API key via SdkDriver.

### M2 — Policy, approvals, audit, sandbox ✅

- Policy engine (tiers, rules with scope+expiry, taint), approval queue with
  park-and-resume, audit log (hash chain, export), budgets + kill switches
  (runtime-enforced).
- Hooks wiring for both drivers (SDK callbacks; CLI generated settings with
  PreToolUse + PostToolUse through the loopback hook bridge — ADR-008).
- Shipped: `@orbit/policy` (tier classifier, PolicyEngine, RuleStore,
  ApprovalQueue with one-shot grants, approval cards with diffs, AuditLog,
  SecretVault), orchestrator park/resume, budgets (tool calls, wall clock,
  tokens, cost per run/day, runs per day), kill switches (run, bot, global,
  cross-process), taint, PostToolUse redaction, `@orbit/sandbox`
  (directory/worktree + Claude Code native sandbox settings, Docker with
  limits), CLI: `approvals`, `approve` (edit / always / expiry), `deny`,
  `resume`, `stop`, `bot pause|resume`, `kill`, `rules`, `audit`
  (`verify`, `export`), `secret`.
- Verified live against Claude Code 2.1.289: PostToolUse `updatedToolOutput`
  hides vault secrets from the model; `continue: false` stops the engine when
  a Run parks.
- Sandbox: `WorktreeSandbox` (dev/CLI mode, Claude Code sandbox settings for
  fs/network) and `DockerSandbox` (API-key mode; cpu/mem/pids limits, network
  allowlist via proxy). Docker tests auto-skip without a daemon; CI runs them.
  **Done when:** policy/budget/kill-switch/approval tests pass; a Mock run that
  tries an EXTERNAL action parks and resumes after approval.

### M3 — API, sdk-client, scheduler, rate limits ✅

- Hono REST + SSE (`Last-Event-ID` resume, heartbeats), OpenAPI from zod,
  local token auth (token file 0600, loopback bind by default), OIDC only in
  hosted mode.
- `@orbit/sdk-client` generated from OpenAPI + SSE helper.
- Scheduler (croner), trigger router (cron, webhook with HMAC, manual,
  fs/git via chokidar), run queue (priority + global concurrency),
  RateLimitManager (usage-limit pause → `rate_limited` status with `resetsAt`,
  auto-resume if Bot allows).
- `orbitd` app: config, wiring, graceful shutdown, `orbit daemon start|stop`
  (the CLI auto-starts a local daemon on loopback).
- Shipped (ADR-010): `@orbit/api` (one route/zod contract driving Hono
  validation, OpenAPI 3.1 via zod's native JSON Schema — checked in as
  `packages/api/openapi.json` — and the client; `OrbitService` behind it;
  bearer-token auth, Host allowlist, cross-origin refusal, body limit; SSE
  `/v1/events` with Last-Event-ID resume and heartbeats), `@orbit/sdk-client`
  (typed, validated responses, SSE reconnect, local discovery), `orbitd`
  (single writer, lock per home, loopback only, fresh 0600 token per start,
  graceful stop, restart recovery), `RunQueue` (priority, per-driver
  concurrency: CLI 2), `Scheduler` (cron/interval via croner, no missed-fire
  replay, no overlap), `RateLimitManager` (account-wide hold,
  `run.resume_scheduled` "resumes at", auto-resume), CLI as a thin client
  (`orbit daemon start|stop|status|restart`, `queue`, `schedules`,
  `bot create --cron/--every`; guarded).
- M2 deferrals closed: compare-and-set on start/resume/stop, approval expiry
  set by the orchestrator and swept, grants scoped to the next segment,
  workspaces/containers/branches keyed by Bot id, redacted Bot specs,
  `PostToolUseFailure` fail-closed (engine stopped before the model reads a
  secret in a tool error; the hook script fails closed for post hooks).
- Safety review: no CRITICAL/HIGH; all hard constraints PASS. Fixed: M1 a
  workspace that fails to prepare fails the Run (and `stop` closes orphaned
  `running` Runs), M2 kill switches re-checked after workspace preparation and
  on every tool call, L1 daemon log and API errors use the vault-aware
  redactor (malformed bodies are never echoed), L2 global kill / Bot pause
  also close parked and rate-limited Runs, L3 M2 workspaces adopted only by
  Bots created before M3 under their first name, L4 Host header checked as
  well as the URL, L5 atomic stale-lock takeover and the token written only
  after listen.
- Deviation: webhook (HMAC) and fs/git triggers moved to M7 (with Slack and
  plugins); hosted mode / OIDC / non-loopback binds to M8 (orbitd refuses
  them until then).
  **Done when:** API contract tests + SSE resume test + scheduler/queue tests pass.

### M4 — TUI complete ✅

Three panes (Bots / timeline / approvals+context), vim keys, `?` overlay,
mouse optional, status bar (driver, auth method, usage-limit), diff rendering,
approvals in TUI; commands `orbit bot create|list|run|pause|logs`,
`orbit approve <id>`, `orbit tail <run>`, `orbit doctor`, `orbit login-help`,
`--json` everywhere, exit codes, shell completions (bash/zsh/fish); 16-color
and narrow-width layouts. Snapshot tests (ink-testing-library).

- Shipped: `orbit` (alone, in a terminal) / `orbit tui`: Ink 8 TUI over
  `@orbit/sdk-client` with three panes (Bots + run history, live timeline,
  approval cards with diffs), a status bar ordered by importance (kill
  switch, usage-limit hold, connection, queue, driver/auth), vim keys, `?`
  help with a symbol legend, pane-aware footer hints, a full-screen card view
  that every approval goes through, deny-with-reason prompt, `y`-only
  confirmations, a tabbed one-pane layout below 100 columns, height-aware
  overlays down to 40×12, 16 basic colours plus non-colour focus cues, and
  NO_COLOR honoured. CLI: `orbit tail`, `bot run|logs`, `--json` on every
  data command (JSON errors on stdout), `orbit completion bash|zsh|fish`.
- Tests: key handling is a pure model (`onKey`) unit-tested without a
  terminal; frames are snapshot-tested at several sizes with an in-memory
  harness (`apps/orbit-tui/test/render.ts`, replacing ink-testing-library,
  whose terminal is fixed at 100 columns); one test drives the TUI against a
  real in-process orbitd; a real-terminal (pty) smoke run passed.
- Reviews: safety — no CRITICAL/HIGH; all hard constraints PASS. Fixed:
  terminal-escape injection from model/tool text everywhere it is shown
  (TUI and CLI, incl. conceal and OSC 52), approval selection tracked by id
  with a no-op on a card replaced under the cursor, approving only from the
  full card, `y`-only confirmations, explicit always-allow scope, quoting
  guard for completion names, redacted error hints, wider control-character
  set. UI review — fixed focus without colour, overlay heights, loading
  state, status-bar priority, approvals count in narrow mode, readable full
  card, timeline scroll clamping, distinct symbols, out-of-pane key hints.
  Also fixed a time-bombed API test (the usage-limit fixture resets at a
  fixed instant; the test clock is now pinned).

### M5 — App ✅

Design tokens (light/dark), Storybook, app shell with auth/driver header;
Inbox/Needs You (A/E/D, J/K), Bots grid/list (status, sparkline, usage, next
run), Bot detail (goal, triggers, tools, permissions, budgets, versioned
config diff), Run view (virtualized live timeline, collapsed tool I/O, diffs,
subagent tree, meter, pause/resume/stop, take-over terminal, replay scrubber),
Create Bot wizard (Claude proposes config), Cmd+K palette + search,
Settings (auth & driver + doctor, models, integrations, policies, budgets,
audit, theme), first-run onboarding. Optimistic UI, skeletons, toasts with
undo, SSE auto-reconnect. Playwright e2e for the approval flow (MockDriver);
axe accessibility checks; screenshots reviewed.

- Shipped: `apps/orbit-app` (React 19, Vite 8, Tailwind v4 design tokens in
  light and dark, shadcn-style components on Radix, TanStack Router and
  Query) over `@orbit/sdk-client/browser` only (guarded). Screens: Inbox /
  Needs you (j/k, Enter/a open the full card, approve only from the card,
  e edit-then-approve with a live diff, d deny with a reason, A always-allow
  behind an explicit y; selection follows the card id), Bots grid/list
  (status in words, sparkline, usage, next run), Bot detail (goal, triggers,
  tools, permissions, budgets, versioned config diff and edit with Undo), Run
  view (virtualized live timeline, collapsed tool I/O, file diffs, subagent
  tree, budget meters, stop / resume / pause Bot / run again, replay
  scrubber), Runs, Create Bot wizard (least-privilege proposal from the goal,
  every choice explained), Cmd+K palette, `?` keyboard help, Settings (auth &
  engine/doctor, policies, budgets, secrets, audit verify/export, theme, kill
  switch), first-run welcome with a mock demo. Optimistic updates, skeletons,
  toasts with Undo for reversible actions, an SSE feed that reconnects and
  refetches after a gap; Storybook with the design tokens.
- ADR-011: orbitd serves the App on its own loopback origin with a strict
  CSP; `orbit app` signs a browser in with a single-use, 2-minute ticket in
  the URL fragment, traded for an HttpOnly `SameSite=Strict` per-port cookie
  plus a per-session CSRF secret; origin allowlist (own origin plus loopback
  / Tauri origins from `ORBIT_ALLOWED_ORIGINS`). Browser-safe entries
  `@orbit/core/browser` and `@orbit/sdk-client/browser` (guarded against Node
  built-ins).
- M4 deferrals closed: one status/tier vocabulary and local + relative times
  in `@orbit/core` (`vocabulary.ts`) used by the TUI, the CLI and the App; the
  TUI selects Bots — and older Runs — by id.
- Tests: pure models (Inbox keys, timeline, diffs, wizard, live feed),
  component tests mounting the App over the real API service in-process,
  every story rendered with axe, a token contrast test (text 4.5:1, control
  borders and focus ring 3:1, both themes), Playwright e2e against a real
  orbitd with the MockDriver (approval flow incl. edit and deny, live
  reconnect and catch-up, sign-in and cookie-replay security, axe on every
  screen in both themes and at 768/1024 px, no sideways scrolling); a CI job
  builds the App and Storybook and runs the e2e. Also: `pnpm lint` had run
  out of memory on the CI runner since M3 (CI's lint job was red); CI now
  gives it a 6 GB heap. The `.tsx` pragma test CLAUDE.md promised now exists.
- Safety review: one HIGH, fixed — the session cookie alone was a full API
  credential that any other loopback port could harvest (cookies ignore
  ports); a per-session CSRF secret held in the App's origin storage is now
  required. Also fixed: M1 the sign-in link no longer appears on the browser
  launcher's command line (0600 redirect file), M2 doctor warns while extra
  origins are allowed, L1 FINANCIAL cards cannot be approved from the
  keyboard either, L2 the always-allow prompt is scrubbed, L3 a test pins the
  launcher's environment, L4 orbitd refuses an edited approval that still
  holds a `[REDACTED:…]` placeholder, L5 requests without a Host header get 400. All hard constraints PASS.
- UI review: fixed the Inbox key handler stealing keys from other controls
  and dialogs (focus is the selection now, roving tabindex), the 768 px
  overflow (Policies form, Runs table, side nav moved to `lg`), reduced
  motion freezing skeletons, form-control borders below 3:1 (new
  `--border-input`), a content-sized timeline with the result first,
  held calls no longer counted as denials, labelled model/driver badges,
  "Resume Bot" instead of a misleading Undo after a pause, wizard focus and
  hint wiring, always-allow no longer cancelled by Tab, Ctrl/⌘+Enter to
  approve an edit, short header auth label, platform-correct ⌘/Ctrl, tokens on
  toasts, keyboard-reachable scrolling tables, consistent marks and times.

### M6 — Memory, feedback, teams ✅

Memory store (markdown + SQLite FTS5), Orbit MCP memory tools, post-run
summarizer on the triage model, feedback ingestion (thumbs, edits,
approvals/denials) injected into future runs; memory browser (view/edit/
delete). Subagents (`agents` / `--agents`) and peer-Bot delegation
(`delegate_to_bot` → child Run); live delegation tree in App and TUI.

- Shipped (ADR-012, ADR-013): `@orbit/memory` — memories in SQLite with an
  FTS5 index and a markdown mirror (`$ORBIT_HOME/memory/<bot>/<id>.md`, 0600),
  provenance (`source`, Run, `taint`), redaction before storage, bounded per
  Bot; only trusted memory is offered to new Runs (tagged as data), untrusted
  memory taints a Run that reads it, only the owner clears taint (audited).
  Feedback ingestion: thumbs (+ comment), approvals, edited approvals and
  denials become feedback memories composed by Orbit. Post-run summaries:
  `result` (default, free), `triage` (metered), `off`. The **triage path**
  (`TriagePath`): every summary and Create Bot proposal call counted,
  capped by `triage.maxCallsPerDay` (default 20), refused under the kill switch
  or a usage-limit hold, run one at a time, shown in Settings → Budgets,
  `orbit triage`, the timeline and the wizard. Orbit's MCP tools
  (`memory_search`, `memory_read`, `memory_write`, `delegate_to_bot`) on the
  loopback `/mcp/orbit` endpoint (per-segment token in a 0600 `--mcp-config`
  file; every call must match a call the policy allowed) for the CLI engine,
  an in-process SDK server for the SDK engine, direct calls for the mock.
  Subagents (`BotSpec.subagents` → `--agents` / `agents`, tools ⊆ the Bot's).
  Peer delegation: child Runs with the parent's taint and remaining budget,
  parent parks as `delegating` (new status) and resumes with the answers as
  untrusted data; stopping or pausing carries to descendants; delegation
  chain on approval cards. Taint through workspace files (closes M2 review
  M1). API: memory CRUD and search, Run memory, feedback, delegation tree,
  workspace taint, triage usage, Bot proposal. CLI: `orbit memory
list|show|add|edit|rm`, `feedback`, `tree`, `triage`; delegating Runs are
  followed until they resume.
- App: Memory screen (search, provenance in words, edit, review/trust, pin,
  delete, add), Run view delegation tree (live), thumbs feedback and "what it
  remembered", Bot detail → Memory & team (summary mode, subagents, peers,
  workspace taint with clear), Create Bot "Ask Claude to propose" (states the
  model, the credentials and calls left today before the call), triage usage
  card, timeline rows for every M6 event. TUI: memory browser (`m`: list,
  open, `/` search, `e` edit with Ctrl-S, `x` delete, `T` review, `P` pin),
  delegation tree (`t`), `+`/`-` rating.
- M5 deferrals closed: Claude-written config proposal in the wizard (triage
  path, never silent), taint through workspace files, audit rows as names and
  links, Settings entries in the Cmd+K palette, live verification of subagent
  tool calls under the CliDriver.
- Verified live (Claude Code 2.1.289, haiku, `packages/api/src/m6.live.test.ts`):
  a subagent's Read was decided by Orbit's PreToolUse hook with its
  `parent_tool_use_id`; the CLI engine called `mcp__orbit__memory_write` over
  `/mcp/orbit` with its segment token, the call matched the policy's
  authorization and the memory was written; the session closed with the
  segment.
- Safety review: one HIGH, fixed — parallel `delegate_to_bot` calls in one
  segment each got the parent's whole remaining budget; unfinished children
  now keep their ceiling reserved and a new child gets at most half of what
  is left. Also fixed: M1 children of a Run that ended at a daemon restart no
  longer start (recovery stops them), M2 workspace taint keys are canonical
  (symlinks, case-insensitive volumes), M3 memory text reaches the engine
  with the first prompt on stdin instead of `--append-system-prompt` on argv,
  control characters are stripped from memory and a failed spawn cleans up,
  M4 eviction never drops the owner's feedback (untrusted Bot notes first);
  LOW: memory context built inside the segment's try, sanitized field names
  and tainted edit-feedback from tainted Runs, no memory titles in the
  append-only event log, the per-Run note limit counts across segments,
  delegation taint audited, contained shells exposed to marked files,
  parked-for-delegation status kept `delegating`, children get the wall clock
  their parent has left, new tests for the `/mcp/orbit` Host and body guards,
  the global kill across delegation, cycles and depth. All hard constraints
  PASS.
- UI review: fixed the TUI memory view (split before scrubbing, wrapped and
  scrollable at 80×24), a real TUI editor (cursor, arrows, discard prompt),
  no stale or other-Bot list in the browser (and the watch stops on close),
  the browser kept on screen under its confirm prompts, `?` inside TUI
  overlays, shorter help rows, no emoji; App: delegated spend in the cost
  meter and inherited ceilings on every meter, thumbs that look saved only
  when saved, Settings rows in the palette only while searching, j/k / arrow
  navigation with one tab stop and focus kept after actions on the Memory
  screen (help lists it), loading states and "500+" on the Memory & team tab,
  kind and signal words from `@orbit/core`, one `formatCost`, clearer wizard
  cost note (demo mode says no model is called; disabled reason), triage card
  wording, delegation link names, no duplicated delegation sentence on cards.

### M7 — Plugins, MCP registry, Slack ✅

Plugin manifest format (zod schema, tiers per tool, required secrets),
registry/loader, five reference plugins (GitHub, Slack, Gmail/Calendar,
Filesystem, Browser/Playwright), Slack trigger (Socket Mode, no public URL).
Demo Bot **Inbox Triage** (scheduled, drafts replies, requests approval).

- Shipped (ADR-014): `PluginManifest` in `@orbit/core` (tools with fixed
  tiers and an `egress` flag, secrets by name, owner settings, an env
  allowlist, a stdio or http server; credential and loader variable names are
  refused). `PluginRegistry` in `@orbit/runtime`: the reference plugins under
  `plugins/*` plus owner-added folders, off until enabled; enabling starts the
  server once, keeps the schemas of the declared tools it really offers and
  records the manifest hash (a changed manifest is held back until re-enabled);
  undeclared tools never reach a Bot. orbitd starts a plugin per Run segment in
  the Bot's workspace with `buildPluginEnv` (base allowlist, its env names,
  settings, its own vault secrets `plugin_<id>_<NAME>` except orbit-scoped
  ones, a worktree Bot's repository and branch, and the paths it must refuse)
  and proxies it to
  the engine: CLI over `POST /mcp/plugins/<id>` (segment token, 0600
  `--mcp-config`), SDK as in-process servers, mock directly (unenabled plugins
  replay the recording in demo mode). A call runs only if Orbit's PreToolUse
  decision allowed exactly that input. Declared tiers are exact-name overrides
  after `ORBIT_TOOL_TIERS`, raised to the floor their names set (money verbs
  FINANCIAL; sending, writing, creating, running or clicking EXTERNAL; drafts
  and commits WRITE_LOCAL); the engine sees the manifest's descriptions; plugin
  output always taints. `BotSpec.plugins`.
- Reference plugins (`@orbit/plugin-kit` stdio server; tests with local fakes
  only): **GitHub** (issues, PRs, comments; `git_status|diff|log`, `git_commit`
  WRITE_LOCAL and `git_push` EXTERNAL for worktree Bots — git runs with an
  explicit `GIT_DIR` in the repository Orbit names, never the workspace's
  `.git`; hooks and signatures off; config and the push credential only in
  `GIT_CONFIG_*` env; only the Bot's own branch; `git_push` names branch and
  sha), **Slack** (read
  channels/threads, `post_message` / `add_reaction` EXTERNAL), **Gmail &
  Calendar** (`create_draft` WRITE_LOCAL, `send_draft` / `create_event`
  EXTERNAL, `send_draft` names recipients and subject and sends only a
  matching draft, refresh-token auth, header injection refused), **Filesystem**
  (owner folders, symlink-safe confinement, credential stores, `$ORBIT_HOME`
  and hidden paths refused, writes EXTERNAL), **Browser**
  (headless Chromium, owner domain allowlist enforced by request routing and a
  loopback filter proxy that also catches redirects, WebSockets blocked,
  `open_page` an egress READ).
- Inbound triggers (`TriggerSpec` kinds `webhook`, `slack`, `file`, `git`;
  `TriggerRouter`): webhooks at `POST /hooks/<bot>/<trigger>` on the loopback
  port, HMAC-SHA256 verified in constant time before parsing or storing
  (Orbit style with timestamp and skew, or GitHub style once per delivery id
  and per signed body; one 401 for every failure, with the same HMAC work for
  unknown hooks; no token or cookie; Origin refused); Slack over Socket Mode
  (outbound `wss` WebSocket, envelopes acknowledged, mentions or messages,
  channel and user filters; on the subscription engine `users` is required);
  files and git with chokidar (debounced, git also polled, forced safe git
  config, never a repository inside `$ORBIT_HOME`). Trigger content reaches the Run
  in `<orbit-untrusted>` tags and the Run starts tainted; never while the
  trigger's previous Run is in flight; nothing listens while the kill switch is
  on.
- **Inbox Triage**: `BOT_TEMPLATES` (`orbit templates`, `bot create --template`,
  the wizard's "Use Inbox Triage"): weekdays at 08:00, Gmail plugin, drafts
  replies, `send_draft` waits for approval, payment requests handed back; a
  recorded mailbox (with an injection attempt) in demo mode.
- Integrations views: App Settings → Integrations (deferred from M5): plugin
  cards with state, tools by tier, secrets set/missing (stored once, never
  shown), settings, enable/disable after a confirmation that lists exactly what
  the plugin gets; inbound triggers with listener state and a one-time webhook
  signing secret; add a plugin by folder; plugins in the wizard and on Bot
  detail. CLI: `orbit plugins`, `plugin show|enable|disable|check|add|rm|secret|setting`,
  `triggers`, `trigger webhook-secret`, `templates`, `rules add --match`
  (all with `--json`). TUI: `i` opens Integrations (Enter opens a plugin, `e`
  enables or disables it after `y`).
- Deferrals closed: worktree git commits (M2), L10 (4–5 character secrets
  redacted where they stand alone; the vault refuses shorter ones) and L11
  (`inputMatch`: `*` is one value, lists must match entry by entry, `..`
  never matches, settable from the API and CLI), webhook and file/git
  triggers (M3), Settings → Integrations (M5), background subagents
  (`task_started` / `task_updated` / `task_notification` modelled:
  `subagent.backgrounded`, then `subagent.stopped` with an outcome), a
  delegating Bot's daily budgets counting its delegations, local-date summary
  titles, feedback naming the Run by its label, Esc in the approval card's
  fields and global shortcuts never over a dialog.
- Verified live (Claude Code 2.1.289, haiku, `packages/api/src/m7.live.test.ts`):
  the CLI engine called `mcp__filesystem__read_file`, Orbit's hook allowed it as
  READ, the plugin process orbitd started answered over `/mcp/plugins/filesystem`
  with the segment token, and the Run was tainted by the result.
- `pnpm lint` runs ESLint in three processes (CI's heap); CI runs the Browser
  plugin's Chromium tests in the e2e job.
- Safety review: first verdict "do not close"; all findings fixed. HIGH:
  plugin git ran against whatever the Bot-writable `.git` file named (a
  rewritten gitdir could run its own filter programs or commit to another
  Bot's branch) — now explicit `GIT_DIR`/`GIT_WORK_TREE` from the repository
  and branch Orbit names; the Filesystem plugin could read credential stores
  and Orbit's data — now `ORBIT_DENIED_PATHS` plus hidden paths refused.
  MEDIUM: thumbs feedback no longer quotes webhook/Slack/file/git prompts into
  trusted memory; plugin tier floors cover writing, creating, running and
  clicking; GitHub-style webhooks accept each signed body once; `send_draft`
  and `git_push` approvals show what is sent; git triggers force safe git
  config and refuse `$ORBIT_HOME`; Slack triggers on the subscription must
  name their users. LOW: plugin folders inside `$ORBIT_HOME` refused,
  manifest descriptions served to the engine, Slack ids and `wss` checked,
  whitespace-padded short secrets refused, Slack's app token never reaches the
  plugin process (`scope: "orbit"`), same HMAC work for unknown hooks; Browser
  DNS checks deferred (§7). Re-review: all earlier findings closed except two
  that it judged partial, now fixed. A nested repository the Bot made could
  still run its own git config through the GitHub plugin's `git add`/`status`
  (HIGH): git now never looks inside nested repositories or submodules, and
  `git_commit` refuses while there are any (positive-control test with a
  filter program). The tier floor was a list of bad words (MEDIUM): READ is
  now allowed only for read-like names; everything else floors at EXTERNAL.
  LOW: padded secrets are also redacted in their trimmed form, the Filesystem
  plugin opens with `O_NOFOLLOW` and re-checks what it opened, GitHub body
  hashes are kept for good. Hard constraints PASS. Verified by the reviewer
  (its proof-of-concept re-run: the filter never ran): the gate may close.
  Afterwards a refused Filesystem write also removes the empty file it
  created, and the App tests unmount before dismissing toasts (a toast timer
  could fire after jsdom was gone).
- UI review: HIGH: the Policies table shows a rule's `inputMatch`, CLI plugin
  output scrubs every manifest field, Integrations offers "Set up" (focusing
  the first missing field) instead of an Enable that would fail, missing
  settings and secrets get the right command. MEDIUM: Copy for the one-time
  webhook secret and the full address; plugin details collapsed unless on;
  Bot detail badges warn when Runs cannot use a plugin; the wizard's plugin
  picker shows loading and errors, links to Integrations and warns on review;
  TUI plugin warnings first; local times in the rules list; a demo-mode note
  for unavailable plugins; quiet repeated taint notes. LOW: labelled
  buttons, group roles, h2 sections, hints outside control rows, named
  background-subagent notes, focus back after Esc, template placement, TUI
  hint/vocabulary/error states, CLI alignment, `--rotate` for webhook secrets.

### M8 — Hardening and packaging ✅

Budget/kill-switch/injection test corpus, load test (N concurrent Mock runs,
SSE fan-out), docs (README with diagram, quickstart for both auth modes,
compliance note, security model, screenshots), `docker compose up`
(orbitd + app, API-key mode), Tauri build, npm bin, release workflow.

- **Security corpus** (`packages/api/test/corpus`, full stack: service,
  MockDriver behind a recording tap, policy, a real corpus plugin, triggers,
  memory, delegation): 38 attacker payloads (instructions, tag breakouts in
  every spelling, terminal escapes and bidi, 60 000-character texts) × ten
  channels (Orbit- and GitHub-style webhooks, Slack, file and git watchers,
  plugin output, untrusted memory, delegated answers, WebFetch, a file a
  tainted Run wrote) — tainted with the right source, wrapped, never closing
  or forging a tag, secrets redacted everywhere, every injected request parked,
  denied or handed back as ADR-009 says; budgets in every dimension (resumes,
  delegation, daily, triage); kill switches over six Run states × four
  controls, triggers and triage refused under a global kill; the same payloads
  scrubbed in `orbit logs`/`tail`, the TUI timeline and approval cards.
  Bugs it found, fixed: look-alike tag spellings closed untrusted blocks and
  untrusted tool output could forge `<orbit-memory>` (one `neutraliseTags`,
  PostToolUse neutralises untrusted output); `maxTurns` was only passed to the
  engine (now counted and enforced by Orbit); a stop, pause, kill or budget
  waited for an in-flight plugin call (plugin servers now stop with the
  segment); a kill switch set from another process left waiting Runs to
  continue after the release; a delegating parent whose child ended at once
  could stay parked forever; `get_rm`-style names floored at READ.
- **Load test** (`pnpm load-test`): orbitd in process, N concurrent mock Runs,
  M SSE subscribers through `@orbit/sdk-client` (two dropped mid-stream and
  resumed with `Last-Event-ID`); every subscriber gets every event once, in
  order, without gaps; throughput, delivery latency and peak RSS reported. A
  CI-sized case (40 Runs × 10 subscribers) runs in the suite.
- **Hosted mode** (ADR-015): `ORBIT_MODE=hosted` with `publicUrl`, OIDC
  sign-in for the App (authorization code + PKCE, `jose`, mock issuer in
  tests), in-process TLS (non-loopback bind) or a TLS proxy on the same
  machine, `__Host-` Secure cookies, HSTS; principals with roles
  (`viewer`/`operator`/`owner`), a least role on every contract route
  enforced before handlers (`roles.test.ts` lists them all), audit actors are
  the request's principal; webhooks on the public URL. Never the CliDriver.
  Container bind for Docker Compose: `0.0.0.0` only with `ORBIT_CONTAINER=1`
  and a container marker, published as `127.0.0.1`.
- **Docker sandbox** (ADR-018): containers keep `--network none`; the engine
  sees a placeholder key and reaches the API only through a per-Bot host-side
  key-injecting proxy on a read-only 0600 Unix socket (two routes, request
  bodies checked); egress only through a CONNECT allowlist proxy that resolves
  names on the host and refuses private and metadata addresses; both forward
  only while a Run holds a lease; Bash is WRITE_LOCAL in a container only with
  `network: none`; `/workspace` paths mapped in policy; containers recreated
  when their shape changes; the experimental gate is gone (API keys and
  helpers; never Bedrock/Vertex or CLI mode). Verified against a real Docker
  daemon and the real engine binary (stand-in upstream).
- **No API key in any child process** (ADR-018 amendment): host SDK engines
  get a placeholder key and `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/<token>`
  of orbitd's `HostKeyProxy` (one loopback listener, a token per Run segment,
  closed at the segment's end or abort, redacted); the key or apiKeyHelper
  output stays in orbitd. This also fixed a startup failure found while
  verifying the Docker sandbox: Claude Code refuses
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` on Linux without bubblewrap, which would
  have stopped every API-key Run on such hosts and in Docker Compose; the scrub
  is now on where Claude Code can enforce it and off where no secret remains to
  scrub. Bedrock/Vertex credentials still reach the engine (scrub on; Linux
  needs bwrap, checked before start). Doctor reports `engineKey`. Verified
  against the real engine binary (path prefix kept, placeholder accepted).
- **Plugins** (ADR-019): stdio plugin servers run under bubblewrap (Linux) or
  `sandbox-exec` (macOS) built from the manifest's new `sandbox` section
  (`plugins.sandbox` auto|required|off): empty `$HOME`, no `$ORBIT_HOME`,
  workspace, network and owner folders only as declared; Chromium keeps its
  own sandbox inside bwrap. The Browser plugin's proxy resolves each name once,
  refuses private/metadata answers and connects to what it checked; Chromium
  resolves nothing itself. `orbit plugin install <id> | npm:<pkg>@<ver>
--integrity` from a catalog: SRI checked before reading, strict extractor,
  no package code run, stored outside `$ORBIT_HOME`, installed disabled
  (`plugins/catalog.json` ships empty: no third-party plugin to vouch for).
- **Run controls** (ADR-016): per-Run pause at the next tool-call decision
  (`orbit pause <run> [--now]`, TUI `P`, App), interrupted Runs resume
  automatically when safe (session known, fewer than 2 retries, no allowed
  EXTERNAL call without a result; `onInterrupt: fail` opts out; a graceful
  daemon stop pauses Runs), take-over through `orbit shell <bot>` (bearer
  token only, holds the Bot, audited; the App shows the command).
- **Audit and memory:** each audit record HMAC'd with an audit key kept like
  the vault key (keychain or `audit.key`, never the database), signed
  checkpoints (`orbit audit checkpoint`, `verify --checkpoint`) catch a
  whole-chain rewrite or truncation; memory export/import as JSONL with
  provenance (owner only, all or nothing, redacted, `--untrusted`), retention
  (`memory.maxPerBot`, `memory.retentionDays`, never owner facts, feedback or
  pinned memories).
- **TUI and CLI:** opt-in mouse (`orbit tui --mouse`, `M`; clicks only
  select), dynamic shell completion from a running daemon only
  (`orbit __complete`).
- **Packaging** (ADR-017): the npm package **`orbit-bots`** (bins `orbit`,
  `orbitd`; esbuild bundles instead of tsup; native modules and the Agent SDK
  stay dependencies; one asset-layout seam `orbitLayout()`; a bundle guard for
  credential reads; `pnpm smoke` packs, installs and drives it; CI job
  `package`), `docker/orbitd.Dockerfile` + `compose.yaml` (one container,
  API-key mode, host loopback only, read-only root, all capabilities dropped;
  CI job `docker`), a Tauri 2 desktop shell (`apps/orbit-desktop`, loads the
  App from the local orbitd with a ticket from `orbit app --json`, no IPC for
  the remote page; optional `desktop.yml`), and `release.yml` (check, npm
  publish with provenance, GHCR image, desktop bundles, GitHub Release).
- **Docs:** README with diagram and screenshots, `docs/quickstart.md` (demo,
  subscription, API key, Docker Compose, hosted mode, desktop),
  `docs/compliance.md` (subscription vs API key, who may start Runs),
  `docs/security.md` (security model), `docs/architecture.md`.
- Open questions 1 (npm name: `orbit-bots`) and 4 (generic OIDC, mock
  issuer in tests) are settled.
- Safety review: no CRITICAL/HIGH. Fixed: MEDIUM-1 a sandboxed plugin could
  plant git hooks or config for the owner (the common git dir is now
  read-only; only objects, refs, logs and the Bot's own worktree entry are
  writable); MEDIUM-2 `orbit shell` opened the owner's shell over a `.git` the
  Bot could rewrite (Orbit's worktree pointer is restored and audited, a
  directory Bot with a `.git` is refused, the shell gets `GIT_DIR`,
  `GIT_WORK_TREE` and `GIT_CEILING_DIRECTORIES`); MEDIUM-3 the API key stayed in
  orbitd's environment (`ORBIT_API_KEY_FILE`, the CLI hands the key over on
  stdin, an orbitd started with the key re-execs itself without it, Compose
  uses a file secret; doctor `api_key_in_environment` where that is not
  possible); MEDIUM-4 the npm token reached install scripts in the release job
  (publish step only; actions pinned by SHA). LOW: apiKeyHelper output
  redacted, checkpoint actor, a warning for an existing audit key with an
  unkeyed log, abstract Unix sockets documented, confusable letters and double
  encodings in `neutraliseTags`, the Browser proxy forwards the checked
  authority, packaging scripts use an env allowlist (lint catches
  `env: process.env`), only a real Node prefix is bound into plugin sandboxes,
  key-proxy tokens leave the redactor after their segment, a Windows panic in
  the desktop shell, a configured principal `owner` refused in hosted mode.
- UI review: HIGH — the TUI cut off why a Run was paused and what to do (now
  wrapped with the next step and keys); the App ignored the hosted role (now
  gated by the contract's roles through `roleFor`, with "Needs the X role"
  hints). MEDIUM — Run control order and icons, memory import preselects the
  file's Bot and names its source, export failures toast, the hosted header at
  768 px, `P` and palette entries for pause, take-over and import, the
  take-over dialog in hosted mode, the plugin catalog fetched only on "Browse
  catalog" with Retry, plain-language sandbox needs. LOW — text-style pause
  glyph, ◆ for parked approvals in the TUI, tooltips, "you" for the owner,
  import dialog polish, audit checkpoint messages, doctor row marks, TUI help
  layout, take-over wording, install progress, `memory import` preview exit
  code.

### After 0.1 — A chat-first App: conversations, avatars, the Bot's computer (ADR-020) ✅

Orbit was meant to feel like OpenDots (CopilotKit's template for persistent
agents, "each with its own computer") or Grok's bots; the 0.1 App was an
operations console. ADR-020 records what was adopted, adapted and left out.

- Conversations are chains of Runs: `POST /v1/bots/{bot}/runs` with
  `continues` (the latest, ended turn) resumes the conversation's engine
  session with the owner's message, inheriting the earlier turn's taint; no
  forks (checked and queued synchronously by the single writer). `run.queued`
  records `conversationId` / `continuesRunId`; migration 7 adds an indexed
  `runs.conversation_id`; `GET /v1/runs?conversation=`; the CLI's
  `orbit run <bot> --continue <run>`.
- `BotSpec.avatar` (`@orbit/core` `avatar.ts`): eight characters × eight
  colours, a stable default per Bot id, a free one suggested for new Bots.
- The Bot's computer, read-only: `GET /v1/bots/{bot}/computer`
  (state, workspace, take-over, web access), `/computer/files`,
  `/computer/file` (a link-proof reader in `@orbit/sandbox`
  `workspace-files.ts`: symlinks never followed, `O_NOFOLLOW` + inode check,
  hard links refused, `.git` hidden, previews capped and redacted, taint
  marked) and `/computer/activity` (latest calls with decisions and results).
  Demo mode now does what an allowed Write or Edit did to the workspace.
- The App: a sidebar of Bots (avatars with working / needs-you / paused) and
  the selected Bot's conversations; the chat (`/chat/$botId?c=…`) with tool
  cards, folded reads, the full approval card inline, delegations, notes,
  feedback; the computer panel (Browser, Files, Terminal, Activity) beside it;
  avatar pickers in the wizard and Bot settings; warm design tokens (AA in both
  themes); home opens the last Bot's chat. Needs you (Inbox), Runs, Memory,
  Settings, Bot settings and Run details stay.
- Tests: projection, store (migration 7, conversation filter), orchestrator
  (session resume, taint carried, refusals: fork, unfinished turn, other
  Bot's or delegated Runs, kill switch), API (conversations, computer routes:
  traversal, links, `.git`, redaction, roles), the workspace reader
  (symlinks anywhere on the path, hard links, FIFOs, binary, truncation), the
  mock's file effects, CLI `--continue`, the App (conversation builder,
  markdown, chat, approvals in the chat, computer panel, sidebar, avatar
  picker, axe) and e2e (chat + approval + reply, the computer panel with axe
  in both themes, every screen incl. the chat at 768/1024 px).
- Reviews. Safety: F1 (critical) — the workspace reader checked names with
  `lstat` and then opened the path by name, so a Bot swapping a folder for a
  link mid-read could make orbitd read or list outside the workspace; the walk
  now opens one name at a time inside the open folder (Linux
  `/proc/self/fd`, macOS `O_NOFOLLOW_ANY`, other systems refused), with a test
  that swaps a folder mid-walk. F2 (medium) — files are the operator's;
  viewers keep status and activity. L1 the Activity page reads every decision
  since its oldest call; L2 taint marks fold case like the paths; L3 only the
  newest turn may be answered (one indexed row); L4 (the session walk) is
  O(1) in practice and stays. UI: the drawer and the computer are modal
  sheets on narrow screens (H1); a request in the chat is decided from the
  keyboard with focus handled at every step (H2); trigger turns show the
  delivered content as untrusted data, not as the owner's message (H3); the
  driver badge stays on phones (H4); one live region, articles instead of
  landmarks, speakers for screen readers, the shared status words in the
  chat header, pinned navigation, a way out of every composer wait, starters
  that fill the box, `mcp__x__y` kept literal, and the smaller items (L1–L17;
  the Bot list keeps one tab stop per Bot instead of a roving tabindex).

## 4. Test strategy

| Layer           | Tooling                                                        | Notes                                                                  |
| --------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Unit / contract | Vitest (projects per package)                                  | tests first for policy, budgets, replay, AuthResolver, driver contract |
| Integration     | Vitest + in-memory SQLite + MockDriver                         | orchestrator, API, SSE resume                                          |
| TUI             | ink-testing-library snapshots                                  | 16-color + narrow widths                                               |
| App             | Vitest + Testing Library; Storybook; Playwright e2e; axe       | approval flow e2e                                                      |
| Live (opt-in)   | `pnpm test:live`                                               | uses SdkDriver if a key is set, else CliDriver; never in CI            |
| Security        | dedicated suites: env leak, redaction, guard, injection corpus | run in CI                                                              |

CI never needs credentials: `ORBIT_DRIVER=mock` is forced in CI.

## 5. Risks and mitigations

| #   | Risk                                                                           | Impact                                   | Mitigation                                                                                                  |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| R1  | `--bare` or env scrub interacts badly with SDK hooks/canUseTool                | SdkDriver could read OAuth or lose hooks | live test in M1; fallback `settingSources: []` + env scrub; contract test asserts env                       |
| R2  | Long human approvals block a subprocess (MCP/hook timeouts, burnt concurrency) | stuck Runs                               | park-and-resume (ADR-003)                                                                                   |
| R3  | stream-json schema drift between CLI versions                                  | parsing breaks                           | normalizer tolerant of unknown types (emits `raw` event), version check in doctor, fixtures per CLI version |
| R4  | CLI-mode isolation: credentials can't enter Docker (by design)                 | weaker isolation for CLI mode            | worktree + Claude Code native sandbox (ADR-004); Docker only for API-key mode                               |
| R5  | Subscription usage limits drain from always-on Bots                            | user's interactive use blocked           | concurrency 2, priority queue, runs/day caps, triage model, pause on `rejected`                             |
| R6  | zod v4 vs. Hono OpenAPI tooling compatibility                                  | API generation                           | spike at M3 start; fallback: `zod-openapi` generator directly                                               |
| R7  | Native modules (`better-sqlite3`, keyring) on user machines / Tauri            | install failures                         | verified install here; prebuilds; encrypted-file vault fallback                                             |
| R8  | No Docker daemon in dev container                                              | Docker sandbox untested locally          | tests auto-skip; GitHub Actions runner has Docker                                                           |
| R9  | Tauri needs system WebKit libs                                                 | desktop build in CI                      | build Tauri in a separate optional workflow                                                                 |
| R10 | Prompt injection via email/web                                                 | unauthorized external actions            | taint + approval escalation + no self-policy edits + corpus tests                                           |

## 6. Open questions (defaults chosen; none blocking right now)

1. **Product/npm name.** Workspace packages use `@orbit/*` (private). The
   public npm package is **`orbit-bots`** (decided in M8, ADR-017).
2. **License/copyright.** Keep MIT © 2026 Nakya for all packages? Default: yes.
3. **`CLAUDE_CODE_OAUTH_TOKEN` passthrough.** Users who authenticate the CLI
   with `claude setup-token` rely on this env var. Default: **not** forwarded to
   the `claude` child (Orbit never forwards OAuth credentials);
   `orbit doctor` detects it by name only and explains how to use
   `claude login` instead. Tell me if you want an explicit opt-in.
4. **Hosted mode scope.** Generic OIDC (tested with a mock issuer), no
   vendor-specific integration (implemented in M8, ADR-015).

## 7. Deferrals

Items intentionally postponed from a milestone are listed here with the
milestone that will pick them up. Shipped code paths contain no TODO stubs.
Everything M8 was due to close is closed (see §3 M8); what remains needs
credentials or machines this environment does not have, or is follow-up work
after 0.1.

| Item                                                                                                                                                                                                                                                                                                            | From    | To                                                     | Reason                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live SdkDriver run (`--bare` auth + SDK hook callbacks against the real API)                                                                                                                                                                                                                                    | M1      | first session with an API key                          | no API key in the dev environment; covered by the contract suite with an injected `query()`; `pnpm test:live` exercises it automatically when a key is set |
| Bedrock/Vertex `apiKeySource` values                                                                                                                                                                                                                                                                            | M1      | first cloud-provider session                           | only login sources are rejected for them until observed                                                                                                    |
| Native engine sandbox verified live (socat absent in the dev container; path syntax of `sandbox.filesystem`)                                                                                                                                                                                                    | M2      | first session on a machine with bwrap + socat or macOS | settings are generated and only used when the tools are present                                                                                            |
| Live run of DockerSandbox + SdkDriver against the real API (the real engine in a `--network none` container was verified against a stand-in upstream)                                                                                                                                                           | M2      | first session with an API key                          | no API key here                                                                                                                                            |
| Live check that `continue: false` from `PostToolUseFailure` stops the engine before its next turn                                                                                                                                                                                                               | M3      | first session with usage headroom                      | covered by driver contract tests and the mock driver                                                                                                       |
| SDK in-process Orbit MCP server and plugin servers verified live                                                                                                                                                                                                                                                | M6/M7   | first session with an API key                          | covered by the SDK contract tests with an injected `query()`                                                                                               |
| Plugins verified live against real GitHub, Slack and Google accounts                                                                                                                                                                                                                                            | M7      | first session with those accounts                      | tests use local fakes; the CLI engine → `/mcp/plugins` path was verified live                                                                              |
| Remote CLI against a hosted orbitd (personal access tokens or device flow); group-claim mapping; several issuers                                                                                                                                                                                                | M8      | after 0.1                                              | hosted mode serves the App over OIDC; the CLI on the server uses the local token                                                                           |
| Rate limiting of `/v1/auth/oidc/login`; sessions that survive a restart                                                                                                                                                                                                                                         | M8      | after 0.1                                              | pending sign-ins are bounded (128) and sessions capped (32) in memory                                                                                      |
| API calls an engine's children make through the key proxies (host or Docker) are not counted against token/cost budgets                                                                                                                                                                                         | M8      | after 0.1                                              | bounded by the lease, wall clock and kill switches and counted in doctor; metering in the proxy is the follow-up                                           |
| The key proxies (host and Docker) and the egress proxy do not chain orbitd's own `HTTPS_PROXY`: hosts that reach the API only through an outbound proxy cannot run API-key Bots yet                                                                                                                             | M8      | after 0.1                                              | the egress proxy must connect to the address it checked; CONNECT chaining in `createApiForwarder` is the follow-up                                         |
| Rootless Docker / Docker Desktop unverified; plugins of Docker Bots receive container paths (fail closed)                                                                                                                                                                                                       | M8      | after 0.1                                              | socket sharing and uid mapping differ there                                                                                                                |
| macOS `sandbox-exec` profile for plugins not run live; npm installs not tried against registry.npmjs.org (fake registry only, the catalog is empty)                                                                                                                                                             | M8      | first macOS session / first catalog entry              | generated and unit-tested                                                                                                                                  |
| The GitHub plugin's sandbox sees the owner's whole git directory read-write (except `config`, `hooks`, `info`); `/etc` and `/usr` stay readable in plugin sandboxes                                                                                                                                             | M8      | after 0.1                                              | narrowing to the Bot's own refs needs a git object store per Bot                                                                                           |
| App Inbox lists approvals only, not Runs paused for the owner; an interrupted parent does not wait again for a child delegated in the same segment                                                                                                                                                              | M8      | after 0.1                                              | paused Runs show in the Run lists and the Run view                                                                                                         |
| Signed and notarised desktop bundles, auto-updater, Homebrew/winget; the desktop shell does not sign in again after an orbitd restart                                                                                                                                                                           | M8      | after 0.1                                              | needs signing identities                                                                                                                                   |
| Memory retention from environment variables and a per-Bot retention field in the UI; clicks inside TUI overlays; completion of memory and rule ids                                                                                                                                                              | M8      | after 0.1                                              | config file, keyboard and Bot spec cover them                                                                                                              |
| Desktop bundles for macOS/Windows and the Compose file secret with a real key are built or run only in CI / by the owner (the Docker image, Compose with the mock driver, the npm package and Chromium inside bwrap pass in CI)                                                                                 | M8      | first release                                          | no Docker daemon, Mac or Windows here                                                                                                                      |
| Residuals of the plugin git sandbox: a plugin can write any ref and object and leave rebase state in the Bot's own worktree entry; network plugins can reach abstract Unix sockets (X11, D-Bus); on macOS the key stays in orbitd's environment unless `ORBIT_API_KEY_FILE` or the CLI starts it                | M8      | after 0.1                                              | recorded in ADR-018/019; per-Bot object stores and a separate network namespace are the follow-ups                                                         |
| A chat view in the TUI (it reads `conversationId`; `orbit run --continue` replies from the CLI)                                                                                                                                                                                                                 | ADR-020 | after 0.1                                              | the App is the chat client first                                                                                                                           |
| Continuing a conversation verified live with a real engine (a new Run resuming another Run's session: CLI `--resume`, SDK `resume`)                                                                                                                                                                             | ADR-020 | first session with credentials                         | the same resume path parked Runs use, covered by the orchestrator and driver contract tests                                                                |
| Screenshots in the computer's Browser tab; the sidebar lists a Bot's conversations among its 300 latest Runs                                                                                                                                                                                                    | ADR-020 | after 0.1                                              | the Browser plugin reads pages as text by design (ADR-019)                                                                                                 |
| Inside the Compose container (no bubblewrap) the key file is readable by an approved shell command or a plugin; a root entrypoint reading a root-owned secret and handing it to orbitd on stdin is the follow-up. The orbitd re-exec hand-over pipe is readable by a same-user process for the moment it exists | M8      | after 0.1                                              | key files are denied to file tools, the engine sandbox and plugin sandboxes; the CLI's stdin hand-over leaves no file                                      |
