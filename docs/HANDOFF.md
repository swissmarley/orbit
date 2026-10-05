# Orbit handoff: M6 done, start M7

You are lead engineer on **Orbit** (repo `swissmarley/orbit`): a self-hostable platform of always-on, goal-driven AI agents ("Bots") built on Claude Code and the Claude Agent SDK. Before you change anything, read `CLAUDE.md`, `docs/PLAN.md` (status, milestones, §7 deferrals) and `docs/decisions/ADR-001…013`.

## State

- `main` and `claude/orbit-build` point at the same commit. M0–M6 are complete; each passed a safety review, and M4–M6 a UI review.
- `pnpm check` passes with 1244 tests and 11 skipped; `pnpm test:e2e` (Playwright against a real orbitd, mock driver, axe in both themes) passes 14 tests. CI runs both with `ORBIT_DRIVER=mock` and no credentials.
- CI sets `NODE_OPTIONS=--max-old-space-size=6144` for lint (the runner has about 2 GB by default).
- Work on `claude/orbit-build`. Use Conventional Commits with the attribution lines. Fast-forward `main` when a milestone closes and CI is green.

## Commands

```sh
pnpm install && pnpm check                       # Node >= 22.13, pnpm 10
pnpm test --project @orbit/app                   # one package (project = package.json name)
pnpm test:e2e                                    # builds the App, Playwright + axe (real orbitd, ORBIT_PORT=0, mock driver)
ORBIT_DRIVER=mock ORBIT_HOME=$SCRATCH/o pnpm -s orbit doctor   # auto-starts orbitd on 127.0.0.1:7420
pnpm --filter @orbit/app build && ORBIT_HOME=$SCRATCH/o pnpm -s orbit app --no-open   # the App, one-time sign-in link
pnpm --filter @orbit/app exec tsx scripts/screenshots.ts <dir> [1440,1024,768]           # every screen, both themes
ORBIT_HOME=$SCRATCH/o pnpm -s orbit memory list|tree <run>|triage                        # M6 commands
ORBIT_HOME=$SCRATCH/o pnpm -s orbit daemon stop  # always stop daemons you start
pnpm --filter @orbit/api openapi                 # after contract changes
npx vitest run -u --project @orbit/tui           # after intended TUI layout changes (review the snapshot diff)
```

- Real-process tests and scripts set `ORBIT_PORT=0`; `apps/orbit-app/e2e/orbitd.ts` starts orbitd with an allowlisted env and always stops it.
- Never name a Python pty driver `pty.py` (it shadows the stdlib module).
- Mock fixtures live in `packages/runtime/fixtures/claude-<version>/`; `<name>-resumed.jsonl` is what the mock replays when a parked Run resumes (used by `delegate-to-peer`).

## Architecture

- **orbitd** (ADR-010) is the single writer, loopback only, bearer token in `$ORBIT_HOME/daemon.token` (0600). It refuses hosted mode and non-loopback binds.
- **API** (`packages/api`): one route/zod table (`src/contract.ts`) drives Hono validation, `openapi.json` and the typed client. SSE at `/v1/events` with `Last-Event-ID`. `OrbitService` (`src/service.ts`) owns the queue, scheduler, delegation, memory and the triage path.
- **App access** (ADR-011): HttpOnly per-port cookie from a one-time ticket plus a per-session CSRF secret sent as `X-Orbit-CSRF`; origins are orbitd's own plus loopback/Tauri `ORBIT_ALLOWED_ORIGINS`.
- **Memory** (ADR-012, `packages/memory`):
  - SQLite `memories` + FTS5 (`memories_fts`), mirrored as markdown under `$ORBIT_HOME/memory/<bot>/` (never read back). Redacted and control-stripped before storage; at most 1000 per Bot (Bot notes and summaries evicted first, untrusted first).
  - Provenance: `source` (owner, bot, summarizer, feedback), Run, `taint`. Only **trusted** memory is offered to new Runs, inside `<orbit-memory>` tags, with the first prompt on stdin. Reading untrusted memory taints the Run. Only the owner clears taint (audited).
  - Workspace-file taint (`workspace_taint`, canonical paths): tainted writes mark files, reads of marked files taint the reader at permission time, uncontained or tainted shells mark the whole workspace.
  - **TriagePath** (`packages/runtime/src/triage.ts`): every summary/proposal call is capped per day (`triage.maxCallsPerDay`, default 20), refused under the kill switch or a usage-limit hold, serialized, recorded in `triage_calls`, shown in Settings → Budgets, `orbit triage`, the timeline and the wizard.
- **Orbit tools and delegation** (ADR-013, `packages/runtime/src/orbit-tools`):
  - One `OrbitToolset` (`memory_search`, `memory_read`, `memory_write`, `delegate_to_bot`): CLI over `POST /mcp/orbit` (per-segment 256-bit token in a 0600 `--mcp-config` file; Origin refused; outside the client contract), SDK over an in-process server, mock directly.
  - A tool call runs only if it consumes an authorization the PreToolUse decision recorded for exactly that tool and canonical input.
  - Delegation is park-and-resume: the parent parks as `delegating`, the child gets `inheritedTaint` and a `budgetCap` (half of what is left after unfinished children's reserved caps), stop/pause/kill carry to descendants, answers come back in `<orbit-delegation>` tags as untrusted data and taint the parent. `GET /v1/runs/{run}/tree` drives the App's live tree and the TUI's `t`.
  - Subagents: `BotSpec.subagents` → `--agents` / `agents`; tools ⊆ the Bot's.
- **Clients** use only `@orbit/sdk-client`; the App only the `/browser` entries (guarded). Shared vocabulary in `packages/core/src/vocabulary.ts` (statuses incl. `delegating`, tiers, memory trust, `formatCost`, local times).
- **App** pure logic in `src/lib` (`inbox.ts`, `memory-list.ts`, `timeline.ts`, `delegation.ts`, `audit.ts`, `actions.ts`, `live.ts`); **TUI** pure key model in `src/tui/model.ts` (memory browser and editor overlays, tree overlay).

## User's hard security constraints (never relax)

- **Claude OAuth credentials:** never read, copy, store, log or forward them (`~/.claude/.credentials.json`, keychain, `CLAUDE_CODE_OAUTH_TOKEN`). Never pass subscription tokens to the Agent SDK.
- **Child environments:**
  - CliDriver children never get `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`.
  - In API-key mode the key reaches only the SDK engine.
  - Every child env is built from an allowlist — including MCP servers, summarizer/triage calls and plugin processes.
- **CliDriver refusal:** refused, with a clear way to supply an API key, on a non-loopback bind, with more than one human principal, or with `ORBIT_MODE=hosted`.
- **Runtime safety:**
  - Secrets are never in prompts, events, logs or memory.
  - Tool, web and email content is untrusted, and so are memory written from it and delegated output.
  - EXTERNAL actions need approval, including through delegation; FINANCIAL actions are always handed back.
  - Budgets and kill switches are enforced in runtime code.

## Verified vs not

- **Verified live (haiku, Claude Code 2.1.289):** CliDriver through the hook bridge, PostToolUse redaction, `continue:false` parking (M1/M2); a subagent's tool call decided by the hook with its `parent_tool_use_id`, and the CLI engine calling `mcp__orbit__memory_write` over `/mcp/orbit` with its segment token (M6, `packages/api/src/m6.live.test.ts`).
- **Not verified live:**
  - The SdkDriver, including its in-process Orbit MCP server (no API key here).
  - The native engine sandbox (no bwrap or socat), Docker plus the SdkDriver.
  - `continue:false` from `PostToolUseFailure`.
  - The App against a real (non-mock) driver; re-capture screenshots once with one.
- Observed live: the engine can run an `Agent` subagent in the background, so `subagent.stopped` arrives at launch (PLAN §7, M7).
- The container's `claude` login is near its weekly usage limit. Run live tests rarely, and only with haiku.

## Next: M7 — plugins, MCP registry, Slack (PLAN §3 M7 and §7)

1. **Plugin manifest** (zod schema: tools with fixed tiers, required secrets, child env allowlist, MCP server command/transport) and a registry/loader. Plugin MCP servers are child processes: allowlisted env, secrets from the vault only by name, never the API key or OAuth credentials; plugin tool tiers cannot override Orbit's own (`ORBIT_TOOL_TIERS`).
2. **Five reference plugins:** GitHub (also takes over git commits from worktree Bots, M2 deferral), Slack, Gmail/Calendar, Filesystem, Browser/Playwright.
3. **Slack trigger** (Socket Mode, no public URL); webhook triggers (HMAC) and file/git triggers (chokidar), deferred from M3.
4. **Demo Bot "Inbox Triage"**: scheduled, drafts replies, requests approval to send.
5. **Settings → Integrations** in the App (deferred from M5) and the matching CLI/TUI views.
6. **Deferrals due in M7:**
   - Async (background) subagents: model the task-notification messages in the normalizer so the subagent tree tracks completion.
   - Daily budgets of a delegating Bot counting its children's spend.
   - M2 review L10/L11: short-secret redaction and `inputMatch` globs on rules.
   - Content polish: memory summary titles in local time, feedback text naming the Run by label.
   - App: Esc in the approval card's edit textarea, Ctrl+K / `?` over modals.
7. **Close the milestone** with `.claude/skills/milestone-gate`:
   - `pnpm check` and `pnpm test:e2e`.
   - The safety-reviewer and ui-polish-reviewer agents (screenshots from `apps/orbit-app/scripts/screenshots.ts`).
   - PLAN and ADR updates.
   - Commit, push, fast-forward `main` when CI is green, write the report and a new `docs/HANDOFF.md`.
