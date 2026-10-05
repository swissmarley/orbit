import { describe, expect, it } from 'vitest';
import { runLoad, verifyStream } from '../test/load';

describe('orbitd under load (CI-sized; `pnpm load-test` runs the full size)', () => {
  it('40 concurrent Runs × 10 SSE subscribers: every event once, in order, no gaps; one subscriber dropped mid-stream resumes losslessly', async () => {
    const report = await runLoad({
      runs: 40,
      clients: 10,
      concurrency: 8,
      bots: 4,
      delayMs: 1,
      drops: 1,
      timeoutMs: 20_000,
    });
    expect(report.violations).toEqual([]);
    expect(report.runs).toEqual({ started: 40, completed: 40, failed: 0, cancelled: 0 });
    expect(report.events).toBeGreaterThan(40 * 5);
    expect(report.deliveries).toBe(report.events * 10);
    // The dropped subscriber was cut mid-stream and came back with Last-Event-ID each time.
    expect(report.cuts).toBeGreaterThanOrEqual(1);
    expect(report.reconnects).toBeGreaterThanOrEqual(report.cuts);
  }, 30_000);
});

// Positive controls: the stream check catches every way a feed can be wrong.
describe('verifyStream', () => {
  it.each<[string, number[], RegExp | null]>([
    ['an exact stream', [1, 2, 3, 4], null],
    ['a gap', [1, 2, 4], /never delivered \(first: 3\)/],
    ['a duplicate', [1, 2, 2, 3, 4], /delivered twice/],
    ['out of order', [1, 3, 2, 4], /out of order/],
    ['an event from elsewhere', [1, 2, 3, 4, 9], /unexpected/],
  ])('%s', (_scenario, received, problem) => {
    const problems = verifyStream([1, 2, 3, 4], received);
    if (problem) expect(problems.join('\n')).toMatch(problem);
    else expect(problems).toEqual([]);
  });
});
