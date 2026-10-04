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
      'message.assistant',
      'tool.call',
      'hook',
      'tool.result',
      'tool.call',
      'hook',
      'tool.result',
      'message.assistant',
      'status.summary',
      'usage',
      'run.completed',
    ]);
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
