import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('markdown for Bot messages', () => {
  it('paragraphs, headings, quotes, rules and code blocks', () => {
    expect(
      parseMarkdown('# Plan\n\nFirst line\nsecond line\n\n> careful\n\n---\n\n```sh\nls -la\n```'),
    ).toEqual([
      { t: 'h', level: 1, c: [{ t: 'text', v: 'Plan' }] },
      { t: 'p', c: [{ t: 'text', v: 'First line\nsecond line' }] },
      { t: 'quote', c: [{ t: 'text', v: 'careful' }] },
      { t: 'hr' },
      { t: 'code', lang: 'sh', v: 'ls -la' },
    ]);
  });

  it('lists, ordered or not, with one level of nesting', () => {
    const [list] = parseMarkdown(
      '1. Define the scope\n   - State the purpose\n   - Add a README\n2. Ship it',
    );
    expect(list).toEqual({
      t: 'list',
      ordered: true,
      start: 1,
      items: [
        {
          c: [{ t: 'text', v: 'Define the scope' }],
          sub: {
            ordered: false,
            items: [[{ t: 'text', v: 'State the purpose' }], [{ t: 'text', v: 'Add a README' }]],
          },
        },
        { c: [{ t: 'text', v: 'Ship it' }], sub: null },
      ],
    });
  });

  it('inline emphasis and code; links stay text with their address', () => {
    expect(
      parseInline(
        'Saved as `notes.md` — **41 words**, *done*. See [the page](https://example.com/x)',
      ),
    ).toEqual([
      { t: 'text', v: 'Saved as ' },
      { t: 'code', v: 'notes.md' },
      { t: 'text', v: ' — ' },
      { t: 'strong', c: [{ t: 'text', v: '41 words' }] },
      { t: 'text', v: ', ' },
      { t: 'em', c: [{ t: 'text', v: 'done' }] },
      { t: 'text', v: '. See ' },
      { t: 'link', label: 'the page', url: 'https://example.com/x' },
    ]);
  });

  it('never produces markup from text: tags stay literal text', () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
    expect(blocks).toEqual([
      {
        t: 'p',
        c: [{ t: 'text', v: '<img src=x onerror=alert(1)> and <script>alert(1)</script>' }],
      },
    ]);
  });

  it('does not take snake_case or a lone star for emphasis', () => {
    expect(parseInline('use memory_write and 2 * 3')).toEqual([
      { t: 'text', v: 'use memory_write and 2 * 3' },
    ]);
  });

  it('keeps tool names with double underscores as written (ui review M4)', () => {
    expect(parseInline('denied mcp__bank__transfer_funds for you')).toEqual([
      { t: 'text', v: 'denied mcp__bank__transfer_funds for you' },
    ]);
    expect(parseInline('a __b__ c and _d_ e')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'strong', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' c and ' },
      { t: 'em', c: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' e' },
    ]);
    // An underscore closes only where no word follows.
    expect(parseInline('_x_y_ z')).toEqual([
      { t: 'em', c: [{ t: 'text', v: 'x_y' }] },
      { t: 'text', v: ' z' },
    ]);
  });
});
