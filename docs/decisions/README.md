# Architecture Decision Records

One file per decision, `ADR-NNN-short-title.md`, status one of
`Proposed | Accepted | Superseded by ADR-NNN`. Record a decision whenever we
deviate from the mission brief or pick between real alternatives.

| ADR                                         | Title                                                    | Status   |
| ------------------------------------------- | -------------------------------------------------------- | -------- |
| [001](ADR-001-monorepo-and-tooling.md)      | Monorepo layout and tooling                              | Accepted |
| [002](ADR-002-driver-architecture.md)       | One normalizer, three drivers                            | Accepted |
| [003](ADR-003-approvals-park-and-resume.md) | Approvals park and resume Runs                           | Accepted |
| [004](ADR-004-sandbox-by-auth-mode.md)      | Sandbox strategy depends on auth mode                    | Accepted |
| [005](ADR-005-credential-isolation.md)      | Credential isolation and child environments              | Accepted |
| [006](ADR-006-model-selection.md)           | Model selection through config and aliases               | Accepted |
| [007](ADR-007-persistence.md)               | SQLite + Drizzle, append-only events, hash-chained audit | Accepted |
| [008](ADR-008-cli-permission-bridge.md)     | CLI permission bridge through a PreToolUse command hook  | Accepted |
| [009](ADR-009-tiers-and-taint.md)           | Risk tiers, MCP heuristics and taint                     | Accepted |
