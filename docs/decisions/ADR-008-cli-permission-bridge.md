# ADR-008: CLI permission bridge through a PreToolUse command hook

Status: Accepted (M1)

## Context

ADR-003 sketched two mechanisms for CliDriver: a PreToolUse hook and
`--permission-prompt-tool` (an MCP tool served by orbitd). Recording real
Claude Code 2.1.289 sessions showed a single mechanism is enough and simpler:
a PreToolUse command hook that returns `allow` or `deny` decides every tool
call, including subagent calls, and `--permission-prompts none` makes the
engine deny anything that would otherwise prompt.

## Decision

- CliDriver passes `--settings` with one PreToolUse hook (`matcher: "*"`) that
  runs `bin/orbit-hook.mjs`. The script POSTs the hook input to a loopback
  `HookBridge` (127.0.0.1, random port) with a per-Run bearer token and prints
  the decision. Any failure (bridge down, bad status, bad config) → deny.
- `--setting-sources ''` and `--strict-mcp-config` stop user/project settings,
  hooks, permission rules and MCP servers from leaking into Bot runs.
- The per-Run token only lets a caller _ask_ for a decision about a tool call;
  it cannot approve, change policy or read anything. It is in the engine's
  environment (the Bot could read it) and is registered with the redactor.
- `ask` outcomes (M2) are resolved inside the same hook call: the bridge waits
  for the approval queue up to the park window, then denies with interrupt and
  parks the Run (ADR-003).
- The prompt goes to the engine on stdin; Orbit assigns `--session-id` for new
  sessions so a Run can be resumed even if it dies before `init`.
- SdkDriver mirrors this with `hooks.PreToolUse` callbacks; `canUseTool` is a
  backstop that calls the same handler.

## Consequences

- One code path (`decide()`) and one event (`permission.decision`) for all
  drivers; the contract suite checks decision ordering for each.
- Each tool call spawns a short-lived Node process for the hook (~50 ms).
