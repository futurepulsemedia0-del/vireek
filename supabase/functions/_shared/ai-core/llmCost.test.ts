import { describe, it, expect } from 'vitest';
import { computeCost, multipliersFor, readCostFlags, DEFAULT_MULTIPLIERS } from './llmCost.ts';

const price = { inputPer1M: 3, outputPer1M: 15 };
const m = DEFAULT_MULTIPLIERS.anthropic;

describe('readCostFlags', () => {
  it('is OFF by default and only the literal "1" enables a flag', () => {
    expect(readCostFlags(() => undefined)).toEqual({ promptCache: false, responseCache: false, batch: false });
    expect(readCostFlags(() => 'true')).toEqual({ promptCache: false, responseCache: false, batch: false });
    const f = readCostFlags((n) => (n === 'AI_BATCH_MODE' ? '1' : undefined));
    expect(f).toEqual({ promptCache: false, responseCache: false, batch: true });
  });
});

describe('computeCost', () => {
  it('equals the plain formula when nothing is cached or batched', () => {
    const r = computeCost(price, { inputTokens: 1_000_000, outputTokens: 100_000 }, m);
    expect(r.costUsd).toBeCloseTo(3 + 1.5, 9);
    expect(r.savedUsd).toBe(0);
  });
  it('prices cache reads at 0.1x and writes at 1.25x of input', () => {
    const r = computeCost(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, m);
    expect(r.costUsd).toBeCloseTo(0.3 + 3.75, 9);
    expect(r.listCostUsd).toBeCloseTo(6, 9);
    expect(r.savedUsd).toBeCloseTo(6 - 4.05, 9);
  });
  it('a cache write costs MORE than list price (no hidden saving on the first call)', () => {
    const r = computeCost(price, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000 }, m);
    expect(r.costUsd).toBeGreaterThan(r.listCostUsd);
    expect(r.savedUsd).toBe(0);
  });
  it('halves everything for a batched call', () => {
    const plain = computeCost(price, { inputTokens: 1000, outputTokens: 1000 }, m).costUsd;
    const batched = computeCost(price, { inputTokens: 1000, outputTokens: 1000 }, m, true);
    expect(batched.costUsd).toBeCloseTo(plain / 2, 12);
    expect(batched.savedUsd).toBeCloseTo(plain / 2, 12);
  });
  it('clamps negative or missing counts to zero', () => {
    expect(computeCost(price, { inputTokens: -5, outputTokens: -5, cacheReadTokens: -1 }, m).costUsd).toBe(0);
  });
});

describe('multipliersFor', () => {
  it('providers without a documented discount get no assumed saving', () => {
    expect(multipliersFor('groq')).toEqual({ cacheReadMult: 1, cacheWriteMult: 1, batchMult: 1 });
  });
  it('applies a valid override and ignores junk', () => {
    expect(multipliersFor('anthropic', JSON.stringify({ anthropic: { cacheReadMult: 0.2 } })).cacheReadMult).toBe(0.2);
    expect(multipliersFor('anthropic', JSON.stringify({ anthropic: { cacheReadMult: -1 } })).cacheReadMult).toBe(0.1);
    expect(multipliersFor('anthropic', '{not json').batchMult).toBe(0.5);
  });
});
