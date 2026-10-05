import type { RunEvent } from '@orbit/core/browser';
import { describe, expect, it } from 'vitest';
import { takeTicketFromLocation } from './api';
import { appendEvent, staleKeysFor } from './live';
import { keys } from './queries';

const e = (seq: number, type = 'message.assistant'): RunEvent =>
  ({ id: seq + 100, runId: 'r', botId: 'b', seq, ts: '', type, data: {} }) as unknown as RunEvent;

describe('live feed', () => {
  it('appends each event once, in order, and only to loaded logs', () => {
    expect(appendEvent(undefined, e(1))).toBeUndefined();
    const one = appendEvent([e(1)], e(2));
    expect(one?.map((x) => x.seq)).toEqual([1, 2]);
    expect(appendEvent(one, e(2))).toBe(one);
    expect(appendEvent(one, e(1))).toBe(one);
  });

  it('invalidates what an event changes', () => {
    expect(staleKeysFor(e(1, 'approval.requested'))).toContainEqual(keys.approvals);
    expect(staleKeysFor(e(1, 'run.completed'))).toContainEqual(keys.runs);
    expect(staleKeysFor(e(1, 'run.killed'))).toContainEqual(keys.kill);
    expect(staleKeysFor(e(1, 'message.assistant'))).toEqual([keys.run('r')]);
  });
});

describe('sign-in ticket', () => {
  it('reads the ticket from the fragment and removes it from the address bar', () => {
    history.replaceState(null, '', '/login?x=1#ticket=abcdefghijklmnop-_0123');
    expect(takeTicketFromLocation(location, history)).toBe('abcdefghijklmnop-_0123');
    expect(location.hash).toBe('');
    expect(location.pathname + location.search).toBe('/login?x=1');
    expect(takeTicketFromLocation(location, history)).toBeNull();
  });
});
