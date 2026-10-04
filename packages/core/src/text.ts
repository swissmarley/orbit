/** Truncate long text for events and terminals, appending a marker with the dropped size. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const dropped = text.length - max;
  return { text: `${text.slice(0, max)}… [${dropped} more chars]`, truncated: true };
}
