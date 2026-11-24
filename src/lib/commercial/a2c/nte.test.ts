import { describe, expect, it } from 'vitest';
import { computeNteBurnDown } from './nte';

const base = { approvedAmountCents: 100_000, billedCents: 0, openCostCents: 0, warnPct: 80, blockPct: 100 };

describe('NTE burn-down thresholds', () => {
  it('ok below the warn threshold', () => {
    expect(computeNteBurnDown({ ...base, openCostCents: 79_999 })).toMatchObject({ level: 'ok', requiresChangeOrder: false });
  });
  it('warns at exactly 80% (default)', () => {
    expect(computeNteBurnDown({ ...base, openCostCents: 80_000 })).toMatchObject({ level: 'warn', pct: 80, remainingCents: 20_000 });
  });
  it('100% is still allowed; a cent over needs a change order', () => {
    expect(computeNteBurnDown({ ...base, billedCents: 100_000 })).toMatchObject({ level: 'warn', requiresChangeOrder: false });
    expect(computeNteBurnDown({ ...base, billedCents: 100_000, openCostCents: 1 })).toMatchObject({ level: 'exceeded', requiresChangeOrder: true });
  });
  it('adds billed and open cost together', () => {
    expect(computeNteBurnDown({ ...base, billedCents: 60_000, openCostCents: 30_000 }).level).toBe('warn');
  });
  it('custom thresholds are honoured', () => {
    expect(computeNteBurnDown({ ...base, warnPct: 50, openCostCents: 50_000 }).level).toBe('warn');
    expect(computeNteBurnDown({ ...base, blockPct: 110, openCostCents: 110_000 }).level).toBe('warn');
    expect(computeNteBurnDown({ ...base, blockPct: 110, openCostCents: 110_001 }).level).toBe('exceeded');
  });
  it('without an approved amount there is nothing to burn', () => {
    expect(computeNteBurnDown({ ...base, approvedAmountCents: null })).toMatchObject({ level: 'none', pct: null, requiresChangeOrder: false });
  });
  it('ignores negative inputs', () => {
    expect(computeNteBurnDown({ ...base, billedCents: -5, openCostCents: -9 }).committedCents).toBe(0);
  });
});

describe('change-order flow (domain view)', () => {
  it('raising the approved amount clears the requirement', () => {
    const before = computeNteBurnDown({ ...base, billedCents: 120_000 });
    expect(before.requiresChangeOrder).toBe(true);
    const after = computeNteBurnDown({ ...base, approvedAmountCents: 150_000, billedCents: 120_000 });
    expect(after.requiresChangeOrder).toBe(false);
    expect(after.level).toBe('warn');
  });
});
