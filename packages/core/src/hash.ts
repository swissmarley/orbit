import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable identity of a tool call's input (used to bind one-shot grants). */
export function inputHash(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}
