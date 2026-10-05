import { type Bot, MemoryExportHeader, slugify } from '@orbit/core/browser';

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

/** The header line of a memory export, or null when the file does not start with one. */
export function readExportHeader(text: string): MemoryExportHeader | null {
  const end = text.indexOf('\n');
  try {
    const r = MemoryExportHeader.safeParse(JSON.parse(end === -1 ? text : text.slice(0, end)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * The Bot an export came from, when it names exactly one and that Bot is
 * here (same id, else same name slug): the import dialog preselects it.
 */
export function exportedBot(
  header: MemoryExportHeader | null,
  bots: readonly Pick<Bot, 'id' | 'spec'>[],
): string | null {
  const from = header?.bots.length === 1 ? header.bots[0] : undefined;
  if (!from) return null;
  const byId = bots.find((b) => b.id === from.id);
  if (byId) return byId.id;
  const slug = slugify(from.name);
  return bots.find((b) => slugify(b.spec.name) === slug)?.id ?? null;
}
