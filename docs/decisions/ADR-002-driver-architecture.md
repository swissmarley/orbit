# ADR-002: One normalizer, three drivers

Status: Accepted (M0, implemented in M1)

## Context

`SdkDriver` (Agent SDK `query()`) and `CliDriver` (`claude -p --output-format
stream-json --verbose`) must emit identical `RunEvent`s and pass one contract
suite. Verified against SDK 0.3.289 / CLI 2.1.289: the SDK's `SDKMessage`
union and the CLI's stream-json lines are the same wire shapes (the SDK drives
the same engine over the same protocol).

## Decision

- A single pure function `normalize(message: SDKMessage, ctx) → RunEvent[]`
  in `@orbit/runtime` is the only place driver output becomes domain events.
- `CliDriver` = spawn + line-split + `JSON.parse` + `normalize`.
- `SdkDriver` = `query()` iterator + `normalize`.
- `MockDriver` = recorded JSONL fixtures + `normalize`, honoring the same
  permission callbacks so approvals work without credentials.
- Unknown message types are preserved as a `raw` event (never dropped,
  never crash) so CLI upgrades degrade gracefully.
- Contract suite runs against all three. `SdkDriver` gets an injectable
  `queryFn`; `CliDriver` gets an injectable executable path, exercised with a
  fake `claude` script that replays fixtures and asserts argv/env.

## Consequences

- Driver differences are confined to transport, auth/env and permission
  plumbing; UI never knows which driver ran.
- Fixtures must be re-recorded when the wire format changes (doctor reports
  the CLI version; fixtures are named by version).
