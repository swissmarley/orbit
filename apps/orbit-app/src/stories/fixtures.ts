import type { RunEvent } from '@orbit/core/browser';
import type { Approval } from '@orbit/sdk-client/browser';

const T = '2026-10-05T09:15:00.000Z';

export const approval: Approval = {
  id: 'apr_demo',
  runId: 'run_demo',
  botId: 'bot_demo',
  toolUseId: 't2',
  toolName: 'mcp__gmail__send_email',
  input: {
    to: 'ada@example.com',
    subject: 'Launch window',
    body: 'Confirmed: we launch Tuesday at 09:00 UTC.',
  },
  inputHash: 'x',
  tier: 'EXTERNAL',
  card: {
    what: 'send email (gmail) → ada@example.com',
    why: 'I drafted the reply to Ada and will send it now.',
    toolName: 'mcp__gmail__send_email',
    tier: 'EXTERNAL',
    payload: {
      to: 'ada@example.com',
      subject: 'Launch window',
      body: 'Confirmed: we launch Tuesday at 09:00 UTC.',
    },
    diff: null,
    botId: 'bot_demo',
    botName: 'Mailer',
    runId: 'run_demo',
    delegatedBy: null,
    untrusted: [],
    risk: 'Has effects outside the sandbox (sends, posts, merges, deletes or contacts other systems).',
  },
  status: 'pending',
  decision: null,
  createdAt: T,
  decidedAt: null,
  expiresAt: '2026-10-08T09:15:00.000Z',
};

export const tainted: Approval = {
  ...approval,
  id: 'apr_tainted',
  card: { ...approval.card, untrusted: ['WebFetch https://news.example.com'] },
};

export const withDiff: Approval = {
  ...approval,
  id: 'apr_diff',
  toolName: 'mcp__github__create_pull_request',
  card: {
    ...approval.card,
    what: 'open a pull request (github)',
    diff: '--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n # Orbit\n-Old line\n+New line\n context\n',
  },
};

let id = 0;
const ev = (type: string, data: Record<string, unknown>): RunEvent =>
  ({ id: ++id, runId: 'run_demo', botId: 'bot_demo', seq: id, ts: T, type, data }) as RunEvent;

export const runEvents: RunEvent[] = [
  ev('run.queued', {
    prompt: 'Reply to Ada about Tuesday',
    trigger: { kind: 'manual', source: null },
    priority: 10,
    fixture: null,
  }),
  ev('run.started', {
    driver: 'mock',
    authMethod: 'mock',
    model: 'opus',
    cwd: '/w',
    resumeSessionId: null,
  }),
  ev('message.assistant', {
    messageId: null,
    text: 'I will read the thread, then draft a reply.',
    parentToolUseId: null,
  }),
  ev('tool.call', {
    toolUseId: 't1',
    name: 'Edit',
    input: {
      file_path: '/w/draft.md',
      old_string: 'Hi Ada,\nTBD\n',
      new_string: 'Hi Ada,\nTuesday 09:00 UTC works.\n',
    },
    parentToolUseId: null,
  }),
  ev('permission.decision', {
    toolUseId: 't1',
    toolName: 'Edit',
    input: {},
    behavior: 'allow',
    reason: 'inside the workspace',
    tier: 'WRITE_LOCAL',
    ruleId: null,
    approvalId: null,
  }),
  ev('tool.result', {
    toolUseId: 't1',
    isError: false,
    content: 'Updated draft.md',
    truncated: false,
    parentToolUseId: null,
  }),
  ev('tool.call', {
    toolUseId: 't2',
    name: 'mcp__gmail__send_email',
    input: approval.input,
    parentToolUseId: null,
  }),
  ev('permission.decision', {
    toolUseId: 't2',
    toolName: 'mcp__gmail__send_email',
    input: {},
    behavior: 'deny',
    reason: "Waiting for your owner's approval (apr_demo).",
    tier: 'EXTERNAL',
    ruleId: null,
    approvalId: 'apr_demo',
  }),
  ev('approval.requested', {
    approvalId: 'apr_demo',
    toolUseId: 't2',
    toolName: 'mcp__gmail__send_email',
    tier: 'EXTERNAL',
    summary: 'send email (gmail) → ada@example.com',
  }),
  ev('run.parked', { approvalIds: ['apr_demo'], sessionId: null }),
];

/** A Run that delegated to a peer Bot and saved memory (M6). */
export const teamEvents: RunEvent[] = [
  ev('run.queued', {
    prompt: 'Find out who owns the launch and note it',
    trigger: { kind: 'manual', source: null },
    priority: 10,
    fixture: null,
  }),
  ev('memory.recalled', { memoryIds: ['mem_a', 'mem_b'], via: 'context', tainted: false }),
  ev('message.assistant', {
    messageId: null,
    text: "I'll ask the Researcher Bot to look through the shared notes.",
    parentToolUseId: null,
  }),
  ev('delegation.started', {
    childRunId: 'run_child0000001',
    childBotId: 'bot_research',
    childBotName: 'Researcher',
    task: 'Find who owns the launch in the shared notes.',
  }),
  ev('run.parked', { approvalIds: [], sessionId: null, delegations: ['run_child0000001'] }),
  ev('delegation.finished', {
    childRunId: 'run_child0000001',
    childBotId: 'bot_research',
    status: 'completed',
    result: 'Ada owns the launch; the window opens Tuesday at 09:00 UTC.',
    totals: { tokens: 1200, costUsd: 0, toolCalls: 2 },
  }),
  ev('run.tainted', { source: 'delegate:Researcher', toolUseId: null }),
  ev('run.resumed', { reason: 'delegation', sessionId: null }),
  ev('memory.written', {
    memoryId: 'mem_c',
    kind: 'note',
    source: 'bot',
    title: 'Launch owner',
    tainted: true,
  }),
  ev('run.completed', {
    result: 'Ada owns the launch.',
    stopReason: 'end_turn',
    sessionId: null,
    permissionDenials: [],
  }),
  ev('memory.summarized', {
    memoryId: 'mem_d',
    mode: 'triage',
    model: 'haiku',
    inputTokens: 1800,
    outputTokens: 90,
    costUsd: 0.0021,
    error: null,
  }),
];
