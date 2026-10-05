import { BotSpec } from '@orbit/core/browser';
import { describe, expect, it } from 'vitest';
import { nameFromGoal, proposeSpec, scheduleFromGoal } from './wizard';

describe('Create Bot proposal', () => {
  it('least privilege: reads only, unless the goal needs more', () => {
    expect(proposeSpec('Keep an eye on the repository').spec.tools).toEqual([
      'Read',
      'Glob',
      'Grep',
    ]);
    expect(proposeSpec('Draft a weekly report').spec.tools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Edit',
    ]);
    expect(proposeSpec('Research AI news on the web').spec.tools).toContain('WebFetch');
    expect(proposeSpec('Run the tests and fix failures').spec.tools).toContain('Bash');
  });

  it('reads schedules from the goal', () => {
    expect(scheduleFromGoal('Summarize notes every weekday at 9')).toMatchObject({
      kind: 'cron',
      cron: '0 9 * * 1-5',
    });
    expect(scheduleFromGoal('Daily digest at 6:30 pm')).toMatchObject({ cron: '30 18 * * *' });
    expect(scheduleFromGoal('Check every hour')).toMatchObject({
      kind: 'interval',
      everyMinutes: 60,
    });
    expect(scheduleFromGoal('Weekly cleanup')).toMatchObject({ cron: '0 9 * * 1' });
    expect(scheduleFromGoal('Once, when I ask')).toBeNull();
  });

  it('every proposal is a valid Bot spec with an explanation per choice', () => {
    for (const goal of [
      'Summarize notes every weekday at 9',
      'x y',
      'Research the web hourly and draft a report',
    ]) {
      const p = proposeSpec(goal);
      expect(BotSpec.safeParse(p.spec).success).toBe(true);
      expect(p.reasons.length).toBeGreaterThan(1);
    }
    expect(nameFromGoal('summarize my notes every weekday at 9')).toBe('Summarize my notes');
  });
});
