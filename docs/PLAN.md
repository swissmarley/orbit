# Orbit — Engineering Plan

> Working name: **Orbit**. Self-hostable platform of always-on, goal-driven AI
> agents ("Bots") powered by Claude Code and the Claude Agent SDK.
> Status: **M7 complete; M8 next.**
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
Vite, Vitest and `tsx` compile on the fly, and `tsup` bundles only the
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

| Requirement          | Mechanism                                                                                                                                                                                                                  | Proof (automated)                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Default-deny tiers   | tool classifier → `READ`, `WRITE_LOCAL`, `EXTERNAL`, `FINANCIAL`; unknown → deny                                                                                                                                           | policy unit tests, table-driven           |
| Drafting ≠ sending   | send-type tools are `EXTERNAL`; `draft_*` tools are `WRITE_LOCAL`                                                                                                                                                          | policy tests, Inbox Triage e2e            |
| FINANCIAL hand-back  | always deny with "prepared for human" result                                                                                                                                                                               | policy tests                              |
| Budgets              | runtime counters (tokens, $, turns, tool calls, wall-clock, runs/day) checked in hooks + orchestrator; abort on exceed                                                                                                     | budget tests with MockDriver              |
| Kill switches        | per Run / per Bot / global; AbortController + process kill + queue freeze                                                                                                                                                  | kill-switch tests                         |
| Secrets              | OS keychain (`@napi-rs/keyring`) with encrypted-file fallback; injected only into the tool process that needs them; redaction in PostToolUse (`updatedToolOutput`) and in the event writer                                 | redaction tests, leak tests               |
| Injection guardrails | taint: Run becomes tainted when untrusted content enters (web, email, Slack, external MCP); tainted Runs cannot auto-allow `EXTERNAL`; content wrapped in `<untrusted source=…>`; Bots cannot edit their own policy/config | injection test corpus (M8)                |
| Audit                | append-only `audit` table, hash-chained, `orbit audit export` (JSONL)                                                                                                                                                      | tamper-detection tests                    |
| CLI compliance guard | `assertCliDriverAllowed`                                                                                                                                                                                                   | AuthResolver + guard tests (every branch) |
| No credential leak   | env allowlists, lint ban on credential paths, redactor                                                                                                                                                                     | env snapshot tests via fake `claude`      |

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

### M8 — Hardening and packaging

Budget/kill-switch/injection test corpus, load test (N concurrent Mock runs,
SSE fan-out), docs (README with diagram, quickstart for both auth modes,
compliance note, security model, screenshots), `docker compose up`
(orbitd + app, API-key mode), Tauri build, npm bin, release workflow.

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
   public npm name for the `orbit` bin is undecided (the `@orbit` scope is
   likely taken). Default: decide at M8; candidates `orbit-bots`, `@<you>/orbit`.
2. **License/copyright.** Keep MIT © 2026 Nakya for all packages? Default: yes.
3. **`CLAUDE_CODE_OAUTH_TOKEN` passthrough.** Users who authenticate the CLI
   with `claude setup-token` rely on this env var. Default: **not** forwarded to
   the `claude` child (Orbit never forwards OAuth credentials);
   `orbit doctor` detects it by name only and explains how to use
   `claude login` instead. Tell me if you want an explicit opt-in.
4. **Hosted mode scope.** OIDC provider for hosted mode — default: generic
   OIDC (tested with a mock issuer), no vendor-specific integration.

## 7. Deferrals

Items intentionally postponed from a milestone are listed here with the
milestone that will pick them up. Shipped code paths contain no TODO stubs.

| Item                                                                                                                                                                                      | From | To                                                   | Reason                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live SdkDriver run (`--bare` auth + SDK hook callbacks against the real API)                                                                                                              | M1   | first session with an API key                        | no API key in the dev environment; covered by the contract suite with an injected `query()`, `pnpm test:live` exercises it automatically when a key is set |
| Bedrock/Vertex `apiKeySource` values                                                                                                                                                      | M1   | first cloud-provider session                         | only login sources are rejected for them until observed                                                                                                    |
| Docker `allowlist` network via an egress proxy (today: `bridge`, and Bash stays EXTERNAL)                                                                                                 | M2   | M8                                                   | needs the allowlist proxy                                                                                                                                  |
| Native engine sandbox verified live (bwrap/socat absent in the dev container; path syntax of `sandbox.filesystem`)                                                                        | M2   | first session on a machine with bwrap/socat or macOS | settings are generated and only used when the tools are present                                                                                            |
| Recreate containers when a Bot's sandbox limits or image change                                                                                                                           | M2   | M8                                                   | today a running container is reused                                                                                                                        |
| Live run of DockerSandbox + SdkDriver (needs an API key and the sandbox image)                                                                                                            | M2   | first session with an API key                        | container mechanics are tested against the real Docker daemon                                                                                              |
| M2 review M3: Docker mode keeps the API key out of the container (host-side key-injecting proxy) and gives the engine API egress without general egress; map `/workspace` paths in policy | M2   | M8                                                   | Docker is gated behind `ORBIT_EXPERIMENTAL_DOCKER=1` until then; Bash stays EXTERNAL in containers                                                         |
| M2 review M6: keyed (HMAC) audit chain or exported head checkpoints                                                                                                                       | M2   | M8                                                   | chain detects edits/reorders/middle deletions today; whole-chain rewrite needs a key                                                                       |
| Live check that `continue: false` from `PostToolUseFailure` stops the engine before its next turn                                                                                         | M3   | first session with usage headroom                    | covered by driver contract tests and the mock driver; the weekly CLI limit is nearly used                                                                  |
| Hosted mode: OIDC principals, TLS, non-loopback bind (orbitd refuses all three today)                                                                                                     | M3   | M8                                                   | a bearer token over plain HTTP must not leave the machine                                                                                                  |
| Packaged `orbitd` bin (the CLI starts the TypeScript bin through tsx in the dev tree)                                                                                                     | M3   | M8                                                   | packaging milestone                                                                                                                                        |
| Automatic retry of Runs interrupted by a daemon stop (today: `run.failed: interrupted`, retryable, run it again)                                                                          | M3   | M8                                                   | needs an idempotency story for tool side effects                                                                                                           |
| Mouse support in the TUI ("mouse optional")                                                                                                                                               | M4   | M8                                                   | keyboard covers every action; Ink mouse input needs raw escape parsing                                                                                     |
| Dynamic shell completion of Bot names and run ids                                                                                                                                         | M4   | M8                                                   | would start the daemon from the shell's completion hook                                                                                                    |
| Run view “take-over terminal” (attach to the Bot's workspace shell)                                                                                                                       | M5   | M8                                                   | needs a pty over an authenticated WebSocket and its own safety review (it would bypass the policy engine by design)                                        |
| Per-Run pause (today: stop, resume a parked/rate-limited Run, or pause the whole Bot)                                                                                                     | M5   | M8                                                   | the engine has no suspend; a pause would be a park without an approval, designed with automatic retries                                                    |
| Desktop shell (Tauri) using the Tauri origin and a ticket from the CLI                                                                                                                    | M5   | M8                                                   | ADR-011 already allows `tauri://localhost`; packaging milestone                                                                                            |
| SDK in-process Orbit MCP server verified live (`createSdkMcpServer` + hook input shape for `mcp__orbit__*`)                                                                               | M6   | first session with an API key                        | covered by the SDK contract test with an injected `query()`; the CLI transport was verified live                                                           |
| Memory export/import and retention settings (today: bounded at 1000 per Bot, oldest unkept evicted; delete in the browser)                                                                | M6   | M8                                                   | packaging/hardening milestone                                                                                                                              |
| SDK engine's in-process plugin servers (`pluginSdkServer`, raw JSON schemas) verified live                                                                                                | M7   | first session with an API key                        | covered by typecheck and the mock/CLI paths; no API key here                                                                                               |
| Plugins verified live against real GitHub, Slack and Google accounts (tests use local fakes; the CLI engine → `/mcp/plugins` path was verified live with the Filesystem plugin)           | M7   | first session with those accounts                    | no accounts in the dev environment                                                                                                                         |
| Plugin processes run as the owner's user without an OS sandbox (Orbit's policy decides every call; env and secrets are allowlisted)                                                       | M7   | M8                                                   | needs a per-plugin container or sandbox profile                                                                                                            |
| Browser plugin: DNS answers are not checked (an allowed name resolving to a private address is reachable)                                                                                 | M7   | M8                                                   | needs a resolver check in the filter proxy                                                                                                                 |
| Installing plugins from a remote catalog or npm (today: reference plugins and local folders)                                                                                              | M7   | M8                                                   | packaging milestone; local folders keep the manifest reviewable                                                                                            |
| Plugin tier floor: a read verb followed by an unknown action word (`get_rm`, `view_eval`) floors at READ, as `classifyTool` does                                                          | M7   | M8                                                   | contrived names; the M8 injection corpus hardens the verb lists for both                                                                                   |
| Webhooks from other machines need a tunnel the owner runs (orbitd binds loopback only)                                                                                                    | M7   | M8 (hosted mode, TLS)                                | a bearer-free endpoint must not leave the machine without TLS                                                                                              |
