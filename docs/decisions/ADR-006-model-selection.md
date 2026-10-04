# ADR-006: Model selection through config and aliases

Status: Accepted (M0)

## Decision

- `ORBIT_DEFAULT_MODEL` (default `opus`) and `ORBIT_TRIAGE_MODEL` (default
  `haiku`) are passed to the engine as-is. Claude Code resolves the aliases to
  the newest model of that family the account can use, in both drivers — this
  satisfies "default to the newest Opus the account offers" without
  hardcoding an ID.
- Per-Bot `model` and per-subagent `model` override the defaults.
- A lint rule rejects string literals matching `claude-(opus|sonnet|haiku|fable)-…`
  outside tests and fixtures.
- `orbit doctor` prints the model the engine actually reported in its `init`
  message for a dry probe.
