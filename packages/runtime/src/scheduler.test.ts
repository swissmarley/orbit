import { Bot, type BotSpecInput, type TriggerRef } from '@orbit/core';
import type { TriggerFire } from '@orbit/store';
import { describe, expect, it } from 'vitest';
import { Scheduler, describeTrigger, nextFire, triggerKey, validateTriggers } from './scheduler';

function makeBot(spec: Partial<BotSpecInput>, id = 'bot_1', pausedAt: string | null = null): Bot {
  return Bot.parse({
    id,
    version: 1,
    spec: { name: id, goal: 'g', ...spec },
    pausedAt,
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
  });
}

function harness(bots: Bot[], start = '2026-10-04T08:59:00.000Z') {
  let t = Date.parse(start);
  const state = new Map<string, TriggerFire>();
  const fired: { botId: string; ref: TriggerRef; runId: string }[] = [];
  const inFlight = new Set<string>();
  let n = 0;
  const scheduler = new Scheduler({
    bots: () => bots,
    state: { get: (k) => state.get(k), record: (f) => state.set(f.key, f) },
    fire: (bot, _trigger, ref) => {
      const runId = `run_${++n}`;
      fired.push({ botId: bot.id, ref, runId });
      return { fired: true, runId };
    },
    inFlight: (runId) => inFlight.has(runId),
    now: () => new Date(t),
  });
  return {
    scheduler,
    fired,
    inFlight,
    state,
    at: (iso: string) => {
      t = Date.parse(iso);
      return scheduler.tick();
    },
    advance: (ms: number) => {
      t += ms;
      return scheduler.tick();
    },
  };
}

describe('Scheduler', () => {
  it('fires cron triggers at their time, once, and records the fire', () => {
    const bot = makeBot({ triggers: [{ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }] });
    const h = harness([bot]);
    expect(h.scheduler.tick()).toEqual([]);
    expect(h.scheduler.upcoming()[0]).toMatchObject({
      nextAt: '2026-10-04T09:00:00.000Z',
      description: 'cron 0 9 * * * (UTC)',
    });
    expect(h.at('2026-10-04T08:59:59.000Z')).toEqual([]);
    expect(h.at('2026-10-04T09:00:00.500Z')).toHaveLength(1);
    expect(h.fired).toEqual([
      { botId: 'bot_1', ref: { kind: 'cron', source: 'cron 0 9 * * * (UTC)' }, runId: 'run_1' },
    ]);
    // Not again in the same minute, nor before tomorrow.
    expect(h.advance(1000)).toEqual([]);
    expect(h.at('2026-10-05T08:59:00.000Z')).toEqual([]);
    expect(h.at('2026-10-05T09:00:01.000Z')).toHaveLength(1);
    expect(h.state.get(triggerKey('bot_1', bot.spec.triggers[0]!))?.lastRunId).toBe('run_2');
  });

  it('fires interval triggers from first sight, then from each fire', () => {
    const bot = makeBot({ triggers: [{ kind: 'interval', everyMinutes: 30, prompt: 'poll' }] });
    const h = harness([bot], '2026-10-04T10:00:00.000Z');
    expect(h.scheduler.tick()).toEqual([]);
    expect(h.at('2026-10-04T10:29:00.000Z')).toEqual([]);
    expect(h.at('2026-10-04T10:30:00.000Z')).toHaveLength(1);
    expect(h.at('2026-10-04T10:59:00.000Z')).toEqual([]);
    expect(h.at('2026-10-04T11:00:00.000Z')).toHaveLength(1);
    expect(h.fired.map((f) => f.ref)).toEqual([
      { kind: 'interval', source: 'every 30m' },
      { kind: 'interval', source: 'every 30m' },
    ]);
  });

  it('does not replay fires missed while the daemon was down (restart)', () => {
    const bot = makeBot({ triggers: [{ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }] });
    const state = new Map<string, TriggerFire>();
    const key = triggerKey('bot_1', bot.spec.triggers[0]!);
    state.set(key, {
      key,
      botId: 'bot_1',
      lastFiredAt: '2026-10-02T09:00:00.000Z',
      lastRunId: null,
    });
    let fires = 0;
    const s = new Scheduler({
      bots: () => [bot],
      state: { get: (k) => state.get(k), record: (f) => state.set(f.key, f) },
      fire: () => ({ fired: true, runId: `run_${++fires}` }),
      inFlight: () => false,
      now: () => new Date('2026-10-04T12:00:00.000Z'),
    });
    expect(s.tick()).toEqual([]);
    expect(fires).toBe(0);
    expect(s.upcoming()[0]?.nextAt).toBe('2026-10-05T09:00:00.000Z');
  });

  it('skips (and consumes) a fire while the previous run is in flight or the Bot is paused', () => {
    const busy = makeBot({ triggers: [{ kind: 'interval', everyMinutes: 1 }] });
    const paused = makeBot(
      { triggers: [{ kind: 'interval', everyMinutes: 1 }] },
      'bot_2',
      '2026-10-04T00:00:00.000Z',
    );
    const h = harness([busy, paused], '2026-10-04T10:00:00.000Z');
    h.scheduler.tick();
    expect(h.advance(60_000).map((r) => r.outcome.fired)).toEqual([true, false]);
    h.inFlight.add('run_1');
    const skipped = h.advance(60_000);
    expect(skipped[0]?.outcome).toEqual({
      fired: false,
      reason: 'previous run run_1 still in flight',
    });
    expect(skipped[1]?.outcome).toEqual({ fired: false, reason: 'Bot is paused' });
    // The in-flight run stays the trigger's last run until it ends.
    h.inFlight.clear();
    expect(h.advance(60_000)[0]?.outcome).toEqual({ fired: true, runId: 'run_2' });
    expect(h.scheduler.upcoming('bot_2')[0]).toMatchObject({ enabled: false, nextAt: null });
  });

  it('a fire that throws is recorded as skipped, not retried in a hot loop', () => {
    const bot = makeBot({ triggers: [{ kind: 'interval', everyMinutes: 5 }] });
    const state = new Map<string, TriggerFire>();
    let t = Date.parse('2026-10-04T10:00:00.000Z');
    let calls = 0;
    const s = new Scheduler({
      bots: () => [bot],
      state: { get: (k) => state.get(k), record: (f) => state.set(f.key, f) },
      fire: () => {
        calls += 1;
        throw new Error('The global kill switch is engaged');
      },
      inFlight: () => false,
      now: () => new Date(t),
    });
    s.tick();
    t += 5 * 60_000;
    expect(s.tick()[0]?.outcome).toEqual({
      fired: false,
      reason: 'The global kill switch is engaged',
    });
    t += 1000;
    expect(s.tick()).toEqual([]);
    expect(calls).toBe(1);
  });

  it('ignores disabled triggers; keys ignore name and enabled', () => {
    const t = { kind: 'cron', cron: '*/5 * * * *', enabled: false } as const;
    const h = harness([makeBot({ triggers: [t] })]);
    expect(h.advance(3_600_000)).toEqual([]);
    expect(triggerKey('b', { ...t, enabled: true, name: 'x' })).toBe(triggerKey('b', t));
    expect(triggerKey('b', { ...t, cron: '0 * * * *' })).not.toBe(triggerKey('b', t));
    expect(describeTrigger({ ...t, name: 'Morning digest' })).toBe('Morning digest');
  });

  it('validates cron expressions and time zones', () => {
    expect(() =>
      validateTriggers([{ kind: 'cron', cron: '0 9 * * 1-5', enabled: true }]),
    ).not.toThrow();
    expect(() => validateTriggers([{ kind: 'cron', cron: 'every day', enabled: true }])).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    );
    expect(() =>
      validateTriggers([
        { kind: 'cron', cron: '0 9 * * *', timezone: 'Mars/Olympus', enabled: true },
      ]),
    ).toThrow(/Invalid cron trigger/);
    expect(
      nextFire({ kind: 'interval', everyMinutes: 2, enabled: true }, new Date(0))?.getTime(),
    ).toBe(120_000);
  });
});
