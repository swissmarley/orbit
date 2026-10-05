/** Truncate long text for events and terminals, appending a marker with the dropped size. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const dropped = text.length - max;
  return { text: `${text.slice(0, max)}… [${dropped} more chars]`, truncated: true };
}

// C0/C1 controls (but newline and tab), DEL, bidi marks/overrides/isolates,
// zero-width characters and line/paragraph separators.
const CONTROLS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Neutralise control and bidi characters in text a model, tool or web page
 * wrote: in a terminal an ESC sequence could move the cursor or fake a line
 * ("✔ approved"); in any client a bidi override can make text read
 * differently from what it is.
 */
export function scrubControls(text: string): string {
  return text.replace(CONTROLS, '\ufffd');
}

/** `<` spelled as an HTML entity, a JSON or JavaScript escape, or URL-encoded. */
const LT_SPELLED = /&(?:lt|#0*60|#x0*3c);?|\\u003c|\\x3c|%3c/iy;
/** Characters a reader takes for `<`, `/` or nothing that compatibility normalisation keeps. */
const LT_LOOKALIKES = new Set(['\u02c2', '\u1438', '\u2329', '\u276e', '\u27e8', '\u3008']);
const SLASH_LOOKALIKES = new Set(['\u2044', '\u2215', '\u2571', '\u29f8']);
const INVISIBLE_EXTRA = new Set([0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xffa0]);
/** Anything that can start a spelling of `<` (the fast path skips text without one). */
const LT_START = /[<&\\%\u02c2\u1438\u2329\u276e\u27e8\u3008\ufe64\uff1c]/;

function invisible(cp: number, ch: string): boolean {
  return (
    /\p{Cf}/u.test(ch) ||
    INVISIBLE_EXTRA.has(cp) ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/** How a character reads: compatibility-normalised, lower case, look-alikes folded. */
function fold(ch: string): string {
  let out = '';
  for (const c of ch.normalize('NFKC').toLowerCase()) {
    if (LT_LOOKALIKES.has(c)) out += '<';
    else if (SLASH_LOOKALIKES.has(c)) out += '/';
    else if (/\p{Pd}/u.test(c)) out += '-';
    else out += c;
  }
  return out;
}

/**
 * Neutralise Orbit's own tags (`<orbit-untrusted>`, `</orbit-memory>`, \u2026) in
 * untrusted or model-written text before it is placed inside one of them, so
 * the text cannot close the block or forge a trusted one. Spellings a reader
 * would still take for a tag count too: spaces inside it, upper case,
 * full-width and small-form characters, look-alike brackets, slashes and
 * dashes, invisible characters, and `<` written as an entity, escape or
 * URL encoding (M8 injection corpus). The `<` (however spelled) becomes `\u2039`,
 * which nothing reads as a tag; the rest of the text is left as it was.
 */
export function neutraliseTags(text: string, name = 'orbit'): string {
  if (!LT_START.test(text)) return text;
  // A folded copy of the text, each UTF-16 unit pointing back at the source range it came from.
  const units: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  while (i < text.length) {
    LT_SPELLED.lastIndex = i;
    const spelled = LT_SPELLED.exec(text);
    if (spelled) {
      units.push('<');
      from.push(i);
      to.push(i + spelled[0].length);
      i += spelled[0].length;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    if (!invisible(cp, ch)) {
      const folded = fold(ch);
      for (let k = 0; k < folded.length; k++) {
        units.push(folded.charAt(k));
        from.push(i);
        to.push(i + ch.length);
      }
    }
    i += ch.length;
  }
  const tag = new RegExp(`<\\s*/?\\s*${name}(?:\\s*[-_:.>]|\\s+[a-z])`, 'g');
  let out = '';
  let last = 0;
  for (const m of units.join('').matchAll(tag)) {
    const start = from[m.index] ?? 0;
    if (start < last) continue;
    out += `${text.slice(last, start)}\u2039`;
    last = to[m.index] ?? start + 1;
  }
  return out + text.slice(last);
}
