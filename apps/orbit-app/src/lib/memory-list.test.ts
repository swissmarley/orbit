import { describe, expect, it } from 'vitest';
import { memoryListKey } from './memory-list';

describe('memory list keys', () => {
  it('moves within bounds and ignores other keys', () => {
    expect(memoryListKey('j', 0, 3)).toBe(1);
    expect(memoryListKey('ArrowDown', 2, 3)).toBe(2);
    expect(memoryListKey('k', 0, 3)).toBe(0);
    expect(memoryListKey('ArrowUp', 2, 3)).toBe(1);
    expect(memoryListKey('End', 0, 3)).toBe(2);
    expect(memoryListKey('Home', 2, 3)).toBe(0);
    expect(memoryListKey('x', 1, 3)).toBeNull();
    expect(memoryListKey('j', 0, 0)).toBeNull();
    expect(memoryListKey('j', 9, 3)).toBe(2);
  });
});
