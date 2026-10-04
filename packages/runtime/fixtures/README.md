# MockDriver fixtures

Each `*.jsonl` file is an engine transcript: one Agent SDK `SDKMessage` /
`claude -p --output-format stream-json --verbose` line per row. The MockDriver
replays them through the same normalizer as the real drivers (ADR-002).

Directory = engine version the shapes were taken from.

| Fixture                        | Provenance                                                             | Scenario                                                |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `pong.jsonl`                   | recorded (haiku), scrubbed                                             | no tools, one text reply                                |
| `read-then-write-denied.jsonl` | recorded (haiku), scrubbed; PreToolUse hook allowed Read, denied Write | tool call, policy denial, "needs approval" summary      |
| `hook-input-pretooluse.jsonl`  | recorded, scrubbed                                                     | exact stdin a PreToolUse command hook receives          |
| `usage-limit.jsonl`            | synthesized from SDK 0.3.289 types                                     | subscription limit `rejected` → Run pauses              |
| `subagent-delegation.jsonl`    | synthesized from SDK 0.3.289 types                                     | Task tool → subagent messages with `parent_tool_use_id` |
| `max-turns.jsonl`              | synthesized from SDK 0.3.289 types                                     | `error_max_turns` result                                |

Recordings are scrubbed with `scripts/scrub-fixture.ts` (stable UUIDs,
`/workspace` paths, no signatures, neutral rate-limit numbers). Never commit an
unscrubbed recording.
