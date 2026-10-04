import { describe, expect, it } from 'vitest';
import { idPrefix, newId } from './ids';

describe('newId', () => {
  it('is prefixed, URL-safe and unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('run')));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^run_[0-9a-z]{22}$/);
  });

  it('sorts by creation time', () => {
    const a = newId('bot', 1_700_000_000_000);
    const b = newId('bot', 1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(idPrefix(a)).toBe('bot');
  });
});
