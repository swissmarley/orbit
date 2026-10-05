/**
 * Keys of the memory list (pure, unit-tested): j/↓ next, k/↑ previous,
 * Home/End first/last. Returns the new index, or null for any other key.
 */
export function memoryListKey(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  const at = Math.max(0, Math.min(index, count - 1));
  switch (key) {
    case 'j':
    case 'ArrowDown':
      return Math.min(count - 1, at + 1);
    case 'k':
    case 'ArrowUp':
      return Math.max(0, at - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
