import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify returns undefined for undefined/functions/symbols.
    const text = JSON.stringify(value) as string | undefined;
    return text ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable identity of a tool call's input (used to bind one-shot grants). */
export function inputHash(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}
