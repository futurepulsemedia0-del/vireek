import { describe, expect, it } from 'vitest';
import { detectColumns, mapTable, parseDate } from './parse';

describe('statement parsing never guesses', () => {
  const H = ['Invoice #', 'Date', 'Item #', 'Qty', 'Unit Price', 'Amount'];
  it('accepts clean rows with high confidence', () => {
    const { lines } = mapTable(H, [['INV-1', '2026-03-10', 'A1', '3', '$10.00', '$30.00']]);
    expect(lines[0].reviewStatus).toBe('auto_accepted'); expect(lines[0].extendedCents).toBe(3000); expect(lines[0].confidence).toBeGreaterThan(0.85);
  });
  it('sends ambiguous dates, unreadable amounts and arithmetic mismatches to review', () => {
    const { lines } = mapTable(H, [['I1', '03/04/2026', 'A', '3', '10.00', '30.00'], ['I2', '2026-03-10', 'A', '3', '10.00', 'n/a'], ['I3', '2026-03-10', 'A', '3', '10.00', '99.00']]);
    expect(lines.map((l) => l.reviewStatus)).toEqual(['needs_review', 'needs_review', 'needs_review']);
    expect(lines[1].extendedCents).toBeNull(); // never guessed
  });
  it('resolves slash dates only when one reading is possible, and honours dmy', () => {
    expect(parseDate('13/04/2026', 'mdy')).toEqual({ value: '2026-04-13', confidence: 1 });
    expect(parseDate('03/04/2026', 'dmy').value).toBe('2026-04-03');
    expect(parseDate('31/02/2026', 'dmy').value).toBeNull();
  });
  it('treats negatives and credit-typed rows as credits with positive cents; reports missing columns', () => {
    const { lines } = mapTable([...H, 'Type'], [['C1', '2026-03-10', 'A', '1', '', '(25.00)', 'Credit Memo']]);
    expect(lines[0].isCredit).toBe(true); expect(lines[0].extendedCents).toBe(2500);
    expect(mapTable(['foo', 'bar'], [['1', '2']]).missing).toEqual(['extended', 'invoiceDate']);
    expect(detectColumns(H).sku.index).toBe(2);
  });
});
