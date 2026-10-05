import type { RunEvent } from '@orbit/core/browser';
import { describe, expect, it } from 'vitest';
import { buildTimeline, subagentTree, summarizeToolInput } from './timeline';

let id = 0;
const ev = (type: string, data: Record<string, unknown>): RunEvent =>
  ({
    id: ++id,
    runId: 'run_1',
    botId: 'bot_1',
    seq: id,
    ts: '2026-10-05T10:00:00.000Z',
    type,
    data,
  }) as RunEvent;

describe('timeline', () => {
  it('folds decisions and results into their tool call (collapsed I/O)', () => {
    const items = buildTimeline([
      ev('run.queued', {
        prompt: 'Reply to Ada',
        trigger: { kind: 'manual', source: null },
        priority: 0,
        fixture: null,
      }),
      ev('run.started', {
        driver: 'mock',
        authMethod: 'mock',
        model: null,
        cwd: '/w',
        resumeSessionId: null,
      }),
      ev('tool.call', {
        toolUseId: 't1',
        name: 'Edit',
        input: { file_path: '/w/a.txt', old_string: 'a\n', new_string: 'b\n' },
        parentToolUseId: null,
      }),
      ev('permission.decision', {
        toolUseId: 't1',
        toolName: 'Edit',
        input: {},
        behavior: 'allow',
        reason: 'ok',
        tier: 'WRITE_LOCAL',
        ruleId: null,
        approvalId: null,
      }),
      ev('tool.result', {
        toolUseId: 't1',
        isError: false,
        content: 'done',
        truncated: false,
        parentToolUseId: null,
      }),
      ev('tool.call', {
        toolUseId: 't2',
        name: 'mcp__gmail__send_email',
        input: { to: 'ada@example.com', subject: 'Hi' },
        parentToolUseId: null,
      }),
      ev('permission.decision', {
        toolUseId: 't2',
        toolName: 'x',
        input: {},
        behavior: 'deny',
        reason: "Waiting for your owner's approval (apr_1).",
        tier: 'EXTERNAL',
        ruleId: null,
        approvalId: 'apr_1',
      }),
      ev('run.parked', { approvalIds: ['apr_1'], sessionId: null }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['prompt', 'note', 'tool', 'tool', 'note']);
    const edit = items[2];
    expect(edit?.kind === 'tool' && edit.summary).toBe('a.txt');
    expect(edit?.kind === 'tool' && edit.result?.content).toBe('done');
    expect(edit?.kind === 'tool' && edit.diff?.map((l) => l.kind)).toEqual(['del', 'add']);
    const send = items[3];
    expect(send?.kind === 'tool' && send.decision?.held).toBe(true);
    expect(send?.kind === 'tool' && send.summary).toBe('→ ada@example.com · Hi');
  });

  it('indents subagent work and builds the subagent tree', () => {
    const events = [
      ev('tool.call', {
        toolUseId: 'task1',
        name: 'Task',
        input: { description: 'research' },
        parentToolUseId: null,
      }),
      ev('subagent.started', {
        toolUseId: 'task1',
        agentType: 'researcher',
        description: 'look things up',
        parentToolUseId: null,
      }),
      ev('message.assistant', { messageId: null, text: 'inner', parentToolUseId: 'task1' }),
      ev('subagent.stopped', { toolUseId: 'task1', isError: false }),
    ];
    const items = buildTimeline(events);
    const inner = items.find((i) => i.kind === 'message');
    expect(inner?.kind === 'message' && inner.depth).toBe(1);
    expect(subagentTree(events)).toEqual([
      {
        toolUseId: 'task1',
        label: 'researcher — look things up',
        done: true,
        error: false,
        children: [],
      },
    ]);
  });

  it('neutralises control and bidi characters in model text', () => {
    const items = buildTimeline([
      ev('message.assistant', { messageId: null, text: 'ok‮evil\u001b[2J', parentToolUseId: null }),
    ]);
    expect(items[0]?.kind === 'message' && items[0].text).toBe('ok�evil�[2J');
  });

  it('summarizes common tool inputs', () => {
    expect(summarizeToolInput({ command: 'ls   -la' }, null)).toBe('ls -la');
    expect(summarizeToolInput({ url: 'https://x.test' }, null)).toBe('https://x.test');
    expect(summarizeToolInput({ file_path: '/w/sub/f' }, '/w')).toBe('sub/f');
    expect(summarizeToolInput('x', null)).toBe('');
  });
});

describe('M6 events in the timeline', () => {
  it('shows delegation with links to the child Run, memory and summaries', async () => {
    const { teamEvents } = await import('../stories/fixtures');
    const notes = buildTimeline(teamEvents).flatMap((i) => (i.kind === 'note' ? [i] : []));
    const text = notes.map((n) => n.text);
    expect(text).toEqual(
      expect.arrayContaining([
        '2 memories offered as context',
        'Delegated to Researcher',
        'Paused until the delegated Run answers; it resumes by itself',
        'Delegated Run answered (untrusted data for this Run)',
        'Memory note saved (untrusted)',
        'Summarized by haiku · 1.8k in / 90 out · ~$0.0021',
      ]),
    );
    const delegated = notes.find((n) => n.text === 'Delegated to Researcher');
    expect(delegated?.runId).toBe('run_child0000001');
  });
});
