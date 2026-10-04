import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

function encodeTime(ms: number, length: number): string {
  let out = '';
  let n = ms;
  for (let i = 0; i < length; i++) {
    out = ALPHABET.charAt(n % 32) + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALPHABET.charAt(b % 32);
  return out;
}

export type IdPrefix = 'bot' | 'run' | 'apr' | 'trg' | 'mem' | 'fbk' | 'rul' | 'aud';

/**
 * Time-sortable, URL-safe identifiers: `<prefix>_<10 chars time><12 chars random>`.
 * Lexicographic order matches creation order at millisecond resolution.
 */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${encodeTime(now, 10)}${encodeRandom(12)}`;
}

export function idPrefix(id: string): string | undefined {
  const i = id.indexOf('_');
  return i > 0 ? id.slice(0, i) : undefined;
}
