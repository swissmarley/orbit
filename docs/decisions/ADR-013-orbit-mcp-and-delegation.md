# ADR-013: Orbit's MCP tools, subagents and peer-Bot delegation

Status: Accepted (M6)

## Context

Bots need Orbit-owned tools (memory, delegation) inside the engine. The plan
reserved a loopback `/mcp/orbit` endpoint "used by both drivers (per-run
token)" (deferred from M3). The brief also asks for subagents (`agents` /
`--agents`) and peer-Bot delegation (`delegate_to_bot` → a child Run) with
budgets, approvals and kill switches carried across, and a live delegation
tree.

Constraints found while designing it:

- The Agent SDK passes `mcpServers` to the engine as `--mcp-config <json>` on
  the command line. An HTTP server config with an `Authorization` header
  would put the token in `ps` output for every local user.
- A Bot can read its own environment and, with an approved shell, files Orbit
  hands the engine; a token alone must not let it bypass Orbit's policy.
- A parent that waits inside a tool call for a child Run holds a
  concurrency slot (CLI default 2) while the child needs one: deadlock.

## Decision

**One toolset, three transports.** `OrbitToolset` implements
`memory_search`, `memory_read`, `memory_write` and `delegate_to_bot` once.

- CliDriver: orbitd's own HTTP server serves `POST /mcp/orbit` — a minimal,
  stateless MCP server (JSON-RPC 2.0, JSON responses; `initialize`, `ping`,
  `tools/list`, `tools/call`, nothing else). The engine gets
  `--mcp-config <path>` (with `--strict-mcp-config`, so it is the only
  server) pointing at a 0600 file in a fresh 0700 directory under
  `$ORBIT_HOME/run`, removed when the segment ends. The path, never the
  token, is on the command line.
- SdkDriver: an in-process SDK MCP server (`createSdkMcpServer`) that talks
  over the SDK's own control channel — no port, no token.
- MockDriver: calls the toolset directly for allowed `mcp__orbit__*` calls, so
  memory and delegation work in demo mode and CI.

**Authentication of `/mcp/orbit`.** The endpoint is outside the client
contract and does not accept the API bearer token or App sessions. It needs a
**per-segment token**: 256 random bits minted when a driver segment starts,
looked up by its SHA-256 (no timing on the secret), registered with the
process redactor, and dead when the segment ends. Any request with an
`Origin` header is refused (no browser can call it); the Host allowlist
(DNS-rebinding guard) still applies; bodies are capped like every route; GET
and DELETE get 405. A token reaches only its own Run's tools for its own Bot.

**Policy is checked per call, not per token.** When Orbit's PreToolUse
decision allows an `mcp__orbit__*` call, it records one authorization for
exactly that tool and canonical input (unknown keys dropped, then hashed). A
tool call runs only if it consumes such an authorization; replays and calls
the engine never announced are refused without side effects. A Bot that reads
its token and calls the endpoint itself gains nothing its policy would not
allow anyway. Orbit's tools have fixed tiers that no plugin can override:
memory reads are READ, `memory_write` and `delegate_to_bot` WRITE_LOCAL (the
owner allowlists the peers; every child Run has its own policy). Memory tools
are on by default (`memory.tools`); delegation only with
`delegation.allowedBots`.

**Subagents.** `BotSpec.subagents` (≤ 10, name → description, prompt, tools,
model, maxTurns) goes to the engine as `agents` (SDK) / `--agents` (CLI). A
subagent's tools must be a subset of the Bot's tools; Orbit appends a short
note that its tool calls are governed by Orbit's policy and that tool content
is untrusted. Every subagent tool call still goes through the same PreToolUse
hook (verified in M1 against Claude Code 2.1.289 with `--forward-subagent-text`).

**Delegation is park-and-resume (like approvals, ADR-003).**
`delegate_to_bot(bot, task)` checks that the target is in the parent Bot's
`delegation.allowedBots`, is not the parent, is not already in the chain above
(no cycles), keeps within `delegation.maxDepth` (config, default 3) and
`maxChildrenPerRun` (default 3), and that budget is left. It enqueues a child
Run (`trigger: delegation`, `parentRunId`, `depth`) and returns. Orbit then
stops the parent engine after that tool result (`continue: false`) and parks
it as `delegating` (a new Run status: "⇢ delegated"), releasing its slot. When
every child has ended, orbitd records `delegation.finished` (answer, status,
spend) on the parent and resumes it in its engine session with the answers
wrapped in `<orbit-delegation …>` tags as untrusted data. A parent that parked
with approvals and delegations waits for both.

**What carries across.**

- _Budgets:_ the child's ceiling (`budgetCap`) is what the parent had left of
  tool calls, tokens and cost (and its wall clock); the child's spend is added
  to the parent's (`delegated`) and counts against the parent's budgets on
  resume.
- _Taint:_ the child starts with the parent's untrusted sources
  (`inheritedTaint`), so it cannot auto-allow EXTERNAL actions either; the
  parent is tainted with `delegate:<Bot>` when an answer comes back, whatever
  the child did.
- _Approvals:_ the child's EXTERNAL calls go to the owner's Inbox like any
  other; the card names the delegation chain ("Delegated by Lead") and says the
  task text was written by a Bot. FINANCIAL stays handed back. Nothing a parent
  approved or allowed by rule transfers to a child.
- _Kill switches:_ stopping a Run stops its children (recursively); pausing a
  Bot stops its Runs and theirs; the global kill switch stops everything. A
  Run that ends without parking stops children that are still going.
- Restart recovery: children that ended while orbitd was down report to their
  parents at startup.

**Visibility.** `GET /v1/runs/{run}/tree` returns the whole delegation tree a
Run belongs to; the App's Run view shows it live (it refetches on run events)
and the TUI shows it with `t`; the CLI has `orbit tree <run>`.

## Consequences

- One extra engine resume per delegation (small token cost), in exchange for
  no deadlock and no held slot while a peer works.
- `/mcp/orbit` is not in the contract table or `openapi.json`: it is a
  different protocol for engines, not a client route. Its whole surface is in
  `packages/runtime/src/orbit-tools/mcp.ts`.
- The CLI engine's MCP tool calls are verified at unit and contract level;
  a live check against Claude Code (HTTP MCP config, tool-name and input
  shape through the hook) is recorded in PLAN §7 until it has run.
