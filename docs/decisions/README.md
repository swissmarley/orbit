# Architecture Decision Records

One file per decision, `ADR-NNN-short-title.md`, status one of
`Proposed | Accepted | Superseded by ADR-NNN`. Record a decision whenever we
deviate from the mission brief or pick between real alternatives.

| ADR                                            | Title                                                           | Status   |
| ---------------------------------------------- | --------------------------------------------------------------- | -------- |
| [001](ADR-001-monorepo-and-tooling.md)         | Monorepo layout and tooling                                     | Accepted |
| [002](ADR-002-driver-architecture.md)          | One normalizer, three drivers                                   | Accepted |
| [003](ADR-003-approvals-park-and-resume.md)    | Approvals park and resume Runs                                  | Accepted |
| [004](ADR-004-sandbox-by-auth-mode.md)         | Sandbox strategy depends on auth mode                           | Accepted |
| [005](ADR-005-credential-isolation.md)         | Credential isolation and child environments                     | Accepted |
| [006](ADR-006-model-selection.md)              | Model selection through config and aliases                      | Accepted |
| [007](ADR-007-persistence.md)                  | SQLite + Drizzle, append-only events, hash-chained audit        | Accepted |
| [008](ADR-008-cli-permission-bridge.md)        | CLI permission bridge through a PreToolUse command hook         | Accepted |
| [009](ADR-009-tiers-and-taint.md)              | Risk tiers, MCP heuristics and taint                            | Accepted |
| [010](ADR-010-daemon-api-and-queue.md)         | orbitd as single writer, contract-driven API, loopback auth     | Accepted |
| [011](ADR-011-app-origin-and-session.md)       | App served by orbitd, one-time ticket → session cookie          | Accepted |
| [012](ADR-012-memory-provenance-and-taint.md)  | Memory with provenance, persistent taint, metered triage path   | Accepted |
| [013](ADR-013-orbit-mcp-and-delegation.md)     | Orbit MCP tools, subagents and peer-Bot delegation              | Accepted |
| [014](ADR-014-plugins-and-inbound-triggers.md) | Plugins behind Orbit's MCP endpoint; verified inbound triggers  | Accepted |
| [015](ADR-015-hosted-mode-tls-oidc-roles.md)   | Hosted mode: TLS, OIDC sign-in and roles                        | Accepted |
| [017](ADR-017-packaging-and-distribution.md)   | Packaging: one npm package, one container, a thin desktop shell | Accepted |
