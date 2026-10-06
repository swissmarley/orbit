# Orbit handoff: M8 done (Orbit 0.1)

You are lead engineer on **Orbit** (repo `swissmarley/orbit`): a self-hostable platform of always-on, goal-driven AI agents ("Bots") built on Claude Code and the Claude Agent SDK. Before you change anything, read `CLAUDE.md`, `docs/PLAN.md` (status, milestones, §7 deferrals), `docs/decisions/ADR-001…019`, and the user-facing docs (`README.md`, `docs/quickstart.md`, `docs/security.md`, `docs/compliance.md`, `docs/architecture.md`).

## State

- `main` and `claude/orbit-build` point at the same commit. M0–M8 are complete; each passed a safety review, and M4–M8 a UI review. The engineering plan's milestones are done; what remains is in PLAN §7.
- `pnpm check` passes (format, lint, typecheck, 3252 tests); `pnpm test:e2e` passes 16 Playwright tests (real orbitd, mock driver, axe in both themes). CI (`.github/workflows/ci.yml`) runs four jobs with `ORBIT_DRIVER=mock` and no credentials: check (with bubblewrap installed, so the real plugin-sandbox tests run), app e2e (plus the Browser plugin's Chromium tests and Chromium inside bwrap), package (`pnpm smoke`), docker (build, `compose up`, the CLI in the container).
- CI sets `NODE_OPTIONS=--max-old-space-size=6144`; `pnpm lint` runs ESLint in three processes. Ubuntu 24 runners need `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` for bwrap and Chromium's sandbox (the workflow does it).
- `release.yml` (on `v*` tags; workflow_dispatch is a dry run) publishes `orbit-bots` to npm only when an `NPM_TOKEN` secret exists, pushes `ghcr.io/swissmarley/orbit`, builds desktop bundles through `desktop.yml` and creates the GitHub Release. Nothing has been tagged yet.
- Work on `claude/orbit-build`. Conventional Commits with the attribution lines. Fast-forward `main` when CI is green.

## Commands

```sh
pnpm install && pnpm check                       # Node >= 22.13, pnpm 10
pnpm test --project @orbit/api                   # one package (project = package.json name)
pnpm test:e2e                                    # builds the App, Playwright + axe
pnpm load-test --runs 200 --clients 50           # N concurrent mock Runs, M SSE subscribers
pnpm package && pnpm smoke                       # orbit-bots: bundle, pack, install, drive it
docker compose up -d && docker compose exec orbitd orbit app --no-open
ORBIT_DRIVER=mock ORBIT_HOME=$SCRATCH/o ORBIT_PORT=7531 pnpm -s orbit doctor
pnpm --filter @orbit/app exec tsx scripts/screenshots.ts <dir> [1440,1024,768]
pnpm --filter @orbit/api openapi                 # after contract changes
npx vitest run -u --project @orbit/tui           # after intended TUI layout changes
set -o pipefail; pnpm typecheck | tail           # never pipe typecheck without pipefail
```

- Real-process tests and scripts set `ORBIT_PORT=0` (or a free port) and a scratch `ORBIT_HOME`; always stop daemons you start.
- Agent worktrees live in `.claude/worktrees/` (ignored by git, Prettier, ESLint, Vitest and the security guard).

## What M8 added (details in PLAN §3 M8 and the ADRs)

- **Security corpus** (`packages/api/test/corpus`): 38 payloads × ten injection channels, budgets in every dimension, kill switches × Run states; it found and fixed six real bugs. **Load test** (`apps/orbitd/scripts/load-test.ts`).
- **Hosted mode** (ADR-015): OIDC sign-in (PKCE, `jose`), TLS in orbitd or behind a local proxy, roles (`viewer`/`operator`/`owner`) on every contract route (`roles.test.ts`), actors from the request's principal; container bind for Compose.
- **Keys never in a child process** (ADR-018 + amendment): host SDK engines use orbitd's loopback `HostKeyProxy` (per-segment token); Docker engines a Unix-socket key proxy with `--network none` and a DNS-checked egress allowlist proxy; Bedrock/Vertex are the only credentials that reach an engine (Linux then needs bwrap). orbitd keeps the key out of its own environment too (`ORBIT_API_KEY_FILE`, stdin hand-over from the CLI, a re-exec without the variable); key files are denied to Bots, the engine sandbox and plugins.
- **Plugins** (ADR-019): OS sandbox (bwrap / sandbox-exec) from the manifest's `sandbox` section; Browser DNS checks; catalog/npm installs with SRI and a strict extractor.
- **Run controls** (ADR-016): per-Run pause, safe automatic retry of interrupted Runs, `orbit shell` take-over.
- **Audit and memory**: keyed audit chain with signed checkpoints; memory export/import and retention.
- **Clients**: roles in the App, TUI mouse, dynamic completion, pause/take-over everywhere.
- **Packaging** (ADR-017): npm `orbit-bots`, Docker image + Compose, Tauri desktop shell, release workflow.
- **Docs**: README (diagram, screenshots), quickstart, compliance note, security model, architecture.
- **Reviews**: the safety review found no CRITICAL/HIGH; its four MEDIUM findings (plugin git hooks, the take-over shell over a Bot-written `.git`, the key in orbitd's environment, the npm token in the release job) and eleven LOW ones are fixed, and a re-review confirmed them. The UI review's 21 findings (incl. role gating in the App and the TUI pause banner) are fixed.

## User's hard security constraints (never relax)

- **Claude OAuth credentials:** never read, copy, store, log or forward them (`~/.claude/.credentials.json`, keychain, `CLAUDE_CODE_OAUTH_TOKEN`). Never pass subscription tokens to the Agent SDK.
- **Child environments:** every child env is built from an allowlist. CliDriver children never get `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`. An API key or apiKeyHelper output never enters any child process (key proxies); only Bedrock/Vertex credentials reach an engine. Plugin secrets reach only the plugin that declared them.
- **CliDriver refusal:** refused, with a clear way to supply an API key, on a non-loopback bind (including a container bind), with more than one human principal, or in hosted mode.
- **Runtime safety:** secrets never in prompts, events, logs or memory; tool/web/email/Slack/webhook/plugin/delegated content is untrusted (taint, `neutraliseTags`); EXTERNAL actions need approval; FINANCIAL is always handed back; budgets and kill switches are enforced in runtime code.
- **Network:** orbitd binds loopback, `0.0.0.0` only inside a container (published to host loopback), off-loopback only in hosted mode with TLS + OIDC. Webhooks verify an HMAC in constant time before parsing. Slack uses Socket Mode.

## Verified vs not

- **Verified live (haiku, Claude Code 2.1.289):** CliDriver through the hook bridge, PostToolUse redaction, `continue:false` parking, subagent tool calls, `/mcp/orbit`, the Filesystem plugin through `/mcp/plugins`.
- **Verified against the real engine binary, without the real API** (stand-in upstreams on loopback): the SDK engine behind the host key proxy (placeholder key, base-URL path token kept), the engine inside a `--network none` Docker container behind the socket proxies, the bubblewrap requirement of `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`.
- **Verified in CI:** the Docker image build and Compose deployment, the npm package install, the plugin sandbox with real bwrap, Chromium inside bwrap.
- **Not verified:**
  - The SdkDriver against the real API (no API key here), its in-process MCP servers, Bedrock/Vertex.
  - GitHub, Slack and Google plugins against real accounts.
  - The native engine sandbox (socat missing), the macOS plugin sandbox profile, desktop bundles on macOS/Windows, npm installs from the real registry (the catalog is empty).
- The container's `claude` login is near its weekly usage limit; run live tests rarely, and only with haiku.

## Next

PLAN §7 lists what remains. The most valuable next steps:

1. **Live verification with an API key**: `pnpm test:live` (SdkDriver, host key proxy, Docker sandbox, SDK MCP servers), then record results in PLAN.
2. **Tag `v0.1.0`** once the owner has set `NPM_TOKEN` (and decided on desktop signing): the release workflow does the rest.
3. **Post-0.1 items** from §7: remote CLI for hosted mode (personal access tokens), proxy metering of engine-children API calls, `HTTPS_PROXY` chaining in the key proxies, narrower git access for the GitHub plugin's sandbox, signed desktop bundles.
