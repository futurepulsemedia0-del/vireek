import { describe, it, expect } from 'vitest';
import { niceCeil, countTicks } from './chartScale';

describe('niceCeil', () => {
  it('never returns less than 1 and survives bad input', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-4)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
    expect(niceCeil(Infinity)).toBe(1);
  });
  it('keeps small integers exact', () => {
    expect(niceCeil(3)).toBe(3);
    expect(niceCeil(5)).toBe(5);
  });
  it('rounds up to 1/2/5/10 × 10^n', () => {
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(13)).toBe(20);
    expect(niceCeil(42)).toBe(50);
    expect(niceCeil(51)).toBe(100);
    expect(niceCeil(980)).toBe(1000);
  });
  it('always covers the max', () => {
    for (const n of [1, 6, 11, 19, 21, 99, 101, 499, 501, 12345]) expect(niceCeil(n)).toBeGreaterThanOrEqual(n);
  });
});

describe('countTicks', () => {
  it('starts at 0, ends at the nice ceiling, ascending integers', () => {
    const t = countTicks(42);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBe(50);
    expect(t.every((v, i) => Number.isInteger(v) && (i === 0 || v > t[i - 1]))).toBe(true);
  });
  it('uses one tick per unit for tiny ranges', () => {
    expect(countTicks(3)).toEqual([0, 1, 2, 3]);
  });
  it('picks round steps that divide the top exactly', () => {
    expect(countTicks(42)).toEqual([0, 25, 50]);
    expect(countTicks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(countTicks(20)).toEqual([0, 5, 10, 15, 20]);
    expect(countTicks(7)).toEqual([0, 5, 10]);
  });
  it('handles an empty series', () => {
    expect(countTicks(0)).toEqual([0, 1]);
  });
});
