import { describe, it, expect } from 'vitest';
import { computeTip, dollarsToCents, firstName, maxTipCents, TIP_PRESET_PERCENTS } from './tip';

describe('computeTip', () => {
  it('returns zero for no selection', () => {
    expect(computeTip(10000, { kind: 'none' })).toEqual({ ok: true, tipCents: 0, percent: null });
    expect(computeTip(10000, null)).toEqual({ ok: true, tipCents: 0, percent: null });
  });

  it.each(TIP_PRESET_PERCENTS)('computes the %i%% preset', (percent) => {
    const r = computeTip(20000, { kind: 'percent', percent });
    expect(r).toEqual({ ok: true, tipCents: (20000 * percent) / 100, percent });
  });

  it('rounds to the nearest cent', () => {
    expect(computeTip(3333, { kind: 'percent', percent: 15 })).toMatchObject({ tipCents: 500 });
  });

  it('rejects percentages that are not presets (a forged request)', () => {
    expect(computeTip(10000, { kind: 'percent', percent: 17 }).ok).toBe(false);
    expect(computeTip(10000, { kind: 'percent', percent: 500 }).ok).toBe(false);
  });

  it('accepts a custom amount up to 100% of the invoice and rejects above it', () => {
    expect(computeTip(10000, { kind: 'custom', cents: 10000 }).ok).toBe(true);
    expect(computeTip(10000, { kind: 'custom', cents: 10001 }).ok).toBe(false);
  });

  it('lets very small invoices tip up to $50 and caps huge ones at $1,000', () => {
    expect(computeTip(1000, { kind: 'custom', cents: 5000 }).ok).toBe(true);
    expect(computeTip(1000, { kind: 'custom', cents: 5001 }).ok).toBe(false);
    expect(maxTipCents(5_000_000)).toBe(100_000);
  });

  it('rejects fractional, negative and NaN custom cents', () => {
    expect(computeTip(10000, { kind: 'custom', cents: 1.5 }).ok).toBe(false);
    expect(computeTip(10000, { kind: 'custom', cents: -1 }).ok).toBe(false);
    expect(computeTip(10000, { kind: 'custom', cents: Number.NaN }).ok).toBe(false);
  });

  it('treats a custom tip of zero as no tip', () => {
    expect(computeTip(10000, { kind: 'custom', cents: 0 })).toEqual({ ok: true, tipCents: 0, percent: null });
  });

  it('rejects an invalid base amount', () => {
    expect(computeTip(0, { kind: 'none' }).ok).toBe(false);
    expect(computeTip(12.5, { kind: 'none' }).ok).toBe(false);
  });
});

describe('dollarsToCents', () => {
  it('parses well-formed dollar strings', () => {
    expect(dollarsToCents('12')).toBe(1200);
    expect(dollarsToCents('12.5')).toBe(1250);
    expect(dollarsToCents(' 7.05 ')).toBe(705);
  });
  it('rejects everything else', () => {
    for (const bad of ['', '-1', '1.234', 'abc', '1e3', '$5', '1,000']) expect(dollarsToCents(bad)).toBeNull();
  });
});

describe('firstName', () => {
  it('only exposes the first name', () => {
    expect(firstName('Sam  Rivera')).toBe('Sam');
    expect(firstName(null)).toBe('');
  });
});
