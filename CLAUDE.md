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
pnpm orbit doctor       # the CLI auto-starts orbitd (loopback); ORBIT_DRIVER=mock needs no credentials
ORBIT_DRIVER=mock pnpm orbit bot create --name Demo --goal 'Summarize notes' && pnpm orbit run demo
pnpm orbit approvals | approve <id> [--edit json] [--always] | deny <id> --reason …
pnpm orbit stop <run> | bot pause <bot> | kill [--off] | audit verify | secret set NAME < file
pnpm orbit daemon start|stop|status|restart | queue | schedules | bot create … --cron '0 9 * * 1-5'
pnpm orbit              # in a terminal: the full-screen TUI (also `orbit tui`; ? shows the keys)
pnpm orbit tail <run> | bot run|logs <bot> | completion bash|zsh|fish
pnpm orbit run <bot> --continue <run> --prompt …   # answer an ended turn: the next message of its conversation (ADR-020)
pnpm orbit memory list|show|add|edit|rm … | feedback <run> up|down | tree <run> | triage
pnpm orbit plugins | plugin show|enable|disable|check|add|rm <id> | plugin secret <id> NAME < file
pnpm orbit plugin setting <id> NAME value | triggers | trigger webhook-secret <bot> <name>
pnpm orbit templates | bot create --template inbox-triage | rules add … --match 'to=*@example.com'
pnpm orbitd             # the daemon in the foreground (log otherwise: $ORBIT_HOME/logs/orbitd.log)
pnpm --filter @orbit/api openapi   # regenerate packages/api/openapi.json after contract changes
pnpm --filter @orbit/app build && pnpm orbit app   # the App, served by orbitd; one-time sign-in link (ADR-011)
pnpm test:e2e           # build the App, Playwright against a real orbitd (mock driver) + axe, both themes
pnpm --filter @orbit/app dev | storybook   # Vite dev server (needs ORBIT_ALLOWED_ORIGINS, see its README) / Storybook
pnpm orbit pause <run> [--now] | shell <bot> | tui --mouse
pnpm orbit audit verify [--checkpoint f] | audit checkpoint [--out f]
pnpm orbit memory export [--bot b] [--out f] | memory import <bot> <file> [--untrusted] [--yes] | memory sweep
pnpm orbit plugin catalog | plugin install <id> | npm:<pkg>@<ver> --integrity sha512-… [--dry-run] [--yes]
pnpm load-test [--runs 200] [--clients 50] [--json]   # N concurrent mock Runs, M SSE subscribers, lossless resume
pnpm package && pnpm smoke                 # build orbit-bots into packaging/npm/dist; pack, install, drive it (mock, ORBIT_PORT=0)
docker compose up -d && docker compose exec orbitd orbit app --no-open   # API-key mode, host loopback only
pnpm --filter @orbit/desktop build         # Tauri shell (Rust; WebKitGTK on Linux)
```

## Layout

- `packages/core` domain types, zod schemas, `RunEvent`, run projection, config,
  permission types, redaction, the shared status/tier vocabulary and local
  times (`vocabulary.ts`), Bot avatars (`avatar.ts`), the trigger prompt's
  untrusted block (`untrusted.ts`); `@orbit/core/browser` is the Node-free
  subset
- `packages/store` SQLite (Drizzle): append-only events, run projections, bots
- `packages/runtime` orchestrator, scheduler, drivers (Sdk/Cli/Mock),
  AuthResolver, rate limits, Orbit's MCP tools (`src/orbit-tools`: toolset,
  per-segment sessions, the minimal MCP server), the triage path
  (`src/triage.ts`) (ADR-013), plugins (`src/plugins`: manifest loader,
  allowlisted plugin env, minimal MCP client, `PluginRegistry`, per-segment
  `PluginSegment`, OS sandbox in `sandbox.ts`, catalog installs in
  `installer.ts` and `store.ts`) and inbound triggers (`src/triggers`: webhook HMAC, Slack
  Socket Mode, file/git watchers, `TriggerRouter`) (ADR-014)
- `packages/policy` tiers (ADR-009), PolicyEngine, rules, approval queue + grants,
  approval cards, hash-chained audit log with per-record MACs and signed
  checkpoints (`keys.ts`: audit and vault keys), secrets vault
- `packages/sandbox` directory / git-worktree workspaces with Claude Code's native
  sandbox settings, Docker containers (API-key mode) with host-side proxies
  (`src/proxy`: key-injecting API proxy, egress allowlist proxy, address
  classes, key sources, `ProxyHost`, `host-key-proxy.ts` for host engines),
  plugin OS sandbox (`plugin-sandbox.ts`:
  bwrap args, Seatbelt profiles), the read-only workspace reader behind the
  Bot's computer (`workspace-files.ts`)
- `packages/memory` memory store (SQLite FTS5 + markdown mirror under
  `$ORBIT_HOME/memory`), provenance/taint helpers, workspace-file taint,
  context and feedback text, summarizer prompts, triage-call ledger (ADR-012),
  JSONL export/import and retention (`portable.ts`)
- `packages/api` Hono REST + SSE (`src/app.ts`) plus the engines' `/mcp/orbit`
  endpoint (not a client route), the route/zod contract (`src/contract.ts`,
  also `@orbit/api/contract`), OpenAPI, and `OrbitService` (queue, scheduler,
  rate limits, approval expiry, delegation, memory, feedback, summaries,
  conversations, the Bot's computer)
- `packages/sdk-client` typed client (validated responses), SSE reconnect with
  Last-Event-ID, local discovery (`$ORBIT_HOME/daemon.json` + `daemon.token`);
  `@orbit/sdk-client/browser` is the client without discovery (no `node:fs`)
- `apps/orbitd` daemon composition root (single writer, loopback only, token
  auth); `apps/orbit-tui` `orbit` bin (thin client): commands in
  `src/commands`, the Ink TUI in `src/tui` (`model.ts` pure key handling,
  `feed.ts` data over the client, `views.tsx`, `app.tsx`, `layout.ts` geometry
  shared by views and the mouse hit test, `mouse.ts` SGR parser,
  `terminal-mouse.ts`); `apps/orbit-app` the
  web App (React 19, Vite, Tailwind v4, Radix/shadcn-style `components/ui`,
  TanStack Router/Query): pure logic in `src/lib` (`conversation.ts` chat
  turns from Run events, `markdown.ts` the message subset, `avatar.ts`,
  `chat-keys.ts` and `inbox.ts` key models, `timeline.ts`, `diff.ts`, `wizard.ts`, `actions.ts`
  writes with toasts/Undo, `live.ts` SSE feed, `ui.ts` small stores),
  `src/components` (`shell.tsx` sidebar, `chat.tsx` messages and tool cards,
  `computer-panel.tsx`, `avatar.tsx`), `src/screens` (`chat.tsx` the home,
  Settings → Integrations in `integrations.tsx`), stories in `src/stories`,
  Playwright in `e2e/`
- `packaging/npm` the public `orbit-bots` package (esbuild bundles, bundle
  guard, smoke test); `apps/orbit-desktop` Tauri 2 shell (Rust in
  `src-tauri`, loads the App from orbitd via `orbit app --json`);
  `docker/orbitd.Dockerfile` + `compose.yaml`; workflows `ci.yml`
  (check, e2e, package, docker), `release.yml`, `desktop.yml`
- `plugins/*` reference plugins (each `orbit-plugin.json` + `src/server.ts` +
  `src/tools.ts`): `kit` (the stdio MCP server helper), `github`, `slack`,
  `google`, `filesystem`, `browser`; `tools/guards/plugins.test.ts` checks every
  manifest against its server
- `tools/guards` repo-wide security invariant tests
- `packages/api/test/corpus` the M8 security corpus (payloads × channels,
  budgets, kill switches); `@orbit/api/corpus` shares the payloads (test only);
  `apps/orbitd/scripts/load-test.ts` the load test

Dependency direction: `core` ← `store` ← `policy`, `memory`, `sandbox` ← `runtime` ←
`api` ← `apps/*`. Clients only talk to orbitd through `@orbit/sdk-client`.
Plugins depend on `@orbit/plugin-kit` only (they run as separate processes).

## Conventions

- TypeScript strict (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
  ESM, internal packages consumed as source (`exports` → `src/index.ts`).
- zod schemas are the source of truth for types (`z.infer`) and OpenAPI.
- Every driver message becomes a `RunEvent` via the one shared normalizer
  (ADR-002). The `events` table is append-only; UI state is a projection.
- orbitd is the single writer (ADR-010). Clients use `@orbit/sdk-client` only
  (guarded by `tools/guards/thin-client.test.ts`); a new route goes into the
  contract table first, then its handler, then `openapi.json`.
- State transitions that can race (start, resume, stop) append with
  compare-and-set (`EventStore.append(…, { expectSeq })`).
- Statuses, tiers and times shown to people come from `@orbit/core`
  (`RUN_STATUS`, `TIER_WORD`, `formatWhen`, …): one vocabulary for TUI, CLI and
  App, always a symbol or word with the colour, always local time.
- App: imports only `@orbit/core/browser` and `@orbit/sdk-client/browser`
  (guarded); never holds the bearer token (HttpOnly session cookie + CSRF
  header, ADR-011); approvals are decided only from the full card; key
  bindings live in pure, unit-tested models (`src/lib/inbox.ts`,
  `chat-keys.ts`); a trigger's delivered content is shown as untrusted data,
  never as the owner's message (`splitTriggerPrompt`); model text
  goes through `scrubControls` and is rendered as text, never as HTML (chat
  messages: the `markdown.ts` subset as elements; links shown, not followed).
- Conversations (ADR-020): a message is a Run that `continues` the latest,
  ended, top-level turn of the same Bot (no forks); it resumes the newest
  engine session in the chain and inherits that turn's taint; budgets stay
  per Run. Bot avatars are `{ character, color }` from the fixed vocabulary in
  `@orbit/core` (`avatarFor` derives the default), drawn as inline SVG; never
  an image, URL or upload.
- The Bot's computer (ADR-020) is read-only GET routes over the workspace and
  Run events: relative paths only, never through a symlink nor by name again
  once a folder on the path is open (Linux `/proc/self/fd/<dir>/<name>` +
  `O_NOFOLLOW`, macOS `O_NOFOLLOW_ANY`, refused elsewhere), no hard-linked
  files, `.git` hidden, previews capped and redacted, untrusted files flagged;
  files need an operator. The App never gets a shell or browser control;
  take-over stays `orbit shell`.
- TUI: bindings live in `model.ts` (`onKey`, `HELP`) and are unit-tested
  there; views only render. 16 basic colors only, never colour alone (a
  symbol or word too). Every `.tsx` file starts with
  `/** @jsxRuntime automatic @jsxImportSource react */` (tsx run from the repo
  root ignores the package tsconfig; a test enforces it).
- Every CLI command that prints data takes `--json` (a test walks the
  command tree); model-written text shown in a terminal goes through
  `clean()`.
- Conventional Commits (`feat(runtime): …`, `test(policy): …`, `docs: …`).
- Memory (ADR-012): every memory carries `source` and `taint`; only trusted
  memory is offered to Runs automatically, always inside `<orbit-memory …>`
  tags as data; reading an untrusted one taints the Run; only the owner clears
  taint (audited). Feedback text is composed by Orbit, never quoted from model
  output. The audit log stores memory ids, never memory text.
- Delegation (ADR-013): `delegate_to_bot` parks the parent (`delegating`) and
  resumes it with the answers as untrusted data; children inherit the parent's
  taint and remaining budget; stopping a Run stops its children.
- Plugins (ADR-014): orbitd starts them per Run segment in the Bot's
  workspace and proxies them to the engine; a call runs only if policy allowed
  exactly that input. Declared tiers are exact names placed after
  `ORBIT_TOOL_TIERS` and never below the name's floor (`tierFloor`); plugin
  output is untrusted. A plugin is off until the owner enables it; a changed
  manifest is held back. Secrets are vault entries `plugin_<id>_<NAME>`.
- Inbound triggers deliver untrusted content: `<orbit-untrusted>` tags, the
  Run starts tainted with the trigger as its source, never while the
  trigger's previous Run is in flight.
- Model spend outside a Run goes only through `TriagePath` (counted, capped by
  `triage.maxCallsPerDay`, refused under a kill switch or usage-limit hold,
  shown to the owner).
- Pause and interruption (ADR-016): a pause parks a running Run at its next
  tool-call decision (`--now` interrupts) and ends it `paused`; nothing resumes
  a paused Run except the owner, or Orbit retrying an interrupted Run that is
  safe (session known, fewer than 2 retries, no allowed EXTERNAL call without
  a result; `onInterrupt: fail` opts out). `orbit shell` is the only take-over:
  bearer token only, refused while a Run executes or waits mid-call and for
  Docker Bots, holds the Bot through the Bot-pause hold, its shell gets the
  `tool` allowlist plus `ORBIT_TAKEOVER=1`, `GIT_DIR`/`GIT_WORK_TREE` for
  worktree Bots and `GIT_CEILING_DIRECTORIES`; a changed `.git` pointer is
  restored (audited), a directory Bot with a `.git` is refused; both ends
  audited. Plugin sandboxes bind the owner's common git dir read-only (only
  objects, refs, logs and the Bot's own worktree entry are writable).
- Roles (ADR-015): every contract route has a least role (GET = viewer, write =
  owner unless the table says `operator`); a new route that differs names it
  in `contract.ts`, and `roles.test.ts` lists every route. Service code records
  `this.actor()` (the request's principal), never a hardcoded owner.
- Memory imports are owner-only, all or nothing, redacted, provenance kept; a
  trusted line is trusted only because the owner imports it (`--untrusted`
  forces taint `import`); retention expires only unpinned Bot notes and
  summaries. TUI mouse is opt-in; clicks only select, never act; input passes
  through `MouseInput` before Ink.
- Untrusted text goes through `neutraliseTags` (`@orbit/core`) before it is
  wrapped; never write a new tag-escaping regex.
- Asset paths come from `orbitLayout()` (`@orbit/runtime`), never from
  `import.meta.dirname`; a new run-time import that cannot be bundled goes into
  the esbuild externals and `packaging/npm` dependencies (drift test).
- Pipe `pnpm typecheck` only with `set -o pipefail`; otherwise the exit code is
  the pipe's last command and failures go unnoticed.
- No TODO stubs in shipped code paths; record deferrals in `docs/PLAN.md` §7.
- Deviations from the brief get an ADR in `docs/decisions/`.

## Security invariants (lint + `tools/guards` enforce them)

- Never read, copy, store, log or forward Claude OAuth credentials
  (`~/.claude/.credentials.json`, keychain, `CLAUDE_CODE_OAUTH_TOKEN`).
- Child processes get an env built from an allowlist — never spread
  `process.env`. CliDriver children never get `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN`; the API key never reaches unrelated children.
- CliDriver is local single-user only (loopback bind, one principal, not
  `ORBIT_MODE=hosted`). orbitd binds loopback; `0.0.0.0` only inside a
  container (`ORBIT_CONTAINER=1` plus a container marker; publish to
  `127.0.0.1` only); off-loopback only in hosted mode with in-process TLS.
  Hosted mode needs `publicUrl` + OIDC, never uses the CliDriver, uses
  `__Host-` Secure cookies and HSTS (ADR-015). The API needs the 0600 bearer
  token (the `owner` principal), or (the App) a session cookie from a one-time
  ticket (or the OIDC callback) plus `X-Orbit-CSRF`. Browser origins: orbitd's
  own plus `api.allowedOrigins`, which accepts loopback and Tauri origins only
  (ADR-011).
- Docker sandboxes (ADR-018): `--network none`; the engine sees a placeholder
  key; the real key reaches the API only through the per-Bot host-side key
  proxy on a read-only-mounted 0600 Unix socket (two routes; `mcp_servers`,
  URL sources and, without network, web server tools refused); egress only
  through the CONNECT allowlist proxy (DNS checked on the host, private and
  metadata addresses refused); both forward only while a Run holds a lease.
  Bash is WRITE_LOCAL in a container only with `network: none`. Bedrock/Vertex
  and CLI mode never run containers.
- An API key or apiKeyHelper output never enters any child process: host SDK
  engines get the placeholder and
  `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/<segment token>` (orbitd's
  `HostKeyProxy`, one lease per Run segment, closed on end or abort, token
  redacted); Docker engines use their Unix socket. Only Bedrock/Vertex
  credentials reach the engine (scrub on; Linux needs bubblewrap, checked
  before start). `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is 1 where Claude Code can
  enforce it, else 0 (ADR-018 amendment).
- orbitd keeps the API key out of its own environment: `ORBIT_API_KEY_FILE`
  (0600, `O_NOFOLLOW`; Compose mounts a file secret), the CLI hands the key to
  the orbitd it spawns on stdin (`ORBIT_API_KEY_HANDOVER=stdin`), and an orbitd
  started with `ANTHROPIC_API_KEY` re-execs itself once without it (Linux,
  Node ≥ 22.15; elsewhere doctor warns `api_key_in_environment`).
- Plugin servers run under bwrap / `sandbox-exec` built from the manifest's
  `sandbox` section (`plugins.sandbox` auto|required|off, ADR-019): empty
  `$HOME`, no `$ORBIT_HOME`, workspace, network and folders only as declared.
  The Browser's proxy resolves names once and refuses private/metadata
  answers; Chromium resolves nothing itself and keeps its own sandbox.
  `orbit plugin install` checks the SRI before reading, uses a strict
  extractor, never runs package code, stores under `plugins.storeDir` (never in
  `$ORBIT_HOME`) and installs disabled.
- The audit key (keychain or `audit.key`, 0600) never enters the database;
  every record carries an HMAC; checkpoints are signed with it.
- No hardcoded model IDs: use `ORBIT_DEFAULT_MODEL` / `ORBIT_TRIAGE_MODEL` or
  aliases (`opus`, `sonnet`, `haiku`).
- Default-deny tool policy; EXTERNAL actions need approval; FINANCIAL is
  always handed back to the human. Budgets are enforced in runtime code.
- `/mcp/orbit` and `/mcp/plugins/<id>` take only per-segment tokens (never the
  API token or a cookie), refuse any `Origin`, and run a tool call only if
  Orbit's policy allowed exactly that call first.
  The CLI engine gets the token in a 0600 `--mcp-config` file, never on a
  command line; the SDK engine uses an in-process server.
- Plugin processes get `buildPluginEnv` (base allowlist + the manifest's env
  names, settings and its own secrets except `scope: "orbit"` ones, plus
  `ORBIT_WORKSPACE`, a worktree Bot's `ORBIT_GIT_REPO`/`ORBIT_GIT_BRANCH` and
  `ORBIT_DENIED_PATHS`); manifests cannot name credential or loader variables.
  Plugin git uses an explicit `GIT_DIR` from Orbit, never the workspace's
  `.git`, never looks inside nested repositories or submodules, and refuses
  to commit while there are any. `/hooks/<bot>/<trigger>` verifies the HMAC in constant time before
  parsing or storing anything (GitHub style: each signed body once); Slack is
  Socket Mode (outbound `wss`), and on the subscription a Slack trigger must
  name its `users`.

## Drivers (packages/runtime/src/drivers)

- `normalize.ts` is the only place engine messages become `RunEvent`s.
- `cli.ts` spawns `claude -p` (prompt on stdin); tool calls are decided by the
  PreToolUse hook → `hook-bridge.ts` (ADR-008). `sdk.ts` uses `query()` hooks.
- Orbit's MCP tools reach the CLI engine through `--mcp-config` (file) and
  the SDK engine through `createSdkMcpServer`; subagents go as `--agents` /
  `agents`.
- `mock.ts` replays `fixtures/claude-<version>/*.jsonl` (Orbit tools run for
  real; `<name>-resumed.jsonl` is replayed on resume); record new fixtures with
  `claude -p … --output-format stream-json --verbose` and scrub them with
  `scripts/scrub-fixture.ts` before committing.
- `test/driver-contract.ts` is the shared suite every driver must pass.

## Testing

- Tests sit next to code as `*.test.ts`; live tests are `*.live.test.ts`.
- CI uses `ORBIT_DRIVER=mock` and no credentials, ever. Plugin tests use local
  fakes (node:http servers, bare git remotes); the Browser plugin's Chromium
  tests skip without a browser and run in CI's e2e job.
- `pnpm lint` runs ESLint in three processes (packages+tools, apps, plugins) to
  stay inside CI's 6 GB heap.
- API tests use `@orbit/api/testing` (in-memory service, injectable clock);
  CLI tests start orbitd in-process through `Io.startDaemon`. Real-process
  tests set `ORBIT_PORT=0` (a developer's own orbitd may hold 7420).
- App tests (`npx vitest run --project @orbit/app`, jsdom) mount the real App
  over the real API service in-process (`src/test/harness.tsx`); every story
  renders with axe; e2e (`pnpm test:e2e`) starts orbitd through
  `e2e/orbitd.ts` (allowlisted env, `ORBIT_PORT=0`, always stopped).
- TUI tests render into memory with `apps/orbit-tui/test/render.ts`
  (configurable size, `press`, `waitFor`) over `test/tui-fixtures.ts`
  (fake client); update snapshots with `npx vitest run -u --project @orbit/tui`.
- Tests first for policy, budgets, replay, AuthResolver, driver contract.
- New guards get a positive-control test that proves they fire.

## Project agents and skills

- `.claude/agents/safety-reviewer.md`: audit at every milestone gate.
- `.claude/agents/test-engineer.md`: tests-first for invariants.
- `.claude/agents/ui-polish-reviewer.md`: screenshot/a11y review (M4+).
- `.claude/skills/milestone-gate`: procedure to close a milestone.
