/**
 * The little markdown Bots write (ADR-020): paragraphs, headings, lists (one
 * level of nesting), quotes, code blocks and inline emphasis and code. It is
 * parsed into a tree the App renders as React elements, never as HTML, and
 * links are kept as text (label and address) rather than followed: model
 * text may come from untrusted content. Callers scrub control characters
 * first.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; label: string; url: string };

export interface ListItem {
  c: Inline[];
  sub: { ordered: boolean; items: Inline[][] } | null;
}

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'hr' };

/** Inline spans: `code`, **strong**, *em* / _em_, [label](url). */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const end = src.indexOf(`${ch}${ch}`, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' || (ch === '_' && (i === 0 || !/\w/.test(src[i - 1] ?? '')))) {
      const end = src.indexOf(ch, i + 1);
      const inner = end > i + 1 ? src.slice(i + 1, end) : '';
      if (inner && !inner.startsWith(' ') && !inner.endsWith(' ')) {
        flush();
        out.push({ t: 'em', c: parseInline(inner) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: 'link', label: m[1] ?? '', url: m[2] ?? '' });
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

const BULLET = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

/** Blocks of a message. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      i += 1;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const level = Math.min(3, (heading[1] ?? '#').length) as 1 | 2 | 3;
      blocks.push({ t: 'h', level, c: parseInline((heading[2] ?? '').replace(/\s+#+\s*$/, '')) });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      blocks.push({ t: 'hr' });
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ t: 'quote', c: parseInline(quote.join('\n')) });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet && (bullet[1] ?? '').length < 2) {
      flushPara();
      const ordered = /\d/.test(bullet[2] ?? '');
      const list: Extract<Block, { t: 'list' }> = {
        t: 'list',
        ordered,
        start: ordered ? Number.parseInt(bullet[2] ?? '1', 10) : 1,
        items: [],
      };
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const m = BULLET.exec(l);
        if (m && (m[1] ?? '').length < 2 && /\d/.test(m[2] ?? '') === ordered) {
          list.items.push({ c: parseInline(m[3] ?? ''), sub: null });
          i += 1;
          continue;
        }
        const last = list.items.at(-1);
        if (m && (m[1] ?? '').length >= 2 && last) {
          const subOrdered = /\d/.test(m[2] ?? '');
          last.sub ??= { ordered: subOrdered, items: [] };
          last.sub.items.push(parseInline(m[3] ?? ''));
          i += 1;
          continue;
        }
        // A wrapped line continues the item; a blank line or anything else ends the list.
        if (last && l.trim() && /^\s{2,}\S/.test(l)) {
          last.c.push({ t: 'text', v: ` ${l.trim()}` });
          i += 1;
          continue;
        }
        break;
      }
      blocks.push(list);
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return blocks;
}
