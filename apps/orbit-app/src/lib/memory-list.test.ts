import { BotSpec } from '@orbit/core/browser';
import { describe, expect, it } from 'vitest';
import { exportedBot, memoryListKey, readExportHeader } from './memory-list';

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

describe('memory import: the Bot a file came from', () => {
  const header = (bots: { id: string; name: string }[]) =>
    `${JSON.stringify({ kind: 'orbit-memory-export', v: 1, exportedAt: '2026-10-01T08:00:00.000Z', bots, count: 0 })}\n{"x":1}\n`;
  const bot = (id: string, name: string) => ({
    id,
    spec: BotSpec.parse({ name, goal: 'g' }),
  });
  const here = [bot('bot_a', 'Mailer'), bot('bot_b', 'Notes Digest')];

  it('reads the header line, or null for anything else', () => {
    expect(readExportHeader(header([{ id: 'bot_a', name: 'Mailer' }]))?.exportedAt).toBe(
      '2026-10-01T08:00:00.000Z',
    );
    expect(readExportHeader('garbage\n')).toBeNull();
    expect(readExportHeader('{"kind":"other"}')).toBeNull();
  });

  it('matches one named Bot by id, else by slug; several or none preselect nothing', () => {
    const h = (bots: { id: string; name: string }[]) => readExportHeader(header(bots));
    expect(exportedBot(h([{ id: 'bot_a', name: 'Renamed' }]), here)).toBe('bot_a');
    expect(exportedBot(h([{ id: 'bot_elsewhere', name: 'notes digest' }]), here)).toBe('bot_b');
    expect(exportedBot(h([{ id: 'bot_x', name: 'Unknown' }]), here)).toBeNull();
    expect(
      exportedBot(
        h([
          { id: 'bot_a', name: 'Mailer' },
          { id: 'bot_b', name: 'Notes Digest' },
        ]),
        here,
      ),
    ).toBeNull();
    expect(exportedBot(null, here)).toBeNull();
  });
});
