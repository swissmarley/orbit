/**
 * `pnpm load-test [--runs 200] [--clients 50] [--concurrency 32] [--bots 5]
 *                 [--delay 2] [--drops 2] [--timeout 120000] [--json]`
 *
 * Starts orbitd in this process (loopback, port 0, a scratch ORBIT_HOME, the
 * mock driver), runs N concurrent Runs with M SSE subscribers and checks that
 * every subscriber got every event exactly once, in order, with no gaps, that
 * every Run ended and the queue drained. Exits 1 on any violation.
 */
import { parseArgs } from 'node:util';
import { DEFAULT_LOAD, type LoadOptions, runLoad } from '../test/load';

const { values } = parseArgs({
  options: {
    runs: { type: 'string' },
    clients: { type: 'string' },
    concurrency: { type: 'string' },
    bots: { type: 'string' },
    delay: { type: 'string' },
    drops: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

function int(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    process.stderr.write(`--${name} must be a whole number (got ${value})\n`);
    process.exit(2);
  }
  return n;
}

const options: LoadOptions = {
  runs: int('runs', values.runs, DEFAULT_LOAD.runs),
  clients: int('clients', values.clients, DEFAULT_LOAD.clients),
  concurrency: Math.max(1, int('concurrency', values.concurrency, DEFAULT_LOAD.concurrency)),
  bots: Math.max(1, int('bots', values.bots, DEFAULT_LOAD.bots)),
  delayMs: int('delay', values.delay, DEFAULT_LOAD.delayMs),
  drops: int('drops', values.drops, DEFAULT_LOAD.drops),
  timeoutMs: int('timeout', values.timeout, DEFAULT_LOAD.timeoutMs),
};

const report = await runLoad(options);
if (values.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const r = report;
  const lines = [
    `orbitd load test: ${options.runs} Runs on ${options.bots} Bots, ${options.clients} SSE subscribers (${options.drops} cut mid-stream), concurrency ${options.concurrency}`,
    `  runs        ${r.runs.completed} completed, ${r.runs.failed} failed, ${r.runs.cancelled} cancelled in ${r.durationMs} ms (${r.runsPerSecond}/s)`,
    `  events      ${r.events} (${r.eventsPerSecond}/s), ${r.deliveries} deliveries (${r.deliveriesPerSecond}/s)`,
    `  latency     p50 ${r.latencyMs.p50} ms, p95 ${r.latencyMs.p95} ms, max ${r.latencyMs.max} ms (live); max ${r.latencyMs.resumedMax} ms after a cut`,
    `  reconnects  ${r.reconnects} (after ${r.cuts} cut connections)`,
    `  peak RSS    ${r.peakRssMb} MB`,
    r.violations.length === 0
      ? '✓ every subscriber saw every event once, in order; every Run ended; the queue drained'
      : `✗ ${r.violations.length} violation(s):\n${r.violations
          .slice(0, 20)
          .map((v) => `    ${v}`)
          .join('\n')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}
process.exit(report.violations.length === 0 ? 0 : 1);
