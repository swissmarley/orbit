import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical';
import { inputHash } from './hash';

describe('canonicalJson / inputHash', () => {
  it('is independent of key order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(inputHash({ to: 'a', body: 'b' })).toBe(inputHash({ body: 'b', to: 'a' }));
  });

  it('distinguishes different values and array order', () => {
    expect(inputHash({ a: [1, 2] })).not.toBe(inputHash({ a: [2, 1] }));
    expect(inputHash({ a: '1' })).not.toBe(inputHash({ a: 1 }));
  });

  it('drops undefined fields like JSON does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
