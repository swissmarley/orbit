import { RunEventBody } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixtures';
import { Normalizer, normalizeAll } from './normalize';

describe('normalizer on real CLI recordings', () => {
  it('maps the recorded read/write-denied session to the expected event sequence', () => {
    const events = normalizeAll(loadFixture('read-then-write-denied')!);
    for (const e of events) expect(() => RunEventBody.parse(e)).not.toThrow();
    expect(events.map((e) => e.type)).toEqual([
      'session.init',
      'usage_limit',
      'usage.turn',
      'message.assistant',
      'tool.call',
      'hook',
      'tool.result',
      'usage.turn',
      'tool.call',
      'hook',
      'tool.result',
      'usage.turn',
      'message.assistant',
      'status.summary',
      'usage',
      'run.completed',
    ]);
    const turns = events.filter((e) => e.type === 'usage.turn');
    expect(turns.at(-1)?.type === 'usage.turn' && turns.at(-1)?.data.turns).toBe(3);
    const summary = events.find((e) => e.type === 'status.summary');
    expect(summary?.type === 'status.summary' && summary.data.category).toBe('blocked');
    const done = events.at(-1)!;
    expect(done.type === 'run.completed' && done.data.permissionDenials).toEqual([
      { toolName: 'Write', toolUseId: 'toolu_01NAnNnQuJo1xL8oyW4qkvvy' },
    ]);
  });

  it('ignores empty thinking blocks and engine bookkeeping messages', () => {
    const events = normalizeAll(loadFixture('pong')!);
    expect(events.some((e) => e.type === 'message.thinking')).toBe(false);
    expect(events.some((e) => e.type === 'raw')).toBe(false);
    const init = events[0]!;
    expect(init.type === 'session.init' && init.data.engineVersion).toBe('2.1.289');
  });
});

describe('normalizer edge cases', () => {
  it('counts the main agent’s turns (subagents have their own limits) but everyone’s tokens', () => {
    const events = normalizeAll(loadFixture('subagent-delegation')!);
    const live = events.flatMap((e) => (e.type === 'usage.turn' ? [e.data] : []));
    // Two main-agent messages and two subagent messages, each with usage.
    expect(live).toHaveLength(4);
    expect(live.at(-1)?.turns).toBe(2);
    expect(live.map((u) => u.inputTokens)).toEqual(
      [...live.map((u) => u.inputTokens)].sort((a, b) => a - b),
    );
  });

  it('keeps unknown messages as raw events instead of dropping or crashing', () => {
    const n = new Normalizer();
    expect(n.push({ type: 'brand_new_thing', session_id: 's' })).toEqual([
      { type: 'raw', data: { messageType: 'brand_new_thing', subtype: null } },
    ]);
    expect(n.push({ type: 'system', subtype: 'future_subtype' })).toEqual([
      { type: 'raw', data: { messageType: 'system', subtype: 'future_subtype' } },
    ]);
    expect(n.push(null)).toEqual([]);
    expect(n.push('text')).toEqual([]);
  });

  it('truncates huge tool results', () => {
    const n = new Normalizer(100);
    const [e] = n.push({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(1000) }] },
    });
    expect(e?.type === 'tool.result' && e.data.truncated).toBe(true);
    expect(e?.type === 'tool.result' && e.data.content.length).toBeLessThan(200);
  });

  it('treats an assistant rate_limit error as a usage-limit pause even without a rate_limit_event', () => {
    const n = new Normalizer();
    n.push({
      type: 'assistant',
      error: 'rate_limit',
      message: { content: [{ type: 'text', text: 'limit' }] },
    });
    const out = n.push({ type: 'result', subtype: 'success', is_error: true, result: 'limit' });
    expect(out.at(-1)?.type).toBe('run.rate_limited');
  });

  it('maps authentication failures to run.failed with the engine error code', () => {
    const n = new Normalizer();
    n.push({ type: 'assistant', error: 'authentication_failed', message: { content: [] } });
    const out = n.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Invalid API key',
    });
    const last = out.at(-1)!;
    expect(last.type === 'run.failed' && last.data.code).toBe('authentication_failed');
  });

  it('accepts reset times in seconds or milliseconds', () => {
    const n = new Normalizer();
    const [a] = n.push({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1791158400 },
    });
    const [b] = n.push({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1791158400000 },
    });
    expect(a?.type === 'usage_limit' && a.data.resetsAt).toBe('2026-10-05T00:00:00.000Z');
    expect(b?.type === 'usage_limit' && b.data.resetsAt).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('background subagents (task-notification)', () => {
  const agentCall = (id: string, input: Record<string, unknown>) => ({
    type: 'assistant',
    message: {
      id: `m_${id}`,
      content: [
        { type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'researcher', ...input } },
      ],
    },
    parent_tool_use_id: null,
  });
  const result = (id: string, text = 'Async agent launched successfully.') => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    parent_tool_use_id: null,
  });
  const notification = (taskId: string, toolUseId: string | undefined, status: string) => ({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    status,
    output_file: '/tmp/out',
    summary: 'done',
  });
  const subagentEvents = (messages: unknown[]) =>
    normalizeAll(messages).filter((e) => e.type.startsWith('subagent.'));

  it('a run_in_background subagent ends with its notification, not its tool result', () => {
    expect(
      subagentEvents([
        agentCall('t1', { run_in_background: true, description: 'dig' }),
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-1',
          tool_use_id: 't1',
          is_backgrounded: true,
        },
        result('t1'),
        notification('task-1', 't1', 'completed'),
      ]),
    ).toEqual([
      {
        type: 'subagent.started',
        data: {
          toolUseId: 't1',
          agentType: 'researcher',
          description: 'dig',
          parentToolUseId: null,
        },
      },
      { type: 'subagent.backgrounded', data: { toolUseId: 't1' } },
      { type: 'subagent.stopped', data: { toolUseId: 't1', isError: false, outcome: 'completed' } },
    ]);
  });

  it('a foreground subagent moved to the background (task_updated) is tracked by task id', () => {
    expect(
      subagentEvents([
        agentCall('t2', {}),
        { type: 'system', subtype: 'task_started', task_id: 'task-2', tool_use_id: 't2' },
        {
          type: 'system',
          subtype: 'task_updated',
          task_id: 'task-2',
          patch: { is_backgrounded: true },
        },
        result('t2', 'running in the background'),
        notification('task-2', undefined, 'failed'),
      ]).map((e) => (e.type === 'subagent.stopped' ? e.data : e.type)),
    ).toEqual([
      'subagent.started',
      'subagent.backgrounded',
      { toolUseId: 't2', isError: true, outcome: 'failed' },
    ]);
  });

  it('handles a notification that arrives before the tool result', () => {
    expect(
      subagentEvents([
        agentCall('t3', { run_in_background: true }),
        notification('task-3', 't3', 'stopped'),
        result('t3'),
      ]).map((e) => (e.type === 'subagent.stopped' ? e.data.outcome : e.type)),
    ).toEqual(['subagent.started', 'subagent.backgrounded', 'stopped']);
  });

  it('foreground subagents still end with their tool result; stray notifications are ignored', () => {
    expect(
      subagentEvents([
        agentCall('t4', {}),
        result('t4', 'answer'),
        notification('task-x', 'nope', 'completed'),
      ]),
    ).toEqual([
      expect.objectContaining({ type: 'subagent.started' }),
      { type: 'subagent.stopped', data: { toolUseId: 't4', isError: false, outcome: null } },
    ]);
  });
});
