# ADR-004: Sandbox strategy depends on auth mode

Status: Accepted (M0, implemented in M2)

## Context

Bots need "their own computer". Docker is the strongest isolation, but in
subscription (CLI) mode the engine must be the user's own logged-in `claude`
binary, and Orbit must never copy OAuth credentials anywhere — so the
credentials cannot be placed in a container.

## Decision

- **API-key mode (SdkDriver):** `DockerSandbox` — the engine runs inside the
  container via the SDK's `spawnClaudeCodeProcess` (`docker exec -i`), with
  CPU/memory/pids limits, a per-Bot volume, and egress through an allowlist
  proxy. The key is passed only to that process's environment.
- **Subscription mode (CliDriver) and dev:** `WorktreeSandbox` — a git
  worktree (or plain directory) per Bot under `$ORBIT_HOME/workspaces`, with
  Claude Code's native sandbox settings (filesystem write scope = workspace,
  network allowlist) generated into `--settings`, plus Orbit's policy engine.
- `orbit doctor` reports the active sandbox and its isolation level.

## Consequences

- CLI mode has weaker isolation than Docker; this is documented in the
  security model and is acceptable for single-user local use (the only use
  CLI mode allows).
