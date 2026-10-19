import {
  type RunEvent,
  type RunEventBody,
  type RunEventInputOf,
  type RunEventType,
  event,
  replayRun,
} from '@orbit/core/browser';
import { describe, expect, it } from 'vitest';
import {
  type ChatItem,
  buildConversation,
  composerState,
  conversationsOf,
  describeTool,
  turnActivity,
  turnVia,
} from './conversation';

let id = 0;
function log(runId: string, bodies: RunEventBody[], start = Date.UTC(2026, 9, 19, 9)): RunEvent[] {
  return bodies.map((b, i) => {
    id += 1;
    return {
      id,
      runId,
      botId: 'bot_1',
      seq: i + 1,
      ts: new Date(start + i * 1000).toISOString(),
      ...b,
    };
  });
}
const e = <T extends RunEventType>(type: T, data: RunEventInputOf<T>['data']) => event(type, data);
const queued = (prompt: string, extra: Partial<RunEventInputOf<'run.queued'>['data']> = {}) =>
  e('run.queued', { trigger: { kind: 'manual', source: null }, prompt, ...extra });
const started = e('run.started', {
  driver: 'mock',
  authMethod: 'mock',
  model: null,
  cwd: '/ws',
  resumeSessionId: null,
});
const call = (
  toolUseId: string,
  name: string,
  input: unknown,
  parentToolUseId: string | null = null,
) => e('tool.call', { toolUseId, name, input, parentToolUseId });
const allow = (toolUseId: string, toolName: string, tier: 'READ' | 'WRITE_LOCAL' = 'READ') =>
  e('permission.decision', {
    toolUseId,
    toolName,
    input: {},
    behavior: 'allow',
    reason: 'ok',
    tier,
  });
const result = (toolUseId: string, content: string, isError = false) =>
  e('tool.result', { toolUseId, isError, content, truncated: false, parentToolUseId: null });
const say = (text: string, parentToolUseId: string | null = null) =>
  e('message.assistant', { messageId: null, text, parentToolUseId });
const done = (text: string) =>
  e('run.completed', {
    result: text,
    stopReason: 'end_turn',
    sessionId: 's1',
    permissionDenials: [],
  });

function turn(runId: string, bodies: RunEventBody[], start?: number) {
  const events = log(runId, bodies, start);
  const run = replayRun(events);
  if (!run) throw new Error('no run');
  return { run, events };
}

const kinds = (items: ChatItem[]) => items.map((i) => i.kind);

describe('describeTool', () => {
  it('names what a Bot does in plain words and picks the computer tab', () => {
    expect(describeTool('Bash')).toMatchObject({
      kind: 'terminal',
      label: 'Running a command',
      tab: 'terminal',
    });
    expect(describeTool('Write')).toMatchObject({
      kind: 'write',
      label: 'Saving a file',
      tab: 'files',
    });
    expect(describeTool('Read')).toMatchObject({ kind: 'read', quiet: true });
    expect(describeTool('WebFetch')).toMatchObject({ kind: 'web', tab: 'browser' });
    expect(describeTool('mcp__browser__open_page')).toMatchObject({
      kind: 'browser',
      label: 'Opening a website',
    });
    expect(describeTool('mcp__orbit__delegate_to_bot', { bot: 'Writer' })).toMatchObject({
      kind: 'delegate',
      label: 'Asking Writer',
    });
    expect(describeTool('mcp__gmail__send_email')).toMatchObject({
      kind: 'plugin',
      label: 'Gmail: send email',
    });
    expect(describeTool('Frobnicate')).toMatchObject({ kind: 'other', label: 'Using Frobnicate' });
  });
});

describe('buildConversation', () => {
  it('the owner says something, the Bot works and answers', () => {
    const t = turn('run_1', [
      queued('Save a note about Ada'),
      started,
      say('On it.'),
      call('t1', 'Write', { file_path: '/ws/notes/ada.md', content: 'Ada' }),
      allow('t1', 'Write', 'WRITE_LOCAL'),
      result('t1', 'File created'),
      say('Saved it to notes/ada.md.'),
      done('Saved it to notes/ada.md.'),
    ]);
    const items = buildConversation([t]);
    expect(kinds(items)).toEqual(['user', 'assistant', 'tool', 'assistant', 'end']);
    expect(items[0]).toMatchObject({ text: 'Save a note about Ada', via: null });
    const tool = items[2];
    expect(tool?.kind === 'tool' && tool.tool).toMatchObject({
      detail: 'notes/ada.md',
      state: 'done',
      tier: 'WRITE_LOCAL',
      info: { kind: 'write' },
    });
  });

  it('the final result is shown only when it is not the last thing the Bot said', () => {
    const same = buildConversation([
      turn('run_1', [queued('hi'), started, say('Hello!'), done('Hello!')]),
    ]);
    expect(kinds(same)).toEqual(['user', 'assistant', 'end']);
    const extra = buildConversation([
      turn('run_2', [queued('hi'), started, done('Done (demo mode).')]),
    ]);
    expect(extra[1]).toMatchObject({ kind: 'assistant', text: 'Done (demo mode).' });
  });

  it('a held call becomes an approval in the chat; the decision is recorded', () => {
    const items = buildConversation([
      turn('run_1', [
        queued('Reply to Ada'),
        started,
        call('t1', 'mcp__gmail__send_email', { to: 'ada@example.com' }),
        e('approval.requested', {
          approvalId: 'apr_1',
          toolUseId: 't1',
          toolName: 'mcp__gmail__send_email',
          tier: 'EXTERNAL',
          summary: 'send email (gmail) → ada@example.com',
        }),
        e('permission.decision', {
          toolUseId: 't1',
          toolName: 'mcp__gmail__send_email',
          input: {},
          behavior: 'deny',
          reason: 'Waiting for your owner to decide',
          tier: 'EXTERNAL',
          approvalId: 'apr_1',
        }),
        e('run.parked', { approvalIds: ['apr_1'], sessionId: 's1' }),
      ]),
    ]);
    expect(kinds(items)).toEqual(['user', 'tool', 'approval']);
    const tool = items[1];
    expect(tool?.kind === 'tool' && tool.tool.state).toBe('held');
    expect(items[2]).toMatchObject({ approvalId: 'apr_1', tier: 'EXTERNAL', decision: null });
  });

  it('a decided request shows on the held call: approved (the Bot retries it) or denied', () => {
    const base = [
      queued('Reply to Ada'),
      started,
      call('t1', 'mcp__gmail__send_email', { to: 'ada@example.com' }),
      e('permission.decision', {
        toolUseId: 't1',
        toolName: 'mcp__gmail__send_email',
        input: {},
        behavior: 'deny',
        reason: 'Waiting for your owner to decide',
        tier: 'EXTERNAL',
        approvalId: 'apr_1',
      }),
      e('approval.requested', {
        approvalId: 'apr_1',
        toolUseId: 't1',
        toolName: 'mcp__gmail__send_email',
        tier: 'EXTERNAL',
        summary: 'send email',
      }),
    ];
    const decided = (decision: 'approved' | 'denied') =>
      buildConversation([
        turn('run_1', [
          ...base,
          e('approval.decided', {
            approvalId: 'apr_1',
            decision,
            by: 'owner',
            edited: false,
            reason: decision === 'denied' ? 'not now' : null,
            ruleId: null,
          }),
        ]),
      ])[1];
    const yes = decided('approved');
    expect(yes?.kind === 'tool' && yes.tool.state).toBe('approved');
    const no = decided('denied');
    expect(no?.kind === 'tool' && [no.tool.state, no.tool.reason]).toEqual(['denied', 'not now']);
  });

  it('quiet reads in a row fold into one card; a helper keeps its calls inside its card', () => {
    const items = buildConversation([
      turn('run_1', [
        queued('Look around'),
        started,
        call('r1', 'Read', { file_path: '/ws/a.md' }),
        allow('r1', 'Read'),
        result('r1', 'a'),
        call('r2', 'Grep', { pattern: 'TODO' }),
        allow('r2', 'Grep'),
        result('r2', 'none'),
        call('task', 'Task', { description: 'research' }),
        allow('task', 'Task'),
        e('subagent.started', {
          toolUseId: 'task',
          agentType: 'reader',
          description: 'research',
          parentToolUseId: null,
        }),
        call('s1', 'Read', { file_path: '/ws/b.md' }, 'task'),
        say('Found it', 'task'),
        result('task', 'summary'),
        done('All done'),
      ]),
    ]);
    expect(kinds(items)).toEqual(['user', 'group', 'tool', 'assistant', 'end']);
    const group = items[1];
    expect(group?.kind === 'group' && group.tools.map((t) => t.name)).toEqual(['Read', 'Grep']);
    const task = items[2];
    expect(task?.kind === 'tool' && task.tool.children.map((c) => c.name)).toEqual(['Read']);
    expect(task?.kind === 'tool' && task.tool.messages).toBe(1);
  });

  it('notes: untrusted content once, failures with a retry, delegations with the answer', () => {
    const items = buildConversation([
      turn('run_1', [
        queued('Research'),
        started,
        e('run.tainted', { source: 'WebFetch', toolUseId: 't1' }),
        e('run.tainted', { source: 'mcp__browser__open_page', toolUseId: 't2' }),
        e('delegation.started', {
          childRunId: 'run_c',
          childBotId: 'bot_2',
          childBotName: 'Writer',
          task: 'Draft it',
        }),
        e('delegation.finished', {
          childRunId: 'run_c',
          childBotId: 'bot_2',
          status: 'completed',
          result: 'Here is the draft',
          totals: { tokens: 1, costUsd: 0, toolCalls: 0 },
        }),
        e('run.failed', {
          code: 'engine_error',
          message: 'boom',
          retryable: true,
          sessionId: 's1',
        }),
      ]),
    ]);
    expect(kinds(items)).toEqual(['user', 'note', 'delegation', 'note', 'end']);
    expect(items[1]).toMatchObject({ tone: 'warning' });
    expect(items[1]?.kind === 'note' && items[1].text).toMatch(/untrusted/);
    expect(items[2]).toMatchObject({
      childBotName: 'Writer',
      status: 'completed',
      result: 'Here is the draft',
    });
    expect(items[3]).toMatchObject({ tone: 'danger', detail: 'boom', action: 'retry' });
  });

  it('a reply that inherits the taint does not warn again', () => {
    const items = buildConversation([
      turn('run_2', [
        queued('Who owns it?', {
          conversationId: 'run_1',
          continuesRunId: 'run_1',
          inheritedTaint: ['WebFetch'],
        }),
        started,
        e('run.tainted', { source: 'file:notes/page.md', toolUseId: 't1' }),
        say('Ada'),
        done('Ada'),
      ]),
    ]);
    expect(kinds(items)).toEqual(['user', 'assistant', 'end']);
  });

  it('folds events logged before conversations existed', () => {
    const old = log('run_old', [
      {
        type: 'run.queued',
        data: {
          trigger: { kind: 'manual', source: null },
          prompt: 'hi',
          priority: 0,
          fixture: null,
        },
      } as unknown as RunEventBody,
      started,
      done('hello'),
    ]);
    const run = replayRun(old);
    expect(run && kinds(buildConversation([{ run, events: old }]))).toEqual([
      'user',
      'assistant',
      'end',
    ]);
  });

  it('turns follow each other; a triggered turn says how it started', () => {
    const a = turn('run_1', [
      queued('Morning digest', { trigger: { kind: 'cron', source: 'daily' } }),
      started,
      done('Here it is'),
    ]);
    const b = turn(
      'run_2',
      [
        queued('Thanks!', { conversationId: 'run_1', continuesRunId: 'run_1' }),
        started,
        done('Any time'),
      ],
      Date.UTC(2026, 9, 19, 10),
    );
    const items = buildConversation([a, b]);
    expect(items.flatMap((i) => (i.kind === 'user' ? [i.via] : []))).toEqual(['Scheduled', null]);
    expect(turnVia({ kind: 'webhook', source: 'deploys' })).toBe('Webhook · deploys');
  });
});

describe('the sidebar and the composer', () => {
  it('groups Runs into conversations (latest first), leaving delegated Runs to their parent', () => {
    const a1 = turn(
      'run_1',
      [queued('First question'), started, done('x')],
      Date.UTC(2026, 9, 19, 9),
    ).run;
    const a2 = turn(
      'run_2',
      [queued('Follow-up', { conversationId: 'run_1', continuesRunId: 'run_1' })],
      Date.UTC(2026, 9, 19, 11),
    ).run;
    const b = turn(
      'run_3',
      [queued('Other topic'), started, done('y')],
      Date.UTC(2026, 9, 19, 10),
    ).run;
    const child = turn('run_4', [queued('sub', { parentRunId: 'run_3', depth: 1 })]).run;
    const list = conversationsOf([b, a2, child, a1]);
    expect(list.map((c) => [c.id, c.title, c.turns])).toEqual([
      ['run_1', 'First question', 2],
      ['run_3', 'Other topic', 1],
    ]);
    expect(list[0]?.latest.runId).toBe('run_2');
  });

  it('the composer says why it cannot send', () => {
    const bot = { pausedAt: null, spec: { name: 'Scout' } };
    const ended = turn('run_1', [queued('x'), started, done('y')]).run;
    const running = turn('run_2', [queued('x'), started]).run;
    expect(composerState({ bot, latest: ended, killed: false, canStart: true })).toMatchObject({
      canSend: true,
      stoppable: false,
    });
    expect(composerState({ bot, latest: undefined, killed: false, canStart: true }).canSend).toBe(
      true,
    );
    expect(composerState({ bot, latest: running, killed: false, canStart: true })).toMatchObject({
      canSend: false,
      stoppable: true,
    });
    expect(composerState({ bot, latest: ended, killed: true, canStart: true }).hint).toMatch(
      /kill switch/,
    );
    expect(composerState({ bot, latest: ended, killed: false, canStart: false }).hint).toMatch(
      /Viewers/,
    );
    expect(
      composerState({
        bot: { ...bot, pausedAt: '2026-10-19T09:00:00.000Z' },
        latest: ended,
        killed: false,
        canStart: true,
      }).hint,
    ).toMatch(/paused/);
    expect(turnActivity(running, 'Scout')).toEqual({ busy: true, text: 'Scout is working' });
    expect(turnActivity(ended, 'Scout')).toBeNull();
  });
});
