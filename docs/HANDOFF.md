# Orbit handoff: M7 done, start M8

You are lead engineer on **Orbit** (repo `swissmarley/orbit`): a self-hostable platform of always-on, goal-driven AI agents ("Bots") built on Claude Code and the Claude Agent SDK. Before you change anything, read `CLAUDE.md`, `docs/PLAN.md` (status, milestones, §7 deferrals) and `docs/decisions/ADR-001…014`.

## State

- `main` and `claude/orbit-build` point at the same commit. M0–M7 are complete; each passed a safety review, and M4–M7 a UI review.
- `pnpm check` passes with 1443 tests and 12 skipped; `pnpm test:e2e` (Playwright against a real orbitd, mock driver, axe in both themes) passes 16 tests. CI runs both with `ORBIT_DRIVER=mock` and no credentials, plus the Browser plugin's Chromium tests in the e2e job.
- CI sets `NODE_OPTIONS=--max-old-space-size=6144`; `pnpm lint` runs ESLint in three processes (packages+tools, apps, plugins) to fit. Before the Browser plugin tests CI runs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` so Chromium keeps its sandbox on Ubuntu 24.
- Work on `claude/orbit-build`. Use Conventional Commits with the attribution lines. Fast-forward `main` when a milestone closes and CI is green.

## Commands

```sh
pnpm install && pnpm check                       # Node >= 22.13, pnpm 10
pnpm test --project @orbit/plugin-github         # one package (project = package.json name)
pnpm test:e2e                                    # builds the App, Playwright + axe (real orbitd, ORBIT_PORT=0, mock driver)
ORBIT_DRIVER=mock ORBIT_HOME=$SCRATCH/o pnpm -s orbit doctor   # auto-starts orbitd on 127.0.0.1:7420
ORBIT_HOME=$SCRATCH/o pnpm -s orbit plugins | plugin show|enable|check <id> | plugin secret <id> NAME < file
ORBIT_HOME=$SCRATCH/o pnpm -s orbit templates && pnpm -s orbit bot create --template inbox-triage
ORBIT_HOME=$SCRATCH/o pnpm -s orbit triggers | trigger webhook-secret <bot> <name> [--rotate]
pnpm --filter @orbit/app build && ORBIT_HOME=$SCRATCH/o pnpm -s orbit app --no-open   # the App, one-time sign-in link
pnpm --filter @orbit/app exec tsx scripts/screenshots.ts <dir> [1440,1024,768]           # every screen, both themes
ORBIT_HOME=$SCRATCH/o pnpm -s orbit daemon stop  # always stop daemons you start
pnpm --filter @orbit/api openapi                 # after contract changes
npx vitest run -u --project @orbit/tui           # after intended TUI layout changes (review the snapshot diff)
```

- Real-process tests and scripts set `ORBIT_PORT=0`; `apps/orbit-app/e2e/orbitd.ts` starts orbitd with an allowlisted env and always stops it.
- Never name a Python pty driver `pty.py` (it shadows the stdlib module).
- Mock fixtures live in `packages/runtime/fixtures/claude-<version>/`; `<name>-resumed.jsonl` is replayed when a parked Run resumes (`delegate-to-peer`, `inbox-triage`). Enabled plugins run for real under the mock driver; unenabled ones replay the recording (demo mode).

## Architecture

- **orbitd** (ADR-010) is the single writer, loopback only, bearer token in `$ORBIT_HOME/daemon.token` (0600). It refuses hosted mode and non-loopback binds.
- **API** (`packages/api`): one route/zod table (`src/contract.ts`) drives Hono validation, `openapi.json` and the typed client. SSE at `/v1/events`. `OrbitService` owns the queue, scheduler, triggers, plugins, delegation, memory and the triage path. Non-client routes: `/mcp/orbit`, `/mcp/plugins/<id>` (per-segment tokens) and `/hooks/<bot>/<trigger>` (HMAC only).
- **App access** (ADR-011): HttpOnly per-port cookie from a one-time ticket plus a CSRF header.
- **Memory** (ADR-012), **Orbit tools and delegation** (ADR-013): unchanged from M6; see CLAUDE.md.
- **Plugins** (ADR-014, `packages/runtime/src/plugins`, `plugins/*`):
  - `PluginManifest` (`@orbit/core`): tools with fixed tiers (+ `egress`), secrets by name (`scope: "orbit"` for ones only orbitd uses), owner settings, env allowlist, stdio or http server. Credential and loader variable names are refused.
  - `PluginRegistry`: reference plugins plus owner-added folders (not inside `$ORBIT_HOME`); off until enabled; enabling runs a check and pins the manifest hash; undeclared tools hidden; the engine sees manifest descriptions.
  - `PluginSegment`: one server per plugin per Run segment, started lazily in the Bot's workspace with `buildPluginEnv` (allowlist, env names, settings, its own secrets, `ORBIT_WORKSPACE`, `ORBIT_GIT_REPO`/`ORBIT_GIT_BRANCH` for worktree Bots, `ORBIT_DENIED_PATHS`). A call runs only after Orbit's PreToolUse decision authorized exactly that input.
  - Tiers: exact-name overrides after `ORBIT_TOOL_TIERS`, raised to `tierFloor` (money → FINANCIAL; send/write/create/run/click → EXTERNAL; drafts/commit → WRITE_LOCAL).
  - Reference plugins: GitHub (REST + git with explicit `GIT_DIR` from Orbit; `git_push` names branch and sha), Slack, Gmail & Calendar (`send_draft` names recipients and subject), Filesystem (deny list + hidden paths), Browser (Chromium behind a domain-filtering proxy).
- **Inbound triggers** (`packages/runtime/src/triggers`, `TriggerRouter`): webhooks (constant-time HMAC before parsing; Orbit style with timestamp, GitHub style once per delivery id and per body), Slack Socket Mode (outbound `wss`; `users` required on the subscription engine), file and git watchers (chokidar; git with forced safe config, never inside `$ORBIT_HOME`). Content arrives in `<orbit-untrusted>` tags and the Run starts tainted.
- **Templates**: `BOT_TEMPLATES` in `@orbit/core` (Inbox Triage), used by the CLI and the wizard.
- **Clients** use only `@orbit/sdk-client` (`plugins`, `triggers` namespaces added); App Settings → Integrations (`src/screens/integrations.tsx`); TUI `i` overlay.

## User's hard security constraints (never relax)

- **Claude OAuth credentials:** never read, copy, store, log or forward them (`~/.claude/.credentials.json`, keychain, `CLAUDE_CODE_OAUTH_TOKEN`). Never pass subscription tokens to the Agent SDK.
- **Child environments:**
  - CliDriver children never get `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`.
  - In API-key mode the key reaches only the SDK engine.
  - Every child env is built from an allowlist — every plugin MCP server, trigger listener and browser process included. Plugin secrets come from the vault by name and reach only the plugin that declared them.
- **CliDriver refusal:** refused, with a clear way to supply an API key, on a non-loopback bind, with more than one human principal, or with `ORBIT_MODE=hosted`.
- **Runtime safety:**
  - Secrets are never in prompts, events, logs or memory.
  - Tool, web, email and Slack content, webhook payloads, memory written from them and delegated output are untrusted.
  - EXTERNAL actions need approval, including through delegation or a plugin (sending email or Slack messages, pushing to GitHub); FINANCIAL actions are always handed back.
  - Budgets and kill switches are enforced in runtime code.
- **Inbound triggers:** webhooks verify an HMAC (constant time) before anything is parsed or stored; orbitd stays loopback-only; Slack uses Socket Mode.

## Verified vs not

- **Verified live (haiku, Claude Code 2.1.289):** CliDriver through the hook bridge, PostToolUse redaction, `continue:false` parking (M1/M2); subagent tool calls and `/mcp/orbit` (M6); the CLI engine calling the Filesystem plugin's `read_file` through `/mcp/plugins/filesystem` with Orbit's authorization (M7, `packages/api/src/m7.live.test.ts`).
- **Not verified live:**
  - The SdkDriver, its in-process Orbit and plugin MCP servers (no API key here).
  - GitHub, Slack and Google plugins against real accounts (tests use local fakes).
  - The native engine sandbox (no bwrap or socat), Docker plus the SdkDriver.
  - The App against a real (non-mock) driver.
- The container's `claude` login is near its weekly usage limit. Run live tests rarely, and only with haiku.

## Next: M8 — hardening and packaging (PLAN §3 M8 and §7)

1. **Test corpus:** budgets, kill switches and prompt injection (including through plugins, webhooks, Slack and delegation); a load test (N concurrent mock Runs, SSE fan-out).
2. **Docs:** README with a diagram, quickstart for both auth modes, compliance note (subscription vs API key, who may start Runs), security model, screenshots.
3. **Packaging:** `docker compose up` (orbitd + App, API-key mode), Tauri build (ADR-011 already allows its origin), npm bin / packaged `orbitd`, release workflow.
4. **Deferrals due in M8** (§7), among them:
   - Docker mode: key-injecting proxy, egress allowlist, recreate containers on limit/image changes.
   - Hosted mode: OIDC, TLS, non-loopback bind (and webhooks without a tunnel).
   - Keyed audit chain or exported checkpoints.
   - Plugin processes in an OS sandbox; Browser plugin DNS checks; a remote plugin catalog.
   - Retry of interrupted Runs, per-Run pause, TUI mouse, dynamic completion, memory export/import.
5. **Close the milestone** with `.claude/skills/milestone-gate`: `pnpm check`, `pnpm test:e2e`, the safety-reviewer and ui-polish-reviewer agents, PLAN and ADR updates, commit, push, fast-forward `main` when CI is green, the report and a new `docs/HANDOFF.md`.
