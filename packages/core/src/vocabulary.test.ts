import { describe, expect, it } from 'vitest';
import { RunStatus, Tier } from './enums';
import {
  RUN_STATUS,
  STATUS_LEGEND,
  TIER_WORD,
  formatClock,
  formatDuration,
  formatRelative,
  formatTokens,
  formatWhen,
} from './vocabulary';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');

describe('shared status vocabulary', () => {
  it('every Run status and tier has a distinct symbol and a word (never colour alone)', () => {
    for (const s of RunStatus.options) {
      expect(RUN_STATUS[s].mark).not.toBe('');
      expect(RUN_STATUS[s].label).not.toBe('');
    }
    const marks = RunStatus.options.filter((s) => s !== 'paused').map((s) => RUN_STATUS[s].mark);
    expect(new Set(marks).size).toBe(marks.length);
    for (const t of Tier.options) expect(TIER_WORD[t].label).not.toBe('');
    expect(STATUS_LEGEND.map((l) => l.mark)).toContain(RUN_STATUS.waiting_approval.mark);
  });
});

describe('times', () => {
  it('relative times read both ways', () => {
    expect(formatRelative('2026-10-05T11:59:55.000Z', NOW)).toBe('just now');
    expect(formatRelative('2026-10-05T11:57:00.000Z', NOW)).toBe('3m ago');
    expect(formatRelative('2026-10-05T14:00:00.000Z', NOW)).toBe('in 2h');
    expect(formatRelative('2026-10-01T12:00:00.000Z', NOW)).toBe('4d ago');
    expect(formatRelative('not a date', NOW)).toBe('not a date');
  });

  it('clock times are local: time today, weekday this week, date otherwise', () => {
    const today = new Date(NOW - 60_000).toISOString();
    expect(formatClock(today, NOW)).not.toMatch(/\s(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/);
    expect(formatClock('2026-10-03T12:00:00.000Z', NOW)).toMatch(/^[A-Z][a-z]{2}\b/);
    expect(formatClock('2026-03-12T12:00:00.000Z', NOW)).toMatch(/Mar/);
    expect(formatWhen(today, NOW)).toMatch(/ · 1m ago$/);
  });

  it('durations and token counts', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(4200)).toBe('4.2s');
    expect(formatDuration(190_000)).toBe('3m 10s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});
