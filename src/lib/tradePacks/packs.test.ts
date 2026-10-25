import { describe, it, expect } from 'vitest';
import {
  computeStockBalance, summarizeActivity, evaluateChemistry, langelierIndex, saturation, chemStatus, CHEM_RANGES,
} from './index';
import type { StockEntry } from './pestControl';

const e = (entry_type: string, performed_at: string, data: Record<string, unknown>, extra: Partial<StockEntry> = {}): StockEntry => ({
  entry_type, performed_at, data, voided_at: null, product_id: 'p1', ...extra,
});

describe('pest: stock balance', () => {
  it('received − used − disposed, count resets, voided ignored', () => {
    const rows = [
      e('regulated_product', '2027-01-01', { action: 'Received', quantity: 10, unit: 'lb' }),
      e('chemical_application', '2027-01-02', { amount: 2, amount_unit: 'lb' }),
      e('chemical_application', '2027-01-03', { amount: 100, amount_unit: 'lb' }, { voided_at: '2027-01-04' }),
      e('regulated_product', '2027-01-05', { action: 'Disposed', quantity: 1, unit: 'lb' }),
    ];
    expect(computeStockBalance(rows, 'p1', 'lb').balance).toBe(7);
    rows.push(e('regulated_product', '2027-01-06', { action: 'Count', quantity: 6.5, unit: 'lb' }));
    rows.push(e('chemical_application', '2027-01-07', { amount: 0.5, amount_unit: 'lb' }));
    const b = computeStockBalance(rows, 'p1', 'lb');
    expect(b.balance).toBe(6);
    expect(b.lastCountAt).toBe('2027-01-06');
  });
  it('flags unit mismatches instead of guessing conversions', () => {
    const b = computeStockBalance([e('chemical_application', '2027-01-02', { amount: 2, amount_unit: 'oz' })], 'p1', 'lb');
    expect(b).toMatchObject({ balance: 0, unitMismatches: 1 });
  });
  it('other products are ignored', () => {
    expect(computeStockBalance([e('regulated_product', '2027-01-01', { action: 'Received', quantity: 5, unit: 'lb' }, { product_id: 'p2' })], 'p1', 'lb').balance).toBe(0);
  });
});

describe('pest: activity trend', () => {
  const t = (d: string, level: number) => e('treatment', d, { pest_activity: level });
  it('new / improving / worsening / stable', () => {
    expect(summarizeActivity([t('2027-01-01', 3)]).trend).toBe('new');
    expect(summarizeActivity([t('2027-01-01', 4), t('2027-02-01', 2)])).toMatchObject({ latest: 2, previous: 4, trend: 'improving' });
    expect(summarizeActivity([t('2027-01-01', 1), t('2027-02-01', 3)]).trend).toBe('worsening');
    expect(summarizeActivity([t('2027-01-01', 2), t('2027-02-01', 2)]).trend).toBe('stable');
  });
});

describe('pool: chemistry', () => {
  it('status bands', () => {
    expect(chemStatus('ph', 7.5)).toBe('ok');
    expect(chemStatus('ph', 7.0)).toBe('low');
    expect(chemStatus('ph', 6.5)).toBe('critical_low');
    expect(chemStatus('ph', 8.0)).toBe('high');
    expect(chemStatus('fc', 0.2)).toBe('critical_low');
    expect(chemStatus('cya', 120)).toBe('critical_high');
    expect(CHEM_RANGES.salt.min).toBeLessThan(CHEM_RANGES.salt.max);
  });
  it('evaluation', () => {
    const good = evaluateChemistry({ fc: 3, tc: 3.1, ph: 7.5, ta: 100, cya: 40, ch: 300 });
    expect(good).toMatchObject({ overall: 'ok', flagged: [], combinedChlorine: 0.1 });
    const chloramines = evaluateChemistry({ fc: 1, tc: 2 });
    expect(chloramines).toMatchObject({ overall: 'attention', combinedChlorine: 1 });
    const bad = evaluateChemistry({ ph: 6.5, fc: 2 });
    expect(bad.overall).toBe('critical');
    expect(bad.flagged).toEqual(['ph']);
  });
  it('LSI is ~0 for balanced water and moves the right way', () => {
    const base = { ph: 7.5, ta: 100, cya: 40, ch: 300, temp_f: 80 };
    const lsi = langelierIndex(base)!;
    expect(Math.abs(lsi)).toBeLessThan(0.3);
    expect(saturation(lsi)).toBe('balanced');
    expect(langelierIndex({ ...base, ph: 6.8 })!).toBeLessThan(lsi);
    expect(saturation(langelierIndex({ ...base, ph: 6.8 })!)).toBe('corrosive');
    expect(saturation(langelierIndex({ ...base, ph: 8.2, ch: 600 })!)).toBe('scaling');
    expect(langelierIndex({ ...base, temp_f: 95 })!).toBeGreaterThan(lsi);
  });
  it('LSI needs pH, TA, CH and temperature', () => {
    expect(langelierIndex({ ph: 7.5, ta: 100 })).toBeNull();
  });
});
