import { describe, expect, it } from 'vitest';
import { collapse, lineDiff, parseUnified, specDiff, toolDiff } from './diff';

describe('diffs', () => {
  it('line diff with line numbers', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { kind: 'ctx', text: 'a', a: 1, b: 1 },
      { kind: 'del', text: 'b', a: 2, b: null },
      { kind: 'add', text: 'B', a: null, b: 2 },
      { kind: 'ctx', text: 'c', a: 3, b: 3 },
    ]);
  });

  it('collapses long unchanged stretches', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'X');
    const lines = collapse(lineDiff(before, after), 1);
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'ctx', 'del', 'add', 'ctx', 'hunk']);
  });

  it('parses the unified diffs approval cards carry', () => {
    const lines = parseUnified('Index: f\n===\n--- f\n+++ f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n');
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'hunk:@@ -1,2 +1,2 @@',
      'ctx:a',
      'del:b',
      'add:c',
    ]);
  });

  it('diffs Bot spec versions with sorted keys', () => {
    const d = specDiff({ name: 'A', goal: 'g' }, { goal: 'g', name: 'B' });
    expect(d.filter((l) => l.kind !== 'ctx').map((l) => l.text.trim())).toEqual([
      '"name": "A"',
      '"name": "B"',
    ]);
  });

  it('shows what file tools would change', () => {
    expect(toolDiff('Write', { file_path: 'x', content: 'hi\n' })?.map((l) => l.kind)).toEqual([
      'add',
    ]);
    expect(
      toolDiff('MultiEdit', {
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      })?.filter((l) => l.kind === 'hunk'),
    ).toHaveLength(1);
    expect(toolDiff('Read', { file_path: 'x' })).toBeNull();
  });
});
