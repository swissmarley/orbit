import { openDatabase } from '@orbit/store';
import { describe, expect, it } from 'vitest';
import { TriageLedger } from './triage-ledger';

describe('TriageLedger', () => {
  it('counts calls, tokens and cost since local midnight', () => {
    let now = new Date(2026, 9, 4, 23, 0);
    const ledger = new TriageLedger(openDatabase(':memory:'), () => now);
    const call = {
      purpose: 'summary' as const,
      botId: 'bot_1',
      runId: 'run_1',
      model: 'haiku',
      status: 'ok' as const,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.0012,
      error: null,
    };
    ledger.record(call);
    expect(ledger.usage(20)).toMatchObject({ callsToday: 1, limit: 20, inputTokensToday: 100 });
    now = new Date(2026, 9, 5, 8, 0);
    ledger.record({ ...call, status: 'failed', costUsd: null, error: 'boom' });
    const u = ledger.usage(20);
    expect(u.callsToday).toBe(1);
    expect(u.costUsdToday).toBe(0);
    expect(u.recent.map((c) => c.status)).toEqual(['failed', 'ok']);
    expect(u.recent[1]?.costUsd).toBeCloseTo(0.0012);
  });
});
