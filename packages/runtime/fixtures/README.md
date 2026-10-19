# MockDriver fixtures

Each `*.jsonl` file is an engine transcript: one Agent SDK `SDKMessage` /
`claude -p --output-format stream-json --verbose` line per row. The MockDriver
replays them through the same normalizer as the real drivers (ADR-002).

Directory = engine version the shapes were taken from.

| Fixture                          | Provenance                                                             | Scenario                                                |
| -------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `pong.jsonl`                     | recorded (haiku), scrubbed                                             | no tools, one text reply                                |
| `read-then-write-denied.jsonl`   | recorded (haiku), scrubbed; PreToolUse hook allowed Read, denied Write | tool call, policy denial, "needs approval" summary      |
| `hook-input-pretooluse.jsonl`    | recorded, scrubbed                                                     | exact stdin a PreToolUse command hook receives          |
| `usage-limit.jsonl`              | synthesized from SDK 0.3.289 types                                     | subscription limit `rejected` → Run pauses              |
| `subagent-delegation.jsonl`      | synthesized from SDK 0.3.289 types                                     | Task tool → subagent messages with `parent_tool_use_id` |
| `max-turns.jsonl`                | synthesized from SDK 0.3.289 types                                     | `error_max_turns` result                                |
| `tool-error-secret.jsonl`        | synthesized from SDK 0.3.289 types                                     | a failed tool whose error text contains a secret        |
| `memory-notes.jsonl`             | synthesized (M6)                                                       | `memory_search` then `memory_write` (Orbit MCP tools)   |
| `delegate-to-peer.jsonl`         | synthesized (M6)                                                       | `delegate_to_bot` → the Run parks as delegating         |
| `delegate-to-peer-resumed.jsonl` | synthesized (M6)                                                       | the resumed segment after the peer answered             |
| `web-then-write.jsonl`           | synthesized (M6)                                                       | WebFetch (taint) then Write → the file is marked        |
| `read-notes-page.jsonl`          | synthesized (M6)                                                       | Read of that file → the later Run is tainted            |
| `web-then-write-resumed.jsonl`   | synthesized (ADR-020)                                                  | a reply in that conversation: Read of the notes, answer |

Orbit's own tools (`mcp__orbit__*`) run for real during a replay: the
recorded result is replaced by the toolset's answer. A resumed segment replays
`<name>-resumed.jsonl` when the scenario has one (listings hide those).

Recordings are scrubbed with `scripts/scrub-fixture.ts` (stable UUIDs,
`/workspace` paths, no signatures, neutral rate-limit numbers). Never commit an
unscrubbed recording.
