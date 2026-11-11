import { describe, expect, it } from 'vitest';
import { canonicalJson, deterministicUuid, fingerprint, fingerprintOf } from './hash.ts';

describe('hash', () => {
  it('is stable and key-order independent', () => {
    expect(fingerprintOf({ a: 1, b: [1, { y: 2, x: 1 }] })).toBe(fingerprintOf({ b: [1, { x: 1, y: 2 }], a: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(fingerprint('a')).toBe(fingerprint('a'));
    expect(fingerprint('a') === fingerprint('b')).toBe(false);
    expect(fingerprint('x').length).toBe(32);
  });
  it('derives RFC-shaped deterministic uuids that depend on every part', () => {
    const id = deterministicUuid('t1', 's', 'customers', 'c1');
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)).toBe(true);
    expect(deterministicUuid('t1', 's', 'customers', 'c1')).toBe(id);
    expect(deterministicUuid('t2', 's', 'customers', 'c1') === id).toBe(false);
    expect(deterministicUuid('t1', 's', 'customers', 'c2') === id).toBe(false);
    expect(deterministicUuid('t1', 's', 'cust', 'omers\u0000c1') === id).toBe(false);
  });
});
