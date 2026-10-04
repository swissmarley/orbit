# Orbit — Engineering Plan

> Working name: **Orbit**. Self-hostable platform of always-on, goal-driven AI
> agents ("Bots") powered by Claude Code and the Claude Agent SDK.
> Status: **M2 complete; M3 next.**
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

### M3 — API, sdk-client, scheduler, rate limits

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
  **Done when:** API contract tests + SSE resume test + scheduler/queue tests pass.

### M4 — TUI complete

Three panes (Bots / timeline / approvals+context), vim keys, `?` overlay,
mouse optional, status bar (driver, auth method, usage-limit), diff rendering,
approvals in TUI; commands `orbit bot create|list|run|pause|logs`,
`orbit approve <id>`, `orbit tail <run>`, `orbit doctor`, `orbit login-help`,
`--json` everywhere, exit codes, shell completions (bash/zsh/fish); 16-color
and narrow-width layouts. Snapshot tests (ink-testing-library).

### M5 — App

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

### M6 — Memory, feedback, teams

Memory store (markdown + SQLite FTS5), Orbit MCP memory tools, post-run
summarizer on the triage model, feedback ingestion (thumbs, edits,
approvals/denials) injected into future runs; memory browser (view/edit/
delete). Subagents (`agents` / `--agents`) and peer-Bot delegation
(`delegate_to_bot` → child Run); live delegation tree in App and TUI.

### M7 — Plugins, MCP registry, Slack

Plugin manifest format (zod schema, tiers per tool, required secrets),
registry/loader, five reference plugins (GitHub, Slack, Gmail/Calendar,
Filesystem, Browser/Playwright), Slack trigger (Socket Mode, no public URL).
Demo Bot **Inbox Triage** (scheduled, drafts replies, requests approval).

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
| Enforcing the CLI-mode concurrency limit (config exists, default 2)                                                                                                                       | M1   | M3                                                   | needs the run queue                                                                                                                                        |
| CLI as a thin client of orbitd                                                                                                                                                            | M1   | M3                                                   | M1 runs Bots in-process                                                                                                                                    |
| Redacting Bot specs (goal/instructions) before storing them                                                                                                                               | M1   | M3                                                   | events are redacted; specs are user-authored                                                                                                               |
| Live verification of subagent tool calls under CliDriver (`--forward-subagent-text`)                                                                                                      | M1   | M6                                                   | covered by the synthesized fixture; a live Task run costs more usage                                                                                       |
| Bedrock/Vertex `apiKeySource` values                                                                                                                                                      | M1   | first cloud-provider session                         | only login sources are rejected for them until observed                                                                                                    |
| Docker `allowlist` network via an egress proxy (today: `bridge`, and Bash stays EXTERNAL)                                                                                                 | M2   | M8                                                   | needs the allowlist proxy                                                                                                                                  |
| Native engine sandbox verified live (bwrap/socat absent in the dev container; path syntax of `sandbox.filesystem`)                                                                        | M2   | first session on a machine with bwrap/socat or macOS | settings are generated and only used when the tools are present                                                                                            |
| Git commits from worktree Bots go through Orbit, not sandboxed Bash                                                                                                                       | M2   | M7 (GitHub plugin)                                   | `.git` lives outside the writable workspace by design                                                                                                      |
| Recreate containers when a Bot's sandbox limits or image change                                                                                                                           | M2   | M8                                                   | today a running container is reused                                                                                                                        |
| Key workspaces by Bot id instead of slug (renames)                                                                                                                                        | M2   | M3                                                   | rename support arrives with the API                                                                                                                        |
| Live run of DockerSandbox + SdkDriver (needs an API key and the sandbox image)                                                                                                            | M2   | first session with an API key                        | container mechanics are tested against the real Docker daemon                                                                                              |
| M2 review M3: Docker mode keeps the API key out of the container (host-side key-injecting proxy) and gives the engine API egress without general egress; map `/workspace` paths in policy | M2   | M8                                                   | Docker is gated behind `ORBIT_EXPERIMENTAL_DOCKER=1` until then; Bash stays EXTERNAL in containers                                                         |
| M2 review M4: PostToolUse bridge failure and failed tool output (`PostToolUseFailure`) are not redacted for the model (events still are)                                                  | M2   | M3                                                   | needs a live check of the engine's failure-hook output shape                                                                                               |
| M2 review M6: keyed (HMAC) audit chain or exported head checkpoints                                                                                                                       | M2   | M8                                                   | chain detects edits/reorders/middle deletions today; whole-chain rewrite needs a key                                                                       |
| M2 review M1: taint carried through workspace files to later Runs                                                                                                                         | M2   | M6                                                   | belongs with memory/feedback provenance                                                                                                                    |
| M2 review L3/L4: compare-and-set on resume/stop across processes; approval expiry set by the orchestrator; grants scoped to the next segment                                              | M2   | M3                                                   | orbitd becomes the single writer                                                                                                                           |
| M2 review L10/L11: secrets shorter than 6 chars are not redacted; `inputMatch` globs on rules                                                                                             | M2   | M7                                                   | no CLI path sets inputMatch yet                                                                                                                            |
