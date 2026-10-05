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
