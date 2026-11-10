import { describe, it, expect, beforeEach } from 'vitest';
import { applyDensity, readDensity, setDensity, initDensity, isDensity, DENSITY_STORAGE_KEY } from './density';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('density', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-density');
    localStorage.clear();
  });
  it('defaults to comfortable and rejects junk', () => {
    expect(readDensity(mem())).toBe('comfortable');
    const s = mem();
    s.setItem(DENSITY_STORAGE_KEY, 'ultra');
    expect(readDensity(s)).toBe('comfortable');
    expect(isDensity('compact')).toBe(true);
    expect(isDensity('x')).toBe(false);
  });
  it('compact sets data-density; comfortable removes it', () => {
    applyDensity('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    applyDensity('comfortable');
    expect(document.documentElement.hasAttribute('data-density')).toBe(false);
  });
  it('persists and restores', () => {
    setDensity('compact');
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact');
    document.documentElement.removeAttribute('data-density');
    expect(initDensity()).toBe('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });
  it('survives a throwing storage (private mode)', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readDensity(bad)).toBe('comfortable');
    expect(() => setDensity('compact', bad)).not.toThrow();
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });
});
