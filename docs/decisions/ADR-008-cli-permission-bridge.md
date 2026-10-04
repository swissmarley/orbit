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
  the decision. Failures _inside the script_ (bridge down, bad status, invalid
  answer, timeout, crash) print a deny **and exit 2**, Claude Code's blocking
  error, so the tool does not run.
- Failures _outside_ the script (hook killed, hook timeout, managed settings
  disabling hooks) are non-blocking in Claude Code. Orbit therefore verifies
  after the fact: every successful `tool.result` must have a prior Orbit
  decision for that tool-use id, otherwise the Run is stopped with
  `run.failed: policy_bypassed` (both drivers, `EventSequencer`).
- `--setting-sources ''` and `--strict-mcp-config` stop user/project settings,
  hooks, permission rules and MCP servers from leaking into Bot runs;
  `--permission-prompts none` denies anything that would still prompt.
- The per-Run token is in the engine's environment, so the Bot can read it.
  The bridge therefore only answers for a tool call the engine has already
  announced on stdout, at most once, with identical name and input; anything
  else is denied without writing to the event log. The token is registered
  with the process redactor so it never reaches events or logs.
- The engine's reported credential source (`init.apiKeySource`) is checked:
  CliDriver stops if it is `ANTHROPIC_API_KEY`; SdkDriver stops on any login
  source (`oauth`, `/login managed key`, …) or a source that does not match the
  configured credential.
- Stopping a Run signals the engine's whole process group.
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
