# ADR-017: Packaging and distribution: one npm package, one container, a thin desktop shell

Status: Accepted (M8)

## Context

Until M8 Orbit ran only from a checkout: internal packages are consumed as
TypeScript source, `tsx` compiles on the fly, and several places found their
assets relative to their own source file (the built App, the MockDriver's
fixtures, the CliDriver's hook script, the reference plugins, the orbitd bin
the CLI starts). M8 asks for an npm bin and a packaged orbitd, `docker compose
up` (orbitd + App, API-key mode), a Tauri desktop build and a release
workflow. Constraints:

- Native modules (`better-sqlite3`, `@napi-rs/keyring`) cannot be bundled
  (risk R7). The Agent SDK locates its own engine binary next to itself, so it
  must stay an installed package; the SDK's peers (`@anthropic-ai/sdk`,
  `@modelcontextprotocol/sdk`, `zod`) must be the same copies Orbit uses, or
  the zod schemas and MCP servers Orbit hands the SDK are a foreign kind.
  `playwright-core` finds its browsers itself.
- The security invariants hold for shipped code too: no credential reads, every
  child env from an allowlist, orbitd reachable only from this machine, the
  App never holding the bearer token (ADR-011).
- Tauri needs WebKitGTK on Linux and Rust everywhere (risk R9).
- PLAN open question 1: the npm name.

## Decision

### Name

The npm package is **`orbit-bots`** (MIT © 2026 Nakya, version `0.1.0`), with
two bins: `orbit` (CLI and TUI) and `orbitd`. The `@orbit/*` workspace
packages stay private.

### One asset-layout seam

`orbitLayout()` in `@orbit/runtime` (`src/layout.ts`) is the only place that
knows where assets live; orbitd, the CLI's `spawnDaemon`, the MockDriver, the
CliDriver and the plugin registry all ask it:

| asset             | dev tree                              | npm package                    |
| ----------------- | ------------------------------------- | ------------------------------ |
| built App         | `apps/orbit-app/dist`                 | `dist/app`                     |
| mock fixtures     | `packages/runtime/fixtures`           | `dist/fixtures`                |
| CLI hook script   | `packages/runtime/bin/orbit-hook.mjs` | `dist/orbit-hook.mjs`          |
| reference plugins | `plugins/<id>` (TypeScript servers)   | `dist/plugins/<id>/server.mjs` |
| orbitd            | `apps/orbitd/src/bin.ts` with tsx     | `dist/orbitd.mjs`, plain node  |

The bundles mark themselves at build time (esbuild `define`
`__ORBIT_PACKAGED__ = true`); no variable a user sets switches layouts.
`ORBIT_APP_DIR` still overrides the App folder.

### The npm package (`packaging/npm`)

- **esbuild** bundles `orbit` and `orbitd` as ESM `.mjs` with their node
  shebang, and each reference plugin's server into a self-contained
  `server.mjs`. PLAN §2.1 said `tsup`; tsup is a wrapper around esbuild, which
  is already in the tree, and the build needs only `define`, externals and one
  small plugin (an inert stand-in for Ink's optional React DevTools import).
- **Externals** are exactly the run-time `dependencies`, pinned to the versions
  the workspace packages declare: the Agent SDK and its three peers, the two
  native modules and `playwright-core`. A test fails on drift, on ranges and on
  a dependency the bundles do not import. No install scripts run.
- **Plugin manifests** are copied unchanged except the server, rewritten from
  `${node} --import ${tsx} ${pluginDir}/src/server.ts` to
  `${node} ${pluginDir}/server.mjs`; the build refuses a manifest that starts
  any other way, and `tools/guards/plugins.test.ts` keeps checking the source
  manifests. The manifest hash therefore differs from a checkout's: a plugin
  enabled from a checkout shows as changed under the package (same
  `ORBIT_HOME`) until it is enabled again. An owner's plugin that uses `${tsx}`
  needs `tsx` on the PATH of a packaged install; JavaScript servers need
  nothing.
- **No source maps.** A bundle guard runs at the end of every build over the
  shipped JavaScript, JSON, HTML and CSS (third-party code included): the
  repository's credential rules (`.credentials.json`, the keychain entry,
  reads of `CLAUDE_CODE_OAUTH_TOKEN`) and any absolute path of the build
  machine fail the build.
- **Smoke test** (`pnpm smoke`, CI job `package`): build, `npm pack`, check the
  tarball holds only `dist/`, README and LICENSE, install it into a temporary
  prefix, then with `ORBIT_DRIVER=mock ORBIT_PORT=0` and a throwaway
  `ORBIT_HOME`: `orbit doctor --json` auto-starts the packaged orbitd (checked
  to run as `node …/dist/orbitd.mjs`, no tsx installed), a Bot runs to
  completion, the five reference plugins come from the package and the
  Filesystem one starts its bundled server when enabled, `orbit app --json`
  prints a sign-in link and orbitd serves the App with its CSP, and the hook
  script fails closed. The daemon is always stopped.

### Docker (`docker/orbitd.Dockerfile`, `compose.yaml`)

- One service, `orbitd`, which serves the App itself. Multi-stage: the npm
  tarball is built from the checkout exactly as for a release and
  `npm install -g`'d (with a toolchain, should `better-sqlite3` need to
  compile) into `/opt/orbit`, which is copied into a `node:22-bookworm-slim`
  runtime with `git` and `tini`.
- **API-key mode only.** The image has no Claude Code CLI and the CliDriver is
  refused on a non-loopback bind anyway. `ANTHROPIC_API_KEY` (or
  `ORBIT_API_KEY_HELPER`, a command in the container that prints a key) comes
  from the environment or `.env` at run time; `.dockerignore` keeps `.env` out
  of the build context, so no key is ever in an image layer.
- **Reachable from this machine only.** Inside the container orbitd binds
  `0.0.0.0` (`ORBIT_HOST=0.0.0.0` with `ORBIT_CONTAINER=1`; orbitd accepts a
  wildcard bind only inside a container and still publishes
  `http://127.0.0.1:<port>`), and compose publishes the port on the host's
  `127.0.0.1` only. Both sides use 7420 because orbitd checks the Host header
  against its port.
- **Least privilege.** Non-root user (uid 10001), read-only root filesystem
  with a `/tmp` tmpfs, `cap_drop: [ALL]`, `no-new-privileges`. Two named
  volumes: `/data` (`ORBIT_HOME`) and `/home/orbit` (the engine's own state,
  which a parked Run resumes from). `HEALTHCHECK` calls `/v1/health`, the one
  unauthenticated route.
- The Docker socket is not mounted (it would be root on the host), so Bots in
  this container use directory or worktree workspaces; the container is their
  isolation boundary. The CLI works through
  `docker compose exec orbitd orbit …`, including
  `orbit app --no-open` for the sign-in link.

### Desktop shell (`apps/orbit-desktop`, Tauri 2)

ADR-011's "loads the App from orbitd" option. The shell bundles no Orbit
code; it needs the installed `orbit` CLI.

- On launch the window shows a bundled start page, and the Rust side runs
  `orbit app --json --no-open` (`ORBIT_CLI`, else `PATH`, else the usual npm
  global bin folders). The CLI starts orbitd if needed and prints the one-time
  link on its **stdout**; it never goes on a command line. The shell checks it
  (`http`, loopback host, `/login`, a ticket in the fragment) and navigates the
  window there, so the App runs on orbitd's own origin with the HttpOnly
  cookie, the CSRF header and orbitd's CSP, exactly as in a browser. No API
  token ever reaches the webview or the shell.
- The CLI child gets a cleared environment plus the allowlist of the `orbitd`
  child kind (`packages/runtime/src/env.ts`, mirrored in `childenv.rs`): never
  `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN` or
  `ANTHROPIC_AUTH_TOKEN`. The CLI's folder goes first on `PATH` so its
  `#!/usr/bin/env node` finds Node.js from a GUI launch.
- **Navigation guard:** before sign-in only the bundled page; after it only
  orbitd's origin. Other `http(s)` links (and `window.open`) open in the
  system browser through the opener plugin; any other scheme goes nowhere.
- **No IPC for the remote page:** the only capability is local, for the
  bundled page, and grants no permission; no capability lists a remote URL.
  Verified headless (Xvfb) against a stand-in orbitd: the page's
  `invoke('plugin:opener|open_url')` and `invoke('plugin:event|listen')` are
  refused, `file:` and `tauri:` navigations and `window.open` are blocked, and
  the CLI child received no OAuth token.
- Built by an optional workflow (`desktop.yml`: by hand, and from the release
  for every tag) on Linux, macOS (universal) and Windows with the official
  `tauri-action`. Bundles are not code-signed and have no auto-updater yet.

### Release (`release.yml`)

A `vX.Y.Z` tag (it must equal the package version) runs `pnpm check`, builds
and smoke-tests the package, publishes the tested tarball to npm with
provenance when the `NPM_TOKEN` secret exists, pushes
`ghcr.io/<repo>:<version>` and `:latest` (amd64 and arm64), builds the desktop
bundles and creates the GitHub Release with the tarball, the bundles and
`SHA256SUMS`. A failed desktop build does not hold the release back. Run by
hand it is a dry run. Each job has the minimal permissions it needs.

## Consequences

- `npm install --global orbit-bots` is the supported install; the CLI starts
  the packaged orbitd without tsx. The unpacked package is about 7 MB (the
  Agent SDK's engine binary is a separate, platform-specific dependency).
- Every new asset location goes through `orbitLayout()`, and every new
  run-time import that cannot be bundled goes into `EXTERNAL` and the
  package's `dependencies` (the drift test enforces the pair).
- Docker and desktop are verified in CI (`docker` job, `desktop.yml`), not in
  the development container (no Docker daemon there). The Tauri shell was
  compiled, unit-tested and run headless in the development container.
- Not yet: signed and notarized desktop bundles, an auto-updater, Homebrew or
  winget packages, and a remote plugin catalog.
