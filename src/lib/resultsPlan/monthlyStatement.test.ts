import { describe, expect, it } from 'vitest';
import {
  buildMonthlyStatementPdf, buildSnapshot, canonicalJson, dueMonths, isSnapshot, monthShift, statementFilename, STATEMENT_GRACE_DAYS,
  type JsPdfCtor,
} from '../../../supabase/functions/_shared/results-plan/monthlyStatement';
import type { StatementLine } from '../../../supabase/functions/_shared/results-plan/statement';

const line = (o: Partial<StatementLine> = {}): StatementLine => ({
  chargeId: 'c1', jobId: 'j1', verifiedAt: '2026-04-03T10:00:00.000Z', customerLabel: 'Ann', jobType: 'repair', ruleVersion: '', status: 'posted',
  amountCents: 1000, listPriceCents: 1000, estimatedRevenueCents: null, ...o,
});
const conf = { asked: 0, confirmed: 0, denied: 0, noResponse: 0 };
const snap = (lines: StatementLine[], base = 0, c = conf) => buildSnapshot({ month: '2026-04', currency: 'USD', companyName: 'Acme', generatedAt: '2026-05-03T00:00:00.000Z', termsName: 'T1', baseFeeCents: base, lines, confirmations: c });

describe('dueMonths (idempotent monthly generation window)', () => {
  it('nothing is due before the grace period ends', () => {
    expect(dueMonths(new Date('2026-05-01T12:00:00Z'))).not.toContain('2026-04');
    expect(dueMonths(new Date(Date.UTC(2026, 4, 1 + STATEMENT_GRACE_DAYS) - 1))).not.toContain('2026-04');
  });
  it('the month becomes due exactly at month end + grace', () => {
    expect(dueMonths(new Date(Date.UTC(2026, 4, 1 + STATEMENT_GRACE_DAYS)))[0]).toBe('2026-04');
  });
  it('catches up missed months, newest first, bounded', () => {
    const m = dueMonths(new Date('2026-09-20T00:00:00Z'));
    expect(m).toEqual(['2026-08', '2026-07', '2026-06']);
  });
  it('crosses the year boundary', () => {
    expect(dueMonths(new Date('2027-01-20T00:00:00Z'))[0]).toBe('2026-12');
    expect(monthShift('2026-01', -1)).toBe('2025-12');
  });
  it('is a pure function of time: two sweeps at the same instant agree', () => {
    const t = new Date('2026-05-20T00:00:00Z');
    expect(dueMonths(t)).toEqual(dueMonths(t));
  });
});

describe('buildSnapshot / canonicalJson', () => {
  it('sorts lines deterministically and computes the summary from stored amounts only', () => {
    const s = snap([line({ chargeId: 'b', verifiedAt: '2026-04-05T00:00:00Z' }), line({ chargeId: 'a', verifiedAt: '2026-04-02T00:00:00Z', amountCents: 500, listPriceCents: 1000 })]);
    expect(s.lines.map((l) => l.chargeId)).toEqual(['a', 'b']);
    expect(s.summary.billedCents).toBe(1500);
    expect(s.summary.waivedByCapsCents).toBe(500);
    expect(s.summary.netCents).toBe(1500);
  });
  it('adds the base fee only when given and counts pending as pending', () => {
    const s = snap([line({ status: 'pending' }), line({ chargeId: 'c2', status: 'failed' })], 2900);
    expect(s.summary.netCents).toBe(1000 + 2900); // failed (retrying) charges are not counted until they post
    expect(s.pendingAtGeneration).toBe(2);
  });
  it('credited charges are not billed', () => {
    const s = snap([line({ status: 'credited' })]);
    expect(s.summary.billedCents).toBe(0);
    expect(s.summary.creditedCents).toBe(1000);
  });
  it('rejects malformed month/currency', () => {
    expect(() => buildSnapshot({ month: '2026-13', currency: 'USD', companyName: null, generatedAt: '', termsName: null, baseFeeCents: 0, lines: [], confirmations: conf })).toThrow();
    expect(() => buildSnapshot({ month: '2026-04', currency: 'usd', companyName: null, generatedAt: '', termsName: null, baseFeeCents: 0, lines: [], confirmations: conf })).toThrow();
  });
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
  it('isSnapshot guards what is read back from the database', () => {
    expect(isSnapshot(snap([line()]))).toBe(true);
    expect(isSnapshot({})).toBe(false);
    expect(isSnapshot(null)).toBe(false);
    expect(isSnapshot({ ...snap([]), version: 99 })).toBe(false);
  });
});

class FakePdf {
  static last: FakePdf; texts: string[] = []; pages = 1; cur = 1;
  constructor(_o: Record<string, unknown>) { FakePdf.last = this; }
  setFont() {} setFontSize() {} setTextColor() {} setDrawColor() {} setLineWidth() {} setFillColor() {} line() {} rect() {}
  text(t: string) { this.texts.push(t); }
  splitTextToSize(t: string) { return [t]; }
  addPage() { this.pages++; } getNumberOfPages() { return this.pages; } setPage(p: number) { this.cur = p; }
  output() { return new Uint8Array([37, 80, 68, 70]).buffer; }
}

describe('buildMonthlyStatementPdf', () => {
  it('renders totals, items and returns bytes', () => {
    const out = buildMonthlyStatementPdf(FakePdf as unknown as JsPdfCtor, snap([line()], 0, { asked: 3, confirmed: 2, denied: 1, noResponse: 0 }));
    expect(out).toBeInstanceOf(Uint8Array);
    const all = FakePdf.last.texts.join('|');
    expect(all).toContain('Results Plan statement');
    expect(all).toContain('$10.00');
    expect(all).toContain('Customer confirmations');
    expect(all).toContain('Ann');
  });
  it('omits the confirmations block when nobody was asked', () => {
    buildMonthlyStatementPdf(FakePdf as unknown as JsPdfCtor, snap([line()]));
    expect(FakePdf.last.texts.join('|')).not.toContain('Customer confirmations');
  });
  it('paginates long statements', () => {
    const many = Array.from({ length: 120 }, (_, i) => line({ chargeId: `c${i}`, jobId: `j${i}` }));
    buildMonthlyStatementPdf(FakePdf as unknown as JsPdfCtor, snap(many));
    expect(FakePdf.last.pages).toBeGreaterThan(1);
  });
  it('an empty month still renders', () => {
    buildMonthlyStatementPdf(FakePdf as unknown as JsPdfCtor, snap([]));
    expect(FakePdf.last.texts.join('|')).toContain('No verified jobs in this month.');
  });
  it('filename is stable and safe', () => expect(statementFilename('2026-04')).toBe('vireek-results-plan-statement-2026-04.pdf'));
});
