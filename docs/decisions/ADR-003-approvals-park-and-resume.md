# ADR-003: Approvals park and resume Runs

Status: Accepted (M0, implemented in M2)

## Context

Approvals are the core UX and a human may answer hours later. Holding a
`claude` subprocess (or SDK query) open while waiting wastes a concurrency
slot, risks hook/MCP timeouts, and does not survive daemon restarts.

## Decision

- Both drivers route permission decisions into the same `ApprovalQueue`:
  SDK via `hooks.PreToolUse` + `canUseTool`; CLI via a generated `--settings`
  PreToolUse command hook and `--permission-prompt-tool mcp__orbit__approve`
  served by orbitd's loopback MCP endpoint (per-Run bearer token).
- The driver waits up to a short window (default 30 s) for a decision. If
  none arrives it **denies with interrupt**, the Run moves to
  `waiting_approval`, and its concurrency slot is released.
- On decision, the orchestrator resumes the Run from its `session_id` with a
  one-shot grant bound to `(tool name, canonical input hash)`; "edit then
  approve" binds to the edited input; "always allow" creates a scoped rule
  with expiry.
- Every request and decision is an event and an audit record.

## Consequences

- Identical behavior for both drivers and for MockDriver.
- Resuming re-enters the model loop (small token cost) — acceptable.
