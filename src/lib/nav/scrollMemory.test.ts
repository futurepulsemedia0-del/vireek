import { describe, expect, it } from 'vitest';
import { createScrollStore, decideScroll, parseSnapshot } from '@/lib/nav/scrollMemory';

const L = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

describe('decideScroll', () => {
  it('restores on POP', () => expect(decideScroll('POP', L('/a'), L('/b'))).toBe('restore'));
  it('tops on new page', () => expect(decideScroll('PUSH', L('/a'), L('/b'))).toBe('top'));
  it('keeps position on search-only change', () => expect(decideScroll('PUSH', L('/a'), L('/a', '?q=1'))).toBe('keep'));
  it('anchors on hash', () => expect(decideScroll('PUSH', L('/a'), L('/a', '', '#x'))).toBe('anchor'));
});

describe('scroll store', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it('round-trips through storage and evicts oldest', () => {
    const kv = mem();
    const s = createScrollStore(kv, 'k', 2);
    s.set('a', { window: { x: 0, y: 10 }, inner: {} });
    s.set('b', { window: { x: 0, y: 20 }, inner: { list: { x: 0, y: 5 } } });
    s.set('c', { window: { x: 0, y: 30 }, inner: {} });
    const again = createScrollStore(kv, 'k', 2);
    expect(again.get('a')).toBeNull();
    expect(again.get('b')?.inner.list?.y).toBe(5);
  });
  it('survives corrupt storage and rejects bad snapshots', () => {
    expect(createScrollStore({ getItem: () => '{oops', setItem: () => undefined }).get('x')).toBeNull();
    expect(parseSnapshot({ window: { x: NaN, y: 1 } })).toBeNull();
  });
});
