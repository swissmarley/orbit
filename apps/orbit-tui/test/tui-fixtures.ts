import {
  Bot,
  type MemoryHit,
  type PluginStatus,
  type RunEvent,
  type RunEventBody,
  type RunState,
  replayRun,
} from '@orbit/core';
import type { Approval } from '@orbit/sdk-client';
import { vi } from 'vitest';
import type { TuiClient } from '../src/tui/feed';
import { type Data, EMPTY_DATA } from '../src/tui/model';

/** Deterministic TUI test data (fixed ids and times, no locale-dependent output). */
const T = '2026-10-04T09:15:00.000Z';

export function bot(id: string, name: string, pausedAt: string | null = null): Bot {
  return Bot.parse({
    id,
    version: 1,
    spec: { name, goal: `${name} goal` },
    pausedAt,
    createdAt: T,
    updatedAt: T,
  });
}

let seq = 0;
export function events(runId: string, botId: string, bodies: RunEventBody[]): RunEvent[] {
  return bodies.map((b, i) => ({
    id: ++seq,
    runId,
    botId,
    seq: i + 1,
    ts: T,
    ...b,
  }));
}

export const mailerEvents = (runId: string, botId: string) =>
  events(runId, botId, [
    {
      type: 'run.queued',
      data: {
        trigger: { kind: 'manual', source: null },
        prompt: 'Reply to Ada',
        priority: 10,
        fixture: null,
        parentRunId: null,
        depth: 0,
        inheritedTaint: [],
        budgetCap: null,
        conversationId: null,
        continuesRunId: null,
      },
    },
    {
      type: 'run.started',
      data: { driver: 'mock', authMethod: 'mock', model: 'opus', cwd: '/w', resumeSessionId: null },
    },
    {
      type: 'message.assistant',
      data: { messageId: null, text: 'I drafted the reply to Ada.', parentToolUseId: null },
    },
    {
      type: 'tool.call',
      data: {
        toolUseId: 't1',
        name: 'mcp__gmail__send_email',
        input: { to: 'ada@example.com' },
        parentToolUseId: null,
      },
    },
    {
      type: 'approval.requested',
      data: {
        approvalId: 'apr_1',
        toolUseId: 't1',
        toolName: 'mcp__gmail__send_email',
        tier: 'EXTERNAL',
        summary: 'send email (gmail) → ada@example.com',
      },
    },
    { type: 'run.parked', data: { approvalIds: ['apr_1'], sessionId: 's1', delegations: [] } },
  ]);

export function run(runId: string, botId: string, status: RunState['status']): RunState {
  const s = replayRun(
    events(runId, botId, [
      {
        type: 'run.queued',
        data: {
          trigger: { kind: 'manual', source: null },
          prompt: 'p',
          priority: 10,
          fixture: null,
          parentRunId: null,
          depth: 0,
          inheritedTaint: [],
          budgetCap: null,
          conversationId: null,
          continuesRunId: null,
        },
      },
    ]),
  )!;
  return { ...s, status, createdAt: T };
}

export function approval(id: string, over: Partial<Approval['card']> = {}): Approval {
  return {
    id,
    runId: 'run_a2',
    botId: 'bot_a',
    toolUseId: 't1',
    toolName: 'mcp__gmail__send_email',
    input: { to: 'ada@example.com', subject: 'Tuesday' },
    inputHash: 'h',
    tier: 'EXTERNAL',
    card: {
      what: 'send email (gmail) → ada@example.com',
      why: 'I drafted the reply to Ada and will send it now.',
      toolName: 'mcp__gmail__send_email',
      tier: 'EXTERNAL',
      payload: { to: 'ada@example.com', subject: 'Tuesday' },
      diff: null,
      botId: 'bot_a',
      botName: 'Mailer',
      runId: 'run_a2',
      delegatedBy: null,
      untrusted: [],
      risk: 'Has effects outside the sandbox.',
      ...over,
    },
    status: 'pending',
    decision: null,
    createdAt: T,
    decidedAt: null,
    expiresAt: null,
  };
}

export function memory(id: string, over: Partial<MemoryHit> = {}): MemoryHit {
  return {
    id,
    botId: 'bot_a',
    kind: 'note',
    source: 'bot',
    title: `Note ${id}`,
    body: 'Ada owns the launch.\nIt opens Tuesday.',
    taint: [],
    runId: 'run_a1',
    approvalId: null,
    signal: null,
    pinned: false,
    createdBy: 'bot:bot_a',
    createdAt: T,
    updatedAt: T,
    editedAt: null,
    snippet: '',
    rank: 0,
    ...over,
  };
}

export function plugin(id: string, over: Partial<PluginStatus> = {}): PluginStatus {
  return {
    id,
    name: id === 'github' ? 'GitHub' : 'Filesystem',
    version: '0.1.0',
    description: 'A reference plugin',
    homepage: null,
    builtIn: true,
    source: { kind: 'builtin', package: null, version: null, integrity: null },
    dir: `/orbit/plugins/${id}`,
    enabled: false,
    state: 'disabled',
    server: 'stdio: node --import tsx server.ts',
    tools: [
      {
        name: 'list_issues',
        engineName: `mcp__${id}__list_issues`,
        description: 'List issues',
        declaredTier: 'READ',
        tier: 'READ',
        egress: false,
        available: null,
      },
      {
        name: 'git_push',
        engineName: `mcp__${id}__git_push`,
        description: 'Push',
        declaredTier: 'EXTERNAL',
        tier: 'EXTERNAL',
        egress: false,
        available: null,
      },
    ],
    secrets: [
      {
        name: 'GITHUB_TOKEN',
        description: 'token',
        required: false,
        set: false,
        vaultName: `plugin_${id}_GITHUB_TOKEN`,
      },
    ],
    settings: [],
    env: [],
    sandbox: {
      state: 'sandboxed',
      engine: 'bwrap',
      reason: null,
      needs: { workspace: 'none', network: true, paths: [], nestedSandbox: false },
    },
    undeclaredTools: [],
    bots: [],
    warnings: [],
    error: null,
    checkedAt: null,
    enabledAt: null,
    ...over,
  };
}

export const plugins = (): PluginStatus[] => [
  plugin('github', { enabled: true, state: 'ready', bots: [{ id: 'bot_a', name: 'Mailer' }] }),
  plugin('filesystem'),
];

export const inbound = () => [
  {
    botId: 'bot_a',
    botName: 'Mailer',
    key: 'bot_a:1',
    kind: 'webhook' as const,
    description: 'deploys',
    enabled: true,
    state: 'needs_setup' as const,
    detail: 'no signing secret yet',
    path: '/hooks/bot_a/deploys',
    url: null,
  },
];

export const memories = (): MemoryHit[] => [
  memory('mem_1', { title: 'Launch owner' }),
  memory('mem_2', { title: 'Rumour from a web page', taint: ['WebFetch'] }),
  memory('mem_3', { title: 'Owner disliked a result', kind: 'feedback', source: 'feedback' }),
];

export function data(over: Partial<Data> = {}): Data {
  return {
    ...EMPTY_DATA,
    bots: [bot('bot_a', 'Mailer'), bot('bot_b', 'Notes'), bot('bot_c', 'Digest', T)],
    runs: [
      run('run_a2', 'bot_a', 'waiting_approval'),
      run('run_b1', 'bot_b', 'completed'),
      run('run_a1', 'bot_a', 'completed'),
    ],
    approvals: [approval('apr_1')],
    kill: { engaged: false, by: null },
    connected: true,
    ...over,
  };
}

/** A fake orbitd client over `data()`; `push` feeds the live event stream. */
export function fakeClient(
  d: Data = data(),
  timeline: RunEvent[] = mailerEvents('run_a2', 'bot_a'),
) {
  const live: RunEvent[] = [];
  let wake: (() => void) | null = null;
  let setupDoctor = {
    driver: 'mock',
    authLabel: 'Demo mode',
    warnings: [],
    ok: true,
    models: { default: 'sonnet', triage: 'haiku' },
    apiCredential: null as string | null,
  };
  let apiKeyStored = false;
  const client = {
    doctor: vi.fn(() => Promise.resolve(setupDoctor as never)),
    call: vi.fn(
      (name: string, args?: { body?: { mode: string; model: string; apiKey?: string } }) => {
        if (name === 'configureSetup' && args?.body) {
          const body = args.body;
          apiKeyStored ||= Boolean(body.apiKey);
          setupDoctor = {
            ...setupDoctor,
            driver: body.mode === 'demo' ? 'mock' : body.mode === 'api' ? 'sdk' : 'cli',
            authLabel: body.mode === 'demo' ? 'Demo mode' : 'Anthropic API key',
            models: { default: body.model, triage: 'haiku' },
            apiCredential: body.mode === 'api' ? 'api_key' : null,
          };
        }
        return Promise.resolve({
          doctor: setupDoctor,
          apiKeyStored,
          canConfigure: true,
          reason: null,
        });
      },
    ),
    bots: {
      list: vi.fn(() => Promise.resolve(d.bots)),
      pause: vi.fn((id: string) =>
        Promise.resolve({ ...d.bots.find((b) => b.id === id)!, pausedAt: T }),
      ),
      resume: vi.fn((id: string) =>
        Promise.resolve({ ...d.bots.find((b) => b.id === id)!, pausedAt: null }),
      ),
    },
    runs: {
      list: vi.fn(() => Promise.resolve(d.runs)),
      events: vi.fn((runId: string) => Promise.resolve(timeline.filter((e) => e.runId === runId))),
      start: vi.fn((botId: string) => Promise.resolve(run('run_new', botId, 'queued'))),
      stop: vi.fn((runId: string) => Promise.resolve(run(runId, 'bot_a', 'cancelled'))),
      pause: vi.fn((runId: string) => Promise.resolve(run(runId, 'bot_a', 'running'))),
      resume: vi.fn((runId: string) => Promise.resolve(run(runId, 'bot_a', 'queued'))),
      tree: vi.fn((runId: string) => {
        const parent = {
          ...run('run_a1', 'bot_a', 'completed'),
          children: [
            { runId: 'run_b1', botId: 'bot_b', botName: 'Notes', status: 'completed' as const },
          ],
        };
        const child = { ...run('run_b1', 'bot_b', 'completed'), parentRunId: 'run_a1', depth: 1 };
        return Promise.resolve(
          runId === 'run_a1' || runId === 'run_b1'
            ? { root: 'run_a1', runs: [parent, child] }
            : { root: runId, runs: [run(runId, 'bot_a', 'completed')] },
        );
      }),
      feedback: vi.fn(() =>
        Promise.resolve(memory('mem_fb', { kind: 'feedback', source: 'feedback' })),
      ),
    },
    memory: {
      list: vi.fn(() => Promise.resolve(memories())),
      update: vi.fn((id: string, patch: Record<string, unknown>) =>
        Promise.resolve({ ...memory(id), ...patch }),
      ),
      remove: vi.fn(() => Promise.resolve({ ok: true as const })),
    },
    plugins: {
      list: vi.fn(() => Promise.resolve(plugins())),
      enable: vi.fn((id: string) => Promise.resolve(plugin(id, { enabled: true, state: 'ready' }))),
      disable: vi.fn((id: string) => Promise.resolve(plugin(id))),
    },
    triggers: {
      list: vi.fn(() => Promise.resolve(inbound())),
    },
    approvals: {
      list: vi.fn(() => Promise.resolve(d.approvals)),
      approve: vi.fn((id: string) =>
        Promise.resolve({
          approval: { ...approval(id), status: 'approved' as const },
          resumed: true,
          run: null,
        }),
      ),
      deny: vi.fn((id: string) =>
        Promise.resolve({
          approval: { ...approval(id), status: 'denied' as const },
          resumed: false,
          run: null,
        }),
      ),
    },
    kill: {
      status: vi.fn(() => Promise.resolve(d.kill ?? { engaged: false, by: null })),
      set: vi.fn((on: boolean) => Promise.resolve({ engaged: on, by: on ? 'owner' : null })),
    },
    queue: vi.fn(() => Promise.resolve({ limit: 2, pausedUntil: null, active: [], queued: [] })),
    events: vi.fn(async function* (opts: { signal?: AbortSignal }) {
      while (!opts.signal?.aborted) {
        const e = live.shift();
        if (e) {
          yield e;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          opts.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    }),
  };
  return {
    client: client as unknown as TuiClient,
    mock: client,
    push(e: RunEvent) {
      live.push(e);
      wake?.();
    },
  };
}
