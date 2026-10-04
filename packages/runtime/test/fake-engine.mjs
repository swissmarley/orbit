// Shared replay logic for the fake `claude` CLI and the fake Agent SDK query().
// Replays a recorded transcript; for each tool_use it asks `decide(hookInput)`
// (the real permission path of the driver under test). When the decision
// differs from the recording, it ends the turn consistently, like the engine
// would: a denied call yields an error tool_result and a result listing the
// denial; an allowed call that was denied in the recording yields success.
import { readFileSync } from 'node:fs';

export function readFixture(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function recordedDenials(messages) {
  const set = new Set();
  for (const m of messages) {
    if (m.type === 'result') for (const d of m.permission_denials ?? []) set.add(d.tool_use_id);
  }
  return set;
}

export async function* replay(messages, { decide, sessionId, cwd }) {
  const denied = recordedDenials(messages);
  const sid = sessionId ?? messages.find((m) => m.session_id)?.session_id;
  const stamp = (m) => ({ ...m, session_id: sid });
  for (const m of messages) {
    yield stamp(m);
    if (m.type !== 'assistant') continue;
    for (const block of m.message?.content ?? []) {
      if (block.type !== 'tool_use') continue;
      const hookInput = {
        session_id: sid,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: block.name,
        tool_input: block.input,
        tool_use_id: block.id,
        permission_mode: 'default',
      };
      const out = await decide(hookInput);
      const decision = out?.hookSpecificOutput?.permissionDecision ?? 'deny';
      const reason = out?.hookSpecificOutput?.permissionDecisionReason ?? '';
      const recordedDeny = denied.has(block.id);
      if (decision === 'deny' && !recordedDeny) {
        yield stamp({
          type: 'user',
          parent_tool_use_id: m.parent_tool_use_id ?? null,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: `PreToolUse:${block.name} hook error: ${reason}`,
              },
            ],
          },
        });
        yield stamp(
          finalResult(`Blocked: ${reason}`, [
            { tool_name: block.name, tool_use_id: block.id, tool_input: block.input },
          ]),
        );
        return;
      }
      if (decision === 'allow' && recordedDeny) {
        yield stamp({
          type: 'user',
          parent_tool_use_id: m.parent_tool_use_id ?? null,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: block.id, content: 'ok' }],
          },
        });
        yield stamp(finalResult(`${block.name} done`, []));
        return;
      }
    }
  }
}

function finalResult(text, denials) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    stop_reason: 'end_turn',
    num_turns: 2,
    duration_ms: 10,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: denials,
  };
}
