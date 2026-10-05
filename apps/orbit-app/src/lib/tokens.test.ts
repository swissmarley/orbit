import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '../styles.css'), 'utf8');

/** Token values of one theme block (the first `:root {` is light, `:root[data-theme='dark']` is dark). */
function tokens(selector: RegExp): Record<string, string> {
  const start = css.search(selector);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const THEMES = { light: tokens(/:root \{/), dark: tokens(/:root\[data-theme='dark'\] \{/) };

describe('design tokens meet WCAG AA in both themes', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    it(`${name}: text on every surface ≥ 4.5:1`, () => {
      for (const fg of ['fg', 'fg-muted', 'fg-subtle']) {
        for (const bg of ['bg', 'surface', 'surface-2']) {
          expect(contrast(t[fg] ?? '', t[bg] ?? ''), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const tone of ['neutral', 'info', 'success', 'warning', 'danger', 'attention']) {
        const pair = contrast(t[`tone-${tone}`] ?? '', t[`tone-${tone}-bg`] ?? '');
        expect(pair, `tone ${tone}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: form-control borders and the focus ring ≥ 3:1 (WCAG 1.4.11)`, () => {
      for (const bg of ['surface', 'bg']) {
        expect(
          contrast(t['border-input'] ?? '', t[bg] ?? ''),
          `border-input on ${bg}`,
        ).toBeGreaterThanOrEqual(3);
        expect(contrast(t.ring ?? '', t[bg] ?? ''), `ring on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('the dark block under prefers-color-scheme matches the explicit dark theme', () => {
    const media = tokens(/:root:not\(\[data-theme='light'\]\) \{/);
    expect(media).toEqual(THEMES.dark);
  });
});
