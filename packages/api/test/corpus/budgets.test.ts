import type { BotBudgets, RunEvent, RunState } from '@orbit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Step, TranscriptOptions } from './engine';
import { type World, corpusWorld } from './world';

/**
 * Budgets are enforced in runtime code, never by the prompt (PLAN §2.6):
 * every dimension, across resume segments, through delegation, and for model
 * spend outside a Run (the triage path). When a budget fires the Run ends
 * with `budget.exceeded` and the engine is stopped: no tool runs afterwards.
 */

const reads = (n: number, from = 1): Step[] =>
  Array.from({ length: n }, (_, i) => ({
    tool: 'Read',
    input: { file_path: `notes/${from + i}.md` },
  }));

/** Tool calls Orbit let run (allowed), in order. */
const allowed = (events: RunEvent[]) =>
  events.flatMap((e) =>
    e.type === 'permission.decision' && e.data.behavior === 'allow' ? [e.data.toolName] : [],
  );

const types = (events: RunEvent[]) => events.map((e) => e.type);

/** A delegating Bot's transcript: it ends quietly once its peers have answered. */
function leadFixture(w: World, steps: Step[]): string {
  const name = w.fixture(steps);
  w.resumedFixture(name, [], { result: 'Thanks, all done.' });
  return name;
}

function expectStopped(w: World, run: RunState, budget: string, maxAllowed: number) {
  const events = w.events(run.runId);
  expect(run.status).toBe('failed');
  expect(run.error?.code).toBe('budget_exceeded');
  expect(run.budgetExceeded).toBe(budget);
  expect(types(events)).toContain('budget.exceeded');
  // The engine was stopped: nothing ran past the budget.
  expect(allowed(events).length).toBeLessThanOrEqual(maxAllowed);
}

describe('per-Run budgets stop the engine', () => {
  let w: World;
  beforeAll(async () => {
    w = await corpusWorld();
  });
  afterAll(async () => {
    await w.close();
  });

  interface Row {
    scenario: string;
    budgets?: Partial<BotBudgets>;
    maxTurns?: number;
    steps: Step[];
    opts?: TranscriptOptions;
    budget: string;
    /** Tool calls that may have run before the budget fired. */
    maxAllowed: number;
  }

  it.each<Row>([
    {
      scenario: 'a Run that keeps reading past its tool-call budget',
      budgets: { maxToolCallsPerRun: 3 },
      steps: reads(8),
      budget: 'toolCalls',
      maxAllowed: 3,
    },
    {
      scenario: 'a Run that talks past its token budget',
      budgets: { maxTokensPerRun: 100 },
      steps: reads(8),
      opts: { tokensPerTurn: { input: 30, output: 10 } },
      budget: 'tokens',
      maxAllowed: 2,
    },
    {
      scenario: 'an engine that ignores maxTurns',
      maxTurns: 3,
      steps: reads(8),
      budget: 'turns',
      maxAllowed: 3,
    },
    {
      scenario: 'a Run whose engine-estimated cost passes its cap',
      budgets: { maxCostUsdPerRun: 0.05 },
      steps: reads(2),
      opts: { costUsd: 0.08 },
      budget: 'costPerRun',
      maxAllowed: 2,
    },
  ])('$scenario → budget.exceeded ($budget), engine stopped', async (row) => {
    const bot = await w.bot({
      name: row.scenario.slice(0, 60),
      fixture: w.fixture(row.steps, row.opts),
      ...(row.budgets ? { budgets: { maxRunsPerDay: 1000, ...row.budgets } } : {}),
      ...(row.maxTurns ? { maxTurns: row.maxTurns } : {}),
    });
    const runId = await w.start(bot.id);
    await w.settle();
    expectStopped(w, w.run(runId), row.budget, row.maxAllowed);
    const audit = await (await w.h.call('GET', '/v1/audit/export')).text();
    expect(audit).toContain('budget.exceeded');
  });

  it('the engine itself is told the cost cap and the turn limit', async () => {
    const bot = await w.bot({
      name: 'Told its limits',
      fixture: w.fixture(reads(1)),
      maxTurns: 7,
      budgets: { maxCostUsdPerRun: 0.25, maxRunsPerDay: 1000 },
    });
    const runId = await w.start(bot.id);
    await w.settle();
    expect(w.engine.requests.find((r) => r.runId === runId)).toMatchObject({
      maxTurns: 7,
      maxBudgetUsd: 0.25,
    });
  });

  // Positive control: the same transcripts within budget complete.
  it('within every budget the same transcript completes', async () => {
    const bot = await w.bot({
      name: 'Within budget',
      fixture: w.fixture(reads(8), { costUsd: 0.01 }),
      maxTurns: 20,
      budgets: {
        maxToolCallsPerRun: 8,
        maxTokensPerRun: 1000,
        maxCostUsdPerRun: 0.05,
        maxRunsPerDay: 1000,
      },
    });
    const runId = await w.start(bot.id);
    await w.settle();
    expect(w.run(runId)).toMatchObject({ status: 'completed', budgetExceeded: null });
    expect(allowed(w.events(runId))).toHaveLength(8);
  });
});

describe('a resume never resets a budget', () => {
  let w: World;
  beforeAll(async () => {
    w = await corpusWorld();
  });
  afterAll(async () => {
    await w.close();
  });

  /** A Run whose first segment ends on the usage limit, then is resumed by hand. */
  async function limitedThenResumed(
    name: string,
    spec: Record<string, unknown>,
    first: { steps: Step[]; opts?: TranscriptOptions },
    resumed: { steps: Step[]; opts?: TranscriptOptions },
  ): Promise<RunState> {
    const fixture = w.fixture(first.steps, { ...first.opts, usageLimit: true });
    w.resumedFixture(fixture, resumed.steps, resumed.opts);
    const bot = await w.bot({ name, fixture, ...spec });
    const runId = await w.start(bot.id);
    await w.settle();
    expect(w.run(runId).status).toBe('rate_limited');
    const res = await w.h.json('POST', `/v1/runs/${runId}/resume`, {});
    expect(res.status).toBe(202);
    await w.settle();
    return w.run(runId);
  }

  it('tool calls: the resumed segment stops at the Run’s total', async () => {
    const run = await limitedThenResumed(
      'Tool calls across segments',
      { budgets: { maxToolCallsPerRun: 3, maxRunsPerDay: 1000 } },
      { steps: reads(2) },
      { steps: reads(5, 3) },
    );
    expectStopped(w, run, 'toolCalls', 3);
  });

  it('tokens: spent tokens carry into the resumed segment', async () => {
    const run = await limitedThenResumed(
      'Tokens across segments',
      { budgets: { maxTokensPerRun: 200, maxRunsPerDay: 1000 } },
      { steps: reads(2), opts: { tokensPerTurn: { input: 30, output: 10 } } },
      { steps: reads(5, 3), opts: { tokensPerTurn: { input: 30, output: 10 } } },
    );
    // 3 turns × 40 before the limit; the resumed segment crosses 200 on its third turn.
    expectStopped(w, run, 'tokens', 4);
  });

  it('turns: the resumed segment gets only the turns that are left', async () => {
    const run = await limitedThenResumed(
      'Turns across segments',
      { maxTurns: 4 },
      { steps: reads(2) },
      { steps: reads(5, 3) },
    );
    expectStopped(w, run, 'turns', 3);
    const resumed = w.engine.requests.filter((r) => r.runId === run.runId && r.resumed);
    expect(resumed[0]?.maxTurns).toBe(1);
  });

  it('cost: the resumed engine gets what is left of the cap, and the cap holds', async () => {
    const run = await limitedThenResumed(
      'Cost across segments',
      { budgets: { maxCostUsdPerRun: 0.05, maxRunsPerDay: 1000 } },
      { steps: reads(1), opts: { costUsd: 0.04 } },
      { steps: reads(1, 2), opts: { costUsd: 0.02 } },
    );
    const resumed = w.engine.requests.filter((r) => r.runId === run.runId && r.resumed);
    expect(resumed[0]?.maxBudgetUsd).toBeCloseTo(0.01, 5);
    expectStopped(w, run, 'costPerRun', 2);
  });

  it('wall clock: a Run that used its time is not resumed', async () => {
    const run = await limitedThenResumed(
      'Wall clock across segments',
      { budgets: { maxWallClockMinutes: 60, maxRunsPerDay: 1000 } },
      { steps: reads(1), opts: { durationMs: 61 * 60_000 } },
      { steps: reads(3, 2) },
    );
    expectStopped(w, run, 'wallClock', 1);
    expect(types(w.events(run.runId))).not.toContain('run.resumed');
  });

  it('tokens: a Run that already spent its tokens is not resumed at all', async () => {
    const run = await limitedThenResumed(
      'Tokens spent before resuming',
      // 3 turns × 40 = exactly the budget: allowed while it runs, nothing left to resume with.
      { budgets: { maxTokensPerRun: 120, maxRunsPerDay: 1000 } },
      { steps: reads(2), opts: { tokensPerTurn: { input: 30, output: 10 } } },
      { steps: reads(3, 3) },
    );
    expectStopped(w, run, 'tokens', 2);
    expect(types(w.events(run.runId))).not.toContain('run.resumed');
  });
});

describe('budgets carry across delegation', () => {
  let w: World;
  beforeAll(async () => {
    w = await corpusWorld();
  });
  afterAll(async () => {
    await w.close();
  });

  it('a child gets at most half of what its parent has left, and stops there', async () => {
    await w.bot({ name: 'Greedy Peer', fixture: w.fixture(reads(12)) });
    const lead = await w.bot({
      name: 'Frugal Lead',
      fixture: leadFixture(w, [
        ...reads(2),
        { tool: 'mcp__orbit__delegate_to_bot', input: { bot: 'Greedy Peer', task: 'Read it all' } },
      ]),
      budgets: { maxToolCallsPerRun: 10, maxRunsPerDay: 1000 },
      delegation: { allowedBots: ['Greedy Peer'] },
    });
    const runId = await w.start(lead.id);
    await w.settle();
    const parent = w.run(runId);
    const child = w.run(parent.children[0]!.runId);
    // 3 of the parent's 10 calls were spent when it delegated: the child gets floor(7 / 2).
    expect(child.budgetCap?.toolCalls).toBe(3);
    expectStopped(w, child, 'toolCalls', 3);
    // The child's spend counts against the parent.
    expect(parent.delegated.toolCalls).toBe(child.counts.toolCalls);
  });

  it('parallel delegations reserve their ceilings: together they never exceed the parent', async () => {
    for (const name of ['Peer A', 'Peer B', 'Peer C']) {
      await w.bot({ name, fixture: w.fixture(reads(12)) });
    }
    const lead = await w.bot({
      name: 'Parallel Lead',
      fixture: leadFixture(w, [
        {
          parallel: ['Peer A', 'Peer B', 'Peer C'].map((bot) => ({
            tool: 'mcp__orbit__delegate_to_bot',
            input: { bot, task: 'Read it all' },
          })),
        },
      ]),
      budgets: { maxToolCallsPerRun: 12, maxCostUsdPerRun: 1, maxRunsPerDay: 1000 },
      delegation: { allowedBots: ['Peer A', 'Peer B', 'Peer C'], maxChildrenPerRun: 3 },
    });
    const runId = await w.start(lead.id);
    await w.settle();
    const parent = w.run(runId);
    expect(parent.children).toHaveLength(3);
    const caps = parent.children.map((c) => w.run(c.runId).budgetCap);
    const calls = caps.reduce((n, c) => n + (c?.toolCalls ?? 0), 0);
    const cost = caps.reduce((n, c) => n + (c?.costUsd ?? 0), 0);
    expect(calls + 3).toBeLessThanOrEqual(12);
    expect(cost).toBeLessThanOrEqual(1);
    for (const c of parent.children) {
      const child = w.run(c.runId);
      expect(child.counts.toolCalls).toBeLessThanOrEqual((child.budgetCap?.toolCalls ?? 0) + 1);
      expect(allowed(w.events(c.runId)).length).toBeLessThanOrEqual(
        child.budgetCap?.toolCalls ?? 0,
      );
    }
  });

  it('a Bot’s daily Run budget counts the Runs it delegated', async () => {
    await w.bot({ name: 'Daily Peer', fixture: w.fixture([]) });
    const lead = await w.bot({
      name: 'Daily Lead',
      fixture: leadFixture(w, [
        { tool: 'mcp__orbit__delegate_to_bot', input: { bot: 'Daily Peer', task: 'Look' } },
      ]),
      budgets: { maxRunsPerDay: 3 },
      delegation: { allowedBots: ['Daily Peer'] },
    });
    const first = await w.start(lead.id);
    await w.settle();
    expect(w.run(first).children).toHaveLength(1);
    // Run 2 of the day plus its delegation would make 4 of 3: the delegation is refused.
    const second = await w.start(lead.id);
    await w.settle();
    expect(w.run(second).children).toHaveLength(0);
    // And a third Run does not start at all.
    const third = await w.start(lead.id);
    await w.settle();
    expect(w.run(third)).toMatchObject({ status: 'failed', budgetExceeded: 'runsPerDay' });
    expect(types(w.events(third))).not.toContain('run.started');
  });
});

describe('daily budgets refuse new Runs (recorded, never silent)', () => {
  let w: World;
  beforeAll(async () => {
    w = await corpusWorld();
  });
  afterAll(async () => {
    await w.close();
  });

  it.each<[string, Partial<BotBudgets>, TranscriptOptions, number, string]>([
    ['a Bot past its Runs for the day', { maxRunsPerDay: 2 }, {}, 2, 'runsPerDay'],
    [
      'a Bot past its cost for the day',
      { maxCostUsdPerDay: 0.05, maxRunsPerDay: 1000 },
      { costUsd: 0.03 },
      2,
      'costPerDay',
    ],
  ])('%s', async (name, budgets, opts, okRuns, budget) => {
    const bot = await w.bot({ name, fixture: w.fixture(reads(1), opts), budgets });
    for (let i = 0; i < okRuns; i++) {
      const id = await w.start(bot.id);
      await w.settle();
      expect(w.run(id).status).toBe('completed');
    }
    const refused = await w.start(bot.id);
    await w.settle();
    expect(w.run(refused)).toMatchObject({ status: 'failed', budgetExceeded: budget });
    expect(types(w.events(refused))).not.toContain('run.started');
    expect(w.engine.requests.filter((r) => r.runId === refused)).toEqual([]);
  });
});

describe('the triage path is capped per day', () => {
  let w: World;
  beforeAll(async () => {
    w = await corpusWorld({ config: { triage: { maxCallsPerDay: 2 } } });
  });
  afterAll(async () => {
    await w.close();
  });

  it('summaries beyond the cap are refused and recorded; so is a proposal', async () => {
    const bot = await w.bot({
      name: 'Summarised',
      fixture: w.fixture([], { result: 'All done.' }),
      memory: { summarize: 'triage' },
    });
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      runs.push(await w.start(bot.id));
      await w.settle();
    }
    const summarized = runs.map((id) => {
      const e = w.events(id).find((x) => x.type === 'memory.summarized');
      return e?.type === 'memory.summarized' ? e.data : null;
    });
    expect(summarized.map((s) => s?.error ?? null).slice(0, 2)).toEqual([null, null]);
    expect(summarized[2]?.error).toMatch(/limit|cap|per day/i);
    expect(w.h.service.triageUsage()).toMatchObject({ callsToday: 2, limit: 2 });
    const proposal = await w.h.json<{ error: { message: string } }>(
      'POST',
      '/v1/triage/bot-proposal',
      { goal: 'Summarise my notes' },
    );
    expect(proposal.status).toBe(409);
  });
});
