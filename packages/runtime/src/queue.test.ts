import { describe, expect, it } from 'vitest';
import { type QueueJob, RunQueue } from './queue';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(limit = 2, hold: (job: QueueJob) => string | null = () => null) {
  const started: string[] = [];
  const pending = new Map<string, ReturnType<typeof deferred>>();
  const errors: string[] = [];
  let max = limit;
  const queue = new RunQueue({
    concurrency: () => max,
    hold,
    execute: (job) => {
      started.push(job.runId);
      const d = deferred();
      pending.set(job.runId, d);
      return d.promise;
    },
    onError: (job, message) => errors.push(`${job.runId}: ${message}`),
  });
  const finish = async (runId: string) => {
    pending.get(runId)!.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { queue, started, pending, errors, finish, tick, setLimit: (n: number) => (max = n) };
}

const job = (runId: string, priority = 0, kind: QueueJob['kind'] = 'start'): QueueJob => ({
  kind,
  runId,
  botId: 'bot_1',
  priority,
});

describe('RunQueue', () => {
  it('never runs more than the concurrency limit (CLI default 2)', async () => {
    const h = harness(2);
    for (const id of ['a', 'b', 'c', 'd']) h.queue.push(job(id));
    await h.tick();
    expect(h.started).toEqual(['a', 'b']);
    expect(h.queue.snapshot()).toMatchObject({
      limit: 2,
      active: [{ runId: 'a' }, { runId: 'b' }],
    });
    await h.finish('a');
    expect(h.started).toEqual(['a', 'b', 'c']);
    await h.finish('b');
    await h.finish('c');
    await h.finish('d');
    expect(h.started).toEqual(['a', 'b', 'c', 'd']);
    await h.queue.idle();
  });

  it('dispatches by priority, FIFO within a priority, resumes first', async () => {
    const h = harness(1);
    h.queue.push(job('first', 0));
    await h.tick();
    h.queue.push(job('low', -5));
    h.queue.push(job('normal-1', 0));
    h.queue.push(job('high', 10));
    h.queue.push(job('normal-2', 0));
    h.queue.push(job('resume', 0, 'resume'));
    expect(h.queue.snapshot().queued.map((j) => j.runId)).toEqual([
      'resume',
      'high',
      'normal-1',
      'normal-2',
      'low',
    ]);
    for (const id of ['first', 'resume', 'high', 'normal-1', 'normal-2', 'low']) await h.finish(id);
    expect(h.started).toEqual(['first', 'resume', 'high', 'normal-1', 'normal-2', 'low']);
  });

  it('dedupes: a Run queued or executing cannot be queued again', async () => {
    const h = harness(1);
    expect(h.queue.push(job('a'))).toBe(true);
    expect(h.queue.push(job('a'))).toBe(false);
    expect(h.queue.push(job('b'))).toBe(true);
    expect(h.queue.push(job('b', 5, 'resume'))).toBe(false);
    await h.tick();
    expect(h.queue.has('a')).toBe(true);
    expect(h.queue.isActive('a')).toBe(true);
    await h.finish('a');
    await h.finish('b');
    expect(h.started).toEqual(['a', 'b']);
  });

  it('holds jobs (kill switch, paused Bot, usage limit) without blocking others', async () => {
    const held = new Set(['bot_paused']);
    const h = harness(2, (j) => (held.has(j.botId) ? 'Bot is paused' : null));
    h.queue.push({ ...job('p'), botId: 'bot_paused' });
    h.queue.push(job('a'));
    await h.tick();
    expect(h.started).toEqual(['a']);
    expect(h.queue.snapshot().queued).toEqual([
      expect.objectContaining({ runId: 'p', heldBy: 'Bot is paused' }),
    ]);
    await h.finish('a');
    await h.queue.idle(); // only held work left
    held.clear();
    h.queue.pump();
    await h.tick();
    expect(h.started).toEqual(['a', 'p']);
  });

  it('removes waiting jobs; frozen queues dispatch nothing', async () => {
    const h = harness(1);
    h.queue.push(job('a'));
    h.queue.push(job('b'));
    expect(h.queue.remove('b')).toBe(true);
    expect(h.queue.remove('a')).toBe(false); // already executing
    h.queue.freeze();
    h.queue.push(job('c'));
    await h.tick();
    await h.finish('a');
    expect(h.started).toEqual(['a']);
    await h.queue.idle();
  });

  it('reports failed jobs and keeps going; a raised limit takes effect on the next pump', async () => {
    const h = harness(1);
    h.queue.push(job('a'));
    h.queue.push(job('b'));
    h.queue.push(job('c'));
    await h.tick();
    h.pending.get('a')!.reject(new Error('engine crashed'));
    await h.tick();
    expect(h.errors).toEqual(['a: engine crashed']);
    expect(h.started).toEqual(['a', 'b']);
    h.setLimit(3);
    h.queue.pump();
    await h.tick();
    expect(h.started).toEqual(['a', 'b', 'c']);
  });
});
