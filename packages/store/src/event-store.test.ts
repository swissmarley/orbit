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
});
