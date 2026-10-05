# Orbit handoff: M4 done, start M5

You are lead engineer on **Orbit** (repo `swissmarley/orbit`): a self-hostable platform of always-on, goal-driven AI agents ("Bots") built on Claude Code and the Claude Agent SDK. Before you change anything, read `CLAUDE.md`, `docs/PLAN.md` (status, milestones, §7 deferrals) and `docs/decisions/ADR-001…010`.

## State

- `main` and `claude/orbit-build` point at the same commit. M0–M4 are complete and safety-reviewed; M4 was also UI-reviewed.
- `pnpm check` passes with 1028 tests and 10 skipped. CI runs with `ORBIT_DRIVER=mock` and no credentials.
- Work on `claude/orbit-build`. Use Conventional Commits with the attribution lines. Fast-forward `main` when a milestone closes.

## Commands

```sh
pnpm install && pnpm check                       # Node >= 22.13, pnpm 10
pnpm test --project @orbit/tui                   # one package (project = package.json name)
ORBIT_DRIVER=mock ORBIT_HOME=$SCRATCH/o pnpm -s orbit doctor   # auto-starts orbitd on 127.0.0.1:7420
ORBIT_DRIVER=mock ORBIT_HOME=$SCRATCH/o pnpm -s orbit          # the TUI (needs a terminal; drive it via a pty in scripts)
ORBIT_HOME=$SCRATCH/o pnpm -s orbit daemon stop                # always stop daemons you start
pnpm --filter @orbit/api openapi                 # after contract changes
npx vitest run -u --project @orbit/tui           # after intended TUI layout changes (review the snapshot diff)
```

- Real-process tests and scripts set `ORBIT_PORT=0`, because another daemon may hold 7420.
- If you write a Python pty driver, never name the script `pty.py`: it shadows the stdlib `pty` module.

## Architecture (ADR-010)

- **orbitd (`apps/orbitd`)** is the single writer. It binds loopback only and authenticates with a 0600 bearer token in `$ORBIT_HOME/daemon.token`. It refuses hosted mode and non-loopback binds.
- **API (`packages/api`):**
  - `src/contract.ts` is one route/zod table. It drives Hono validation, `openapi.json` and the typed client.
  - `OrbitService` wires the orchestrator, `RunQueue`, `Scheduler`, `RateLimitManager`, approval expiry and the vault.
  - SSE lives at `/v1/events` and resumes with `Last-Event-ID`.
- **Clients (CLI, TUI, App)** use only `@orbit/sdk-client`, enforced by `tools/guards/thin-client.test.ts`. The CLI auto-starts the daemon.
- **TUI (`apps/orbit-tui/src/tui`):**
  - `model.ts` does pure key handling (`onKey`, `HELP`, `LEGEND`, `reconcile`), unit-tested.
  - `feed.ts` handles data and SSE and scrubs everything it receives.
  - `views.tsx` and `app.tsx` render.
  - Tests use `test/render.ts`, an in-memory terminal with size, `press` and `waitFor`, plus `test/tui-fixtures.ts`, a fake client.
- **Conventions to keep:**
  - Every `.tsx` file starts with `/** @jsxRuntime automatic @jsxImportSource react */`. tsx run from the repo root ignores the package tsconfig, and a test enforces the pragma.
  - Model-written text shown in a terminal goes through `scrubControls` / `clean` / `safeEvent`.
  - Use 16 basic colours only, and never colour alone.
  - Every CLI data command takes `--json`.

## User's hard security constraints (never relax)

- **Claude OAuth credentials:**
  - Never read, copy, store, log or forward them (`~/.claude/.credentials.json`, keychain, `CLAUDE_CODE_OAUTH_TOKEN`).
  - Never pass subscription tokens to the Agent SDK. Only the official `claude` binary touches them.
- **Child environments:**
  - CliDriver children have `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` deleted.
  - In API-key mode the key never reaches unrelated children.
  - Every child env is built from an allowlist. The `orbitd` profile is used when the CLI spawns the daemon.
- **CliDriver refusal:** it is refused, with a clear error explaining how to supply an API key instead, when the API binds to a non-loopback address, when more than one human principal is configured, or when `ORBIT_MODE=hosted`.
- **Runtime safety:**
  - Secrets are never in prompts, events or logs.
  - Tool, web and email content is untrusted.
  - EXTERNAL actions need approval; FINANCIAL actions are always handed back to the human.
  - Budgets and kill switches are enforced in runtime code.

## Verified vs not

- **Verified live in M1/M2 (haiku):** CliDriver end to end through the hook bridge, PostToolUse redaction, and `continue:false` parking.
- **Not verified live:**
  - SdkDriver (no API key in this environment).
  - The native engine sandbox (no bwrap or socat).
  - Docker plus SdkDriver.
  - `continue:false` from `PostToolUseFailure`.
- The container's `claude` login is near its **weekly usage limit**. Run live tests rarely, with haiku.

## Next: M5 — the App (see PLAN §3 M5 and §7)

1. **`apps/orbit-app`:** React 19 + Vite + Tailwind v4 + shadcn/ui + TanStack Query/Router, built on `@orbit/sdk-client`. It needs a browser-safe client entry: `client.ts` is fine, but `local.ts` uses `node:fs`, so split the exports.
2. **API access from the browser:** add an explicit Origin allowlist (CORS) to the API, which today refuses every request with an `Origin` header. Decide how the App gets the token, e.g. orbitd serves the App on the same origin and hands it a session cookie, or Tauri injects it. Record the decision in an ADR.
3. **Screens:**
   - Design tokens (light/dark) and Storybook.
   - App shell with an auth/driver header.
   - Inbox / Needs You (A/E/D, J/K). Approving from the App must go through the full card, as in the TUI.
   - Bots grid, Bot detail with a versioned config diff, and the Run view (virtualized live timeline, diffs, pause/resume/stop, replay scrubber).
   - Create Bot wizard, Cmd+K palette, Settings (doctor, models, policies, budgets, audit, theme), first-run onboarding.
4. **Quality:**
   - Optimistic UI, skeletons, toasts with undo, SSE auto-reconnect (the client already resumes).
   - Playwright e2e of the approval flow with the MockDriver, axe accessibility checks, and screenshots reviewed by `ui-polish-reviewer`.
5. **M4 deferrals targeted at M5:**
   - Select Bots by id in the TUI.
   - Use local and relative times everywhere, and share the status vocabulary between the TUI, CLI and App.
6. **Close the milestone** with `.claude/skills/milestone-gate`: `pnpm check`, the safety-reviewer and ui-polish-reviewer agents, PLAN and ADR updates, commit, push, fast-forward `main`, the report, and a new `docs/HANDOFF.md`.
