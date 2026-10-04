# CLAUDE.md — Orbit

Orbit is a self-hostable platform of always-on, goal-driven AI agents ("Bots")
on Claude Code / the Claude Agent SDK. One daemon (`orbitd`) exposes one typed
API; the web/desktop app (`orbit-app`) and the TUI/CLI (`orbit`) are thin
clients. The plan, milestones and status are in `docs/PLAN.md`; decisions are in
`docs/decisions/`.

## Commands

```sh
pnpm install            # Node >= 22.13, pnpm 10 (corepack)
pnpm check              # format:check + lint + typecheck + test — run before every commit
pnpm test               # vitest, all projects (no credentials needed)
pnpm test --project @orbit/core      # one package (project name = package.json name)
pnpm test:live          # opt-in: real engine via API key or logged-in `claude`
pnpm lint:fix && pnpm format
pnpm orbit doctor       # the CLI (in-process until M3); ORBIT_DRIVER=mock needs no credentials
ORBIT_DRIVER=mock pnpm orbit bot create --name Demo --goal 'Summarize notes' && pnpm orbit run demo
pnpm orbit approvals | approve <id> [--edit json] [--always] | deny <id> --reason …
pnpm orbit stop <run> | bot pause <bot> | kill [--off] | audit verify | secret set NAME < file
```

## Layout

- `packages/core` domain types, zod schemas, `RunEvent`, run projection, config,
  permission types, redaction
- `packages/store` SQLite (Drizzle): append-only events, run projections, bots
- `packages/runtime` orchestrator, scheduler, triggers, drivers (Sdk/Cli/Mock),
  AuthResolver, rate limits
- `packages/policy` tiers (ADR-009), PolicyEngine, rules, approval queue + grants,
  approval cards, hash-chained audit log, secrets vault
- `packages/sandbox` directory / git-worktree workspaces with Claude Code's native
  sandbox settings, Docker containers (API-key mode)
- `packages/memory` memory store, summarizer, feedback
- `packages/api` Hono REST + SSE + loopback MCP endpoint; `packages/sdk-client`
- `apps/orbitd` daemon composition root; `apps/orbit-tui` `orbit` bin;
  `apps/orbit-app` (M5); `plugins/*` (M7)
- `tools/guards` repo-wide security invariant tests

Dependency direction: `core` ← `store` ← `policy`, `memory`, `sandbox` ← `runtime` ←
`api` ← `apps/*`. Clients only talk to orbitd through `@orbit/sdk-client`.

## Conventions

- TypeScript strict (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
  ESM, internal packages consumed as source (`exports` → `src/index.ts`).
- zod schemas are the source of truth for types (`z.infer`) and OpenAPI.
- Every driver message becomes a `RunEvent` via the one shared normalizer
  (ADR-002). The `events` table is append-only; UI state is a projection.
- Conventional Commits (`feat(runtime): …`, `test(policy): …`, `docs: …`).
- No TODO stubs in shipped code paths; record deferrals in `docs/PLAN.md` §7.
- Deviations from the brief get an ADR in `docs/decisions/`.

## Security invariants (lint + `tools/guards` enforce them)

- Never read, copy, store, log or forward Claude OAuth credentials
  (`~/.claude/.credentials.json`, keychain, `CLAUDE_CODE_OAUTH_TOKEN`).
- Child processes get an env built from an allowlist — never spread
  `process.env`. CliDriver children never get `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN`; the API key never reaches unrelated children.
- CliDriver is local single-user only (loopback bind, one principal, not
  `ORBIT_MODE=hosted`).
- No hardcoded model IDs: use `ORBIT_DEFAULT_MODEL` / `ORBIT_TRIAGE_MODEL` or
  aliases (`opus`, `sonnet`, `haiku`).
- Default-deny tool policy; EXTERNAL actions need approval; FINANCIAL is
  always handed back to the human. Budgets are enforced in runtime code.

## Drivers (packages/runtime/src/drivers)

- `normalize.ts` is the only place engine messages become `RunEvent`s.
- `cli.ts` spawns `claude -p` (prompt on stdin); tool calls are decided by the
  PreToolUse hook → `hook-bridge.ts` (ADR-008). `sdk.ts` uses `query()` hooks.
- `mock.ts` replays `fixtures/claude-<version>/*.jsonl`; record new fixtures with
  `claude -p … --output-format stream-json --verbose` and scrub them with
  `scripts/scrub-fixture.ts` before committing.
- `test/driver-contract.ts` is the shared suite every driver must pass.

## Testing

- Tests sit next to code as `*.test.ts`; live tests are `*.live.test.ts`.
- CI uses `ORBIT_DRIVER=mock` and no credentials, ever.
- Tests first for policy, budgets, replay, AuthResolver, driver contract.
- New guards get a positive-control test that proves they fire.

## Project agents and skills

- `.claude/agents/safety-reviewer.md`: audit at every milestone gate.
- `.claude/agents/test-engineer.md`: tests-first for invariants.
- `.claude/agents/ui-polish-reviewer.md`: screenshot/a11y review (M4+).
- `.claude/skills/milestone-gate`: procedure to close a milestone.
