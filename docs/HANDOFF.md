# Orbit handoff: M5 done, start M6

You are lead engineer on **Orbit** (repo `swissmarley/orbit`): a self-hostable platform of always-on, goal-driven AI agents ("Bots") built on Claude Code and the Claude Agent SDK. Before you change anything, read `CLAUDE.md`, `docs/PLAN.md` (status, milestones, §7 deferrals) and `docs/decisions/ADR-001…011`.

## State

- `main` and `claude/orbit-build` point at the same commit. M0–M5 are complete; each passed a safety review, and M4 and M5 a UI review.
- `pnpm check` passes with 1132 tests and 10 skipped; `pnpm test:e2e` (Playwright against a real orbitd, mock driver) passes 12 tests. CI runs both with `ORBIT_DRIVER=mock` and no credentials.
- CI's lint job had been running out of memory since M3 (the container here has an 8 GB default heap, the runner about 2 GB). CI now sets `NODE_OPTIONS=--max-old-space-size=6144`; lint fits in 4 GB.
- Work on `claude/orbit-build`. Use Conventional Commits with the attribution lines. Fast-forward `main` when a milestone closes.

## Commands

```sh
pnpm install && pnpm check                       # Node >= 22.13, pnpm 10
pnpm test --project @orbit/app                   # one package (project = package.json name)
pnpm test:e2e                                    # builds the App, Playwright + axe (real orbitd, ORBIT_PORT=0, mock driver)
ORBIT_DRIVER=mock ORBIT_HOME=$SCRATCH/o pnpm -s orbit doctor   # auto-starts orbitd on 127.0.0.1:7420
pnpm --filter @orbit/app build && ORBIT_HOME=$SCRATCH/o pnpm -s orbit app --no-open   # the App, one-time sign-in link
pnpm --filter @orbit/app exec tsx scripts/screenshots.ts <dir> [1440,1024,768]           # every screen, both themes
ORBIT_HOME=$SCRATCH/o pnpm -s orbit daemon stop  # always stop daemons you start
pnpm --filter @orbit/api openapi                 # after contract changes
npx vitest run -u --project @orbit/tui           # after intended TUI layout changes (review the snapshot diff)
```

- Real-process tests and scripts set `ORBIT_PORT=0`; `apps/orbit-app/e2e/orbitd.ts` starts orbitd with an allowlisted env and always stops it.
- Never name a Python pty driver `pty.py` (it shadows the stdlib module).

## Architecture

- **orbitd** (ADR-010) is the single writer, loopback only, bearer token in `$ORBIT_HOME/daemon.token` (0600). It refuses hosted mode and non-loopback binds.
- **API** (`packages/api`): one route/zod table (`src/contract.ts`) drives Hono validation, `openapi.json` and the typed client. SSE at `/v1/events` with `Last-Event-ID`.
- **App access** (ADR-011):
  - orbitd serves `apps/orbit-app/dist` (or `ORBIT_APP_DIR`) on its own origin with a strict CSP.
  - `orbit app` mints a single-use, 2-minute ticket (bearer only) and opens `/login#ticket=…` through a 0600 redirect file, never on a command line.
  - `POST /v1/session` returns an HttpOnly, `SameSite=Strict`, per-port cookie **plus** a per-session CSRF secret. The App keeps the secret in its origin's storage and sends it as `X-Orbit-CSRF`. A cookie alone gets 401, because other loopback ports can see cookies.
  - Origins: orbitd's own, plus `ORBIT_ALLOWED_ORIGINS`, which accepts loopback and Tauri origins only. Doctor warns while it is set.
- **Clients** use only `@orbit/sdk-client`. The App uses only `@orbit/sdk-client/browser` and `@orbit/core/browser`; guards enforce both, and that the browser entries reach no Node built-ins.
- **Shared vocabulary**: `packages/core/src/vocabulary.ts` holds the run statuses and tiers (symbol + word + tone) and the local/relative times. The TUI, the CLI and the App all use it.
- **App** (`apps/orbit-app`, see its README): pure logic in `src/lib` (`inbox.ts` key model, `timeline.ts`, `diff.ts`, `wizard.ts`, `actions.ts`, `live.ts`), components, screens, stories. Component tests mount the App over the real API service in-process (`src/test/harness.tsx`).
- **TUI**: pure key model in `model.ts`; Bots and older Runs are selected by id. Every `.tsx` starts with the JSX pragma (a guard now enforces it).

## User's hard security constraints (never relax)

- **Claude OAuth credentials:** never read, copy, store, log or forward them (`~/.claude/.credentials.json`, keychain, `CLAUDE_CODE_OAUTH_TOKEN`). Never pass subscription tokens to the Agent SDK.
- **Child environments:**
  - CliDriver children never get `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`.
  - In API-key mode the key reaches only the SDK engine.
  - Every child env is built from an allowlist. The browser launcher gets the `tool` allowlist plus display variables.
- **CliDriver refusal:** refused, with a clear way to supply an API key, on a non-loopback bind, with more than one human principal, or with `ORBIT_MODE=hosted`.
- **Runtime safety:**
  - Secrets are never in prompts, events or logs.
  - Tool, web and email content is untrusted.
  - EXTERNAL actions need approval; FINANCIAL actions are always handed back.
  - Budgets and kill switches are enforced in runtime code.

## Verified vs not

- **Verified live (M1/M2, haiku):** CliDriver through the hook bridge, PostToolUse redaction, `continue:false` parking.
- **Not verified live:**
  - The SdkDriver (no API key here).
  - The native engine sandbox (no bwrap or socat).
  - Docker plus the SdkDriver.
  - `continue:false` from `PostToolUseFailure`.
  - The App against a real (non-mock) driver. The header's short auth label for the CLI and SDK drivers is unit-level only; re-capture screenshots once with a real driver.
- The container's `claude` login is near its weekly usage limit. Run live tests rarely, and only with haiku.

## Next: M6 — memory, feedback, teams (PLAN §3 M6 and §7)

1. **Memory store:** markdown plus SQLite FTS5, and Orbit MCP memory tools on the loopback `/mcp/orbit` endpoint (deferred from M3).
2. **Post-run summarizer** on the triage model (`ORBIT_TRIAGE_MODEL`), and feedback ingestion (thumbs, edits, approvals and denials) injected into future runs.
3. **Memory browser** in the App and the TUI: view, edit, delete.
4. **Subagents** (`agents` / `--agents`) and peer-Bot delegation (`delegate_to_bot` → child Run), with the live delegation tree in the App (the Run view already has a subagent tree) and the TUI.
5. **M5 deferrals due in M6:**
   - A Claude-written config proposal in the Create Bot wizard (on the triage path; never spend usage silently).
   - Taint carried through workspace files.
   - Live check of subagent tool calls under the CliDriver.
   - Audit rows as names and links.
   - Settings entries in the palette.
6. **Close the milestone** with `.claude/skills/milestone-gate`:
   - `pnpm check` and `pnpm test:e2e`.
   - The safety-reviewer and ui-polish-reviewer agents.
   - PLAN and ADR updates.
   - Commit, push, fast-forward `main`, write the report and a new `docs/HANDOFF.md`.
