import { BotSpec, type Bot, type RunState } from '@orbit/core';
import { PROPOSAL_SYSTEM, SUMMARY_SYSTEM, TriageLedger, parseProposal } from '@orbit/memory';
import { openDatabase } from '@orbit/store';
import { describe, expect, it } from 'vitest';
import { MockDriver } from './drivers/mock';
import { effectiveBudgets, remainingBudget } from './orchestrator';
import { type TriageEngine, TriagePath, driverTriage, mockTriage } from './triage';

const req = {
  purpose: 'summary' as const,
  botId: null,
  runId: null,
  system: SUMMARY_SYSTEM,
  prompt: 'TASK: x\nRESULT: y',
};

function path(engine: TriageEngine, opts: { max?: number; hold?: string | null } = {}) {
  const ledger = new TriageLedger(openDatabase(':memory:'));
  return {
    ledger,
    triage: new TriagePath({
      ledger,
      engine: () => Promise.resolve(engine),
      maxCallsPerDay: () => opts.max ?? 5,
      hold: () => opts.hold ?? null,
    }),
  };
}

describe('TriagePath', () => {
  it('records every call with its usage and enforces the daily limit before spending', async () => {
    let calls = 0;
    const engine: TriageEngine = () => {
      calls += 1;
      return Promise.resolve({
        text: 'Title\n- a',
        model: 'haiku',
        inputTokens: 12,
        outputTokens: 3,
        costUsd: 0.001,
      });
    };
    const { triage } = path(engine, { max: 1 });
    expect((await triage.call(req)).text).toBe('Title\n- a');
    await expect(triage.call(req)).rejects.toThrow(/Daily triage limit/);
    expect(calls).toBe(1);
    expect(triage.usage()).toMatchObject({
      callsToday: 1,
      inputTokensToday: 12,
      outputTokensToday: 3,
    });
  });

  it('refuses while held (kill switch, usage limit) or turned off', async () => {
    await expect(
      path(mockTriage, { hold: 'usage limit until 14:00' }).triage.call(req),
    ).rejects.toThrow(/paused: usage limit/);
    await expect(path(mockTriage, { max: 0 }).triage.call(req)).rejects.toThrow(/turned off/);
  });

  it('records failed calls (they may have spent) and runs calls one at a time', async () => {
    let running = 0;
    let max = 0;
    const engine: TriageEngine = async () => {
      running += 1;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      throw Object.assign(new Error('boom'), { usage: { model: 'haiku', inputTokens: 5 } });
    };
    const { triage } = path(engine);
    const results = await Promise.allSettled([triage.call(req), triage.call(req)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(max).toBe(1);
    const u = triage.usage();
    expect(u.callsToday).toBe(2);
    expect(u.recent[0]).toMatchObject({ status: 'failed', error: 'boom', inputTokens: 5 });
  });

  it('the mock engine is free and deterministic for summaries and proposals', async () => {
    const s = await mockTriage(req, new AbortController().signal);
    expect(s).toMatchObject({ model: 'mock', costUsd: 0 });
    const p = await mockTriage(
      {
        ...req,
        purpose: 'bot_proposal',
        system: PROPOSAL_SYSTEM,
        prompt: '<goal>\nResearch launch news weekly\n</goal>',
      },
      new AbortController().signal,
    );
    expect(parseProposal(p.text)).toMatchObject({ schedule: { cron: '0 9 * * 1' } });
  });

  it('a driver triage call runs with no tools, one turn and a deny-all policy', async () => {
    const seen: unknown[] = [];
    const driver = new MockDriver({ defaultFixture: 'pong' });
    const spy = {
      kind: driver.kind,
      authMethod: driver.authMethod,
      run: (r: Parameters<MockDriver['run']>[0]) => {
        seen.push({ tools: r.tools, maxTurns: r.maxTurns, model: r.model });
        return driver.run(r);
      },
    };
    const r = await driverTriage(spy, { model: 'haiku', cwd: '/tmp/orbit-triage-test' })(
      req,
      new AbortController().signal,
    );
    expect(r.text).toBe('pong');
    expect(seen).toEqual([{ tools: [], maxTurns: 1, model: 'haiku' }]);
  });
});

describe('budgets across delegation', () => {
  const bot: Bot = {
    id: 'b',
    version: 1,
    spec: BotSpec.parse({
      name: 'b',
      goal: 'g',
      budgets: { maxToolCallsPerRun: 50, maxTokensPerRun: 10_000 },
    }),
    pausedAt: null,
    createdAt: '',
    updatedAt: '',
  };

  it('a child gets the smaller of its own budgets and what its parent had left', () => {
    const b = effectiveBudgets(bot, {
      toolCalls: 7,
      tokens: null,
      costUsd: 0.5,
      wallClockMinutes: 10,
    });
    expect(b).toMatchObject({
      maxToolCallsPerRun: 7,
      maxTokensPerRun: 10_000,
      maxCostUsdPerRun: 0.5,
      maxWallClockMinutes: 10,
    });
  });

  it('what is left counts the Run’s own and its children’s spend', () => {
    const state = {
      counts: { toolCalls: 10 },
      delegated: { toolCalls: 5, tokens: 1000, costUsd: 0 },
      totals: { tokens: 2000, costUsd: 0 },
      budgetCap: null,
    } as unknown as RunState;
    expect(remainingBudget(bot, state)).toMatchObject({
      toolCalls: 35,
      tokens: 7000,
      costUsd: null,
    });
  });
});
