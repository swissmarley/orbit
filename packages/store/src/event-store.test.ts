import { type RunEventBody, Redactor, event } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OrbitDb, openDatabase } from './db';
import { EventStore } from './event-store';

const run: RunEventBody[] = [
  event('run.queued', { trigger: { kind: 'manual', source: null }, prompt: 'summarize' }),
  event('run.started', {
    driver: 'mock',
    authMethod: 'mock',
    model: 'opus',
    cwd: '/w',
    resumeSessionId: null,
  }),
  event('tool.call', {
    toolUseId: 't1',
    name: 'Read',
    input: { file_path: 'a' },
    parentToolUseId: null,
  }),
  event('tool.result', {
    toolUseId: 't1',
    isError: false,
    content: 'ok',
    truncated: false,
    parentToolUseId: null,
  }),
  event('run.completed', {
    result: 'done',
    stopReason: 'end_turn',
    sessionId: 's',
    permissionDenials: [],
  }),
];

describe('EventStore', () => {
  let db: OrbitDb;
  let store: EventStore;
  let clock = 0;

  beforeEach(() => {
    db = openDatabase(':memory:');
    clock = 0;
    store = new EventStore(db, new Redactor(['run-token-abcdef']), {
      now: () => new Date(Date.UTC(2026, 9, 4, 12, 0, clock++)),
    });
  });
  afterEach(() => db.close());

  it('assigns per-run seq and global ids, and maintains the projection', () => {
    const a = store.append('run_a', 'bot_1', run.slice(0, 2));
    const b = store.append('run_b', 'bot_1', run.slice(0, 1));
    const a2 = store.append('run_a', 'bot_1', run.slice(2));
    expect(a.map((e) => e.seq)).toEqual([1, 2]);
    expect(a2.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(b[0]!.seq).toBe(1);
    const ids = [...a, ...b, ...a2].map((e) => e.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(store.getRun('run_a')?.status).toBe('completed');
    expect(store.getRun('run_b')?.status).toBe('queued');
  });

  it('rejects invalid event bodies atomically', () => {
    const bad = { type: 'tool.call', data: { name: 'x' } } as unknown as RunEventBody;
    expect(() => store.append('run_a', 'bot_1', [run[0]!, bad])).toThrow();
    expect(store.listRunEvents('run_a')).toEqual([]);
    expect(store.getRun('run_a')).toBeUndefined();
  });

  it('refuses to attach events to a run of another bot', () => {
    store.append('run_a', 'bot_1', run.slice(0, 1));
    expect(() => store.append('run_a', 'bot_2', run.slice(1, 2))).toThrow(/belongs to bot/);
  });

  it('is append-only at the database level', () => {
    store.append('run_a', 'bot_1', run);
    expect(() => db.sqlite.prepare("UPDATE events SET type = 'x'").run()).toThrow(/append-only/);
    expect(() => db.sqlite.prepare('DELETE FROM events').run()).toThrow(/append-only/);
    expect(store.listRunEvents('run_a')).toHaveLength(5);
  });

  it('redacts secrets before they are persisted', () => {
    store.append('run_a', 'bot_1', [
      event('tool.call', {
        toolUseId: 't9',
        name: 'Bash',
        input: { command: 'curl -H "x-api-key: sk-ant-api03-SECRETSECRETSECRET" https://x' },
        parentToolUseId: null,
      }),
      event('message.assistant', {
        messageId: null,
        text: 'the hook token is run-token-abcdef',
        parentToolUseId: null,
      }),
    ]);
    const raw = (db.sqlite.prepare('SELECT data FROM events').all() as { data: string }[])
      .map((r) => r.data)
      .join('\n');
    expect(raw).not.toContain('SECRETSECRET');
    expect(raw).not.toContain('run-token-abcdef');
    expect(raw).toContain('[REDACTED:');
  });

  it('replay from the log equals the stored projection; rebuild restores it', () => {
    store.append('run_a', 'bot_1', run.slice(0, 3));
    store.append('run_a', 'bot_1', run.slice(3));
    const stored = store.getRun('run_a');
    expect(store.replay('run_a')).toEqual(stored);
    db.sqlite.prepare('DELETE FROM runs').run();
    expect(store.getRun('run_a')).toBeUndefined();
    expect(store.rebuildProjections()).toBe(1);
    expect(store.getRun('run_a')).toEqual(stored);
  });

  it('supports Last-Event-ID style resume and listener fan-out', () => {
    const seen: number[] = [];
    const off = store.subscribe((e) => seen.push(e.id));
    const first = store.append('run_a', 'bot_1', run.slice(0, 2));
    off();
    store.append('run_a', 'bot_1', run.slice(2));
    expect(seen).toEqual(first.map((e) => e.id));
    const after = store.listEventsAfter(first[1]!.id);
    expect(after.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(store.listRunEvents('run_a', { afterSeq: 4 }).map((e) => e.type)).toEqual([
      'run.completed',
    ]);
  });

  it('lists runs newest first, filterable by bot', () => {
    store.append('run_a', 'bot_1', run.slice(0, 1));
    store.append('run_b', 'bot_2', run.slice(0, 1));
    expect(store.listRuns().map((r) => r.runId)).toEqual(['run_b', 'run_a']);
    expect(store.listRuns({ botId: 'bot_1' }).map((r) => r.runId)).toEqual(['run_a']);
  });

  it('lists the turns of a conversation (ADR-020) and keeps the column on rebuild', () => {
    const turn = (conversationId: string | null, continuesRunId: string | null) =>
      event('run.queued', {
        trigger: { kind: 'manual', source: null },
        prompt: 'more',
        conversationId,
        continuesRunId,
      });
    store.append('run_a', 'bot_1', [turn(null, null)]);
    store.append('run_b', 'bot_1', [turn('run_a', 'run_a')]);
    store.append('run_c', 'bot_1', [turn(null, null)]);
    const ids = () =>
      store
        .listRuns({ conversationId: 'run_a' })
        .map((r) => r.runId)
        .sort();
    expect(ids()).toEqual(['run_a', 'run_b']);
    expect(store.listRuns({ conversationId: 'run_c' }).map((r) => r.runId)).toEqual(['run_c']);
    store.rebuildProjections();
    expect(ids()).toEqual(['run_a', 'run_b']);
  });

  it("lists a Bot's latest events of some types, newest first", () => {
    store.append('run_a', 'bot_1', run);
    store.append('run_b', 'bot_2', run);
    const got = store.listBotEvents('bot_1', ['run.started', 'run.completed'], 10);
    expect(got.map((e) => [e.runId, e.type])).toEqual([
      ['run_a', 'run.completed'],
      ['run_a', 'run.started'],
    ]);
    expect(
      store.listBotEvents('bot_1', ['run.queued', 'run.started', 'run.completed'], 1),
    ).toHaveLength(1);
    const started = got[1]?.id ?? 0;
    expect(
      store
        .listBotEvents('bot_1', ['run.started', 'run.completed'], 10, started)
        .map((e) => e.type),
    ).toEqual(['run.completed', 'run.started']);
    expect(store.listBotEvents('bot_1', ['run.started'], 10, started + 1)).toEqual([]);
  });

  it('compare-and-set append refuses a stale writer and writes nothing', () => {
    const first = store.append('run_a', 'bot_1', run.slice(0, 2), { expectSeq: 0 });
    expect(first).toHaveLength(2);
    expect(() => store.append('run_a', 'bot_1', run.slice(0, 1), { expectSeq: 0 })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(() => store.append('run_a', 'bot_1', run.slice(2, 3), { expectSeq: 1 })).toThrow(
      /changed concurrently/,
    );
    expect(store.listRunEvents('run_a')).toHaveLength(2);
    store.append('run_a', 'bot_1', run.slice(2, 3), { expectSeq: 2 });
    expect(store.getRun('run_a')?.lastSeq).toBe(3);
  });

  it('filters runs by status and the feed by run or bot', () => {
    store.append('run_a', 'bot_1', run);
    store.append('run_b', 'bot_2', run.slice(0, 1));
    expect(store.listRuns({ status: ['queued'] }).map((r) => r.runId)).toEqual(['run_b']);
    expect(store.listRuns({ status: ['completed', 'queued'] })).toHaveLength(2);
    expect(store.listEventsAfter(0, 100, { runId: 'run_b' }).map((e) => e.runId)).toEqual([
      'run_b',
    ]);
    expect(store.listEventsAfter(0, 100, { botId: 'bot_1' })).toHaveLength(5);
    expect(store.lastEventId()).toBe(6);
  });

  it('normalizes projections stored before newer fields existed', () => {
    store.append('run_a', 'bot_1', run.slice(0, 1));
    const row = db.sqlite.prepare('SELECT state FROM runs').get() as { state: string };
    const old = JSON.parse(row.state) as Record<string, unknown>;
    delete old.resumeAt;
    delete old.priority;
    db.sqlite.prepare('UPDATE runs SET state = ?').run(JSON.stringify(old));
    expect(store.getRun('run_a')).toMatchObject({ resumeAt: null, priority: 0 });
    store.append('run_a', 'bot_1', run.slice(1, 2));
    expect(store.getRun('run_a')).toMatchObject({ resumeAt: null, status: 'running' });
  });
});
