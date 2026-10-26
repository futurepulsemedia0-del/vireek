import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deadlineRisk, mergeFindings, programFreshness, rebateFor, resolveProgram, runAudit, summarize,
} from './engine';
import { addMonths, daysBetween, formatMoney, mulBps, normInvoiceNo, parseMoneyToCents, roundCents, todayInZone } from './money';
import { canApprove, canMarkSent, buildDraftMessage, missingItems, type PacketFinding } from './packet';
import { suggestDepositMatches } from './reconcile';
import { canManageSupplierAudit } from './access';
import type { AuditInput, CreditMemo, Program, StatementLine, StatementMeta, WarrantyClaimLite } from './types';

const NOW = new Date('2026-10-25T12:00:00Z');
const V1 = 'v1'; const V2 = 'v2';

const stmt = (o: Partial<StatementMeta> = {}): StatementMeta => ({
  id: 's1', vendorId: V1, periodStart: '2026-01-01', periodEnd: '2026-09-30', currency: 'USD', parseStatus: 'reviewed', fileName: 'a.csv', ...o,
});
let seq = 0;
const line = (o: Partial<StatementLine> = {}): StatementLine => ({
  id: `l${++seq}`, statementId: 's1', lineNo: seq, invoiceNo: 'INV-1', invoiceDate: '2026-03-10', sku: 'A', description: null,
  qty: 1, unitPriceCents: 1000, extendedCents: 1000, isCredit: false, currency: 'USD', confidence: 0.99, reviewStatus: 'auto_accepted', ...o,
});
const prog = (o: Partial<Program> = {}): Program => ({
  id: 'p1', vendorId: V1, name: '2026 Rebate', type: 'volume_rebate', status: 'active', periodStart: '2026-01-01', periodEnd: '2026-06-30',
  currency: 'USD', enrollment: 'enrolled', claimDeadline: '2026-12-31', requiredDocuments: [], documentsOnFile: [],
  sourceUrl: 'https://example.com/program', lastVerifiedAt: '2026-06-01',
  tiers: [{ thresholdCents: 100000, rateBps: 200 }, { thresholdCents: 500000, rateBps: 400 }], tierMode: 'retroactive_all',
  priceSchedule: [], toleranceBps: 0, toleranceCents: 0, coopAccrualBps: 0, coopCapCents: null, warnings: [], ...o,
});
const memo = (o: Partial<CreditMemo> = {}): CreditMemo => ({
  id: 'm1', vendorId: V1, memoNo: 'CM-1', memoDate: '2026-08-01', amountCents: 5000, appliedCents: 0, currency: 'USD', reason: 'other',
  appliedStatus: 'unapplied', invoiceNo: null, programId: null, warrantyClaimId: null, confidence: 1, needsReview: false, ...o,
});
const input = (o: Partial<AuditInput> = {}): AuditInput => ({
  now: NOW, timeZone: 'America/Chicago', vendors: [{ id: V1, name: 'Acme Supply' }, { id: V2, name: 'Beta Wholesale' }],
  programs: [], statements: [stmt()], lines: [], creditMemos: [], warrantyClaims: [], vendorBills: [], ...o,
});
const of = (fs: ReturnType<typeof runAudit>, type: string) => fs.filter((f) => f.type === type);

describe('money helpers', () => {
  it('rounds cents half away from zero and basis points once', () => {
    expect(roundCents(2.5)).toBe(3); expect(roundCents(-2.5)).toBe(-3); expect(roundCents(1.004)).toBe(1);
    expect(mulBps(499999, 200)).toBe(10000); // 9999.98 -> 10000
    expect(mulBps(333, 100)).toBe(3);        // 3.33 -> 3
    expect(mulBps(350, 100)).toBe(4);        // 3.5 -> 4
  });
  it('parses money only when unambiguous', () => {
    expect(parseMoneyToCents('$1,234.56')).toBe(123456);
    expect(parseMoneyToCents('(45.10)')).toBe(-4510);
    expect(parseMoneyToCents('1.234,56')).toBe(123456);
    expect(parseMoneyToCents('1,234')).toBe(123400);
    expect(parseMoneyToCents('12,5')).toBeNull();
    expect(parseMoneyToCents('1.2.3')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents(19.99)).toBe(1999);
  });
  it('formats currency and normalises invoice numbers', () => {
    expect(formatMoney(123456, 'USD')).toBe('$1,234.56');
    expect(formatMoney(100, 'CAD')).toContain('1.00');
    expect(normInvoiceNo(' inv-00123 ')).toBe(normInvoiceNo('INV00123'));
    expect(normInvoiceNo('000123')).toBe('123');
  });
});

describe('time zones and deadlines', () => {
  it('uses the account time zone, not UTC, for "today"', () => {
    const t = new Date('2026-03-01T03:00:00Z');
    expect(todayInZone(t, 'America/Los_Angeles')).toBe('2026-02-28');
    expect(todayInZone(t, 'Etc/UTC')).toBe('2026-03-01');
    expect(todayInZone(t, 'Not/AZone')).toBe('2026-03-01'); // bad zone falls back safely
  });
  it('a deadline that is "today" locally is critical, not expired', () => {
    expect(deadlineRisk('2026-02-28', '2026-02-28')).toBe('critical');
    expect(deadlineRisk('2026-03-01', '2026-02-28')).toBe('expired');
  });
  it('buckets risk', () => {
    expect(deadlineRisk('2026-01-01', null)).toBe('none');
    expect(deadlineRisk('2026-01-01', '2026-01-08')).toBe('critical');
    expect(deadlineRisk('2026-01-01', '2026-01-31')).toBe('soon');
    expect(deadlineRisk('2026-01-01', '2026-03-01')).toBe('ok');
  });
  it('handles month-end and DST-safe day math', () => {
    expect(addMonths('2025-08-31', 6)).toBe('2026-02-28');
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // US DST change weekend
  });
  it('warns when a program rule is older than 12 months or never verified', () => {
    expect(programFreshness({ lastVerifiedAt: '2025-10-25' }, '2026-10-25').stale).toBe(false);
    expect(programFreshness({ lastVerifiedAt: '2025-10-24' }, '2026-10-25').stale).toBe(true);
    expect(programFreshness({ lastVerifiedAt: null }, '2026-10-25').stale).toBe(true);
  });
});

describe('tier thresholds and retroactive tier', () => {
  const spend = (cents: number, extra: Partial<AuditInput> = {}, p: Partial<Program> = {}) =>
    runAudit(input({ programs: [prog(p)], lines: [line({ extendedCents: cents, unitPriceCents: cents })], ...extra }));

  it('does nothing one cent below the first threshold, and qualifies exactly at it', () => {
    expect(of(spend(99999), 'rebate_owed')).toHaveLength(0);
    const f = of(spend(100000), 'rebate_owed');
    expect(f).toHaveLength(1);
    expect(f[0].likelyCents).toBe(2000);
    expect(f[0].label).toBe('estimate');
  });
  it('applies the top tier rate to ALL spend when retroactive, only to bands when marginal', () => {
    expect(rebateFor(prog(), 500000)).toBe(20000);
    expect(rebateFor(prog({ tierMode: 'marginal' }), 500000)).toBe(8000); // 400k*2% + 0 above
    expect(rebateFor(prog({ tierMode: 'marginal' }), 600000)).toBe(8000 + 4000);
    expect(rebateFor(prog(), 499999)).toBe(10000);
  });
  it('flags a retroactive-tier shortfall when less was received than the tier implies', () => {
    const f = of(spend(500000, { creditMemos: [memo({ reason: 'rebate', amountCents: 8000, appliedCents: 8000, appliedStatus: 'applied' })] }), 'rebate_owed');
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('retroactive_tier');
    expect(f[0].likelyCents).toBe(12000);
  });
  it('produces no finding when the full rebate was already received', () => {
    expect(of(spend(500000, { creditMemos: [memo({ reason: 'rebate', amountCents: 20000, appliedCents: 20000, appliedStatus: 'applied' })] }), 'rebate_owed')).toHaveLength(0);
  });
  it('reports spend needed to reach the next tier, as an opportunity (never summed as owed)', () => {
    const f = of(spend(300000, {}, { periodEnd: '2026-12-31', claimDeadline: null }), 'tier_gap');
    expect(f).toHaveLength(1);
    expect(f[0].isOpportunity).toBe(true);
    expect(f[0].title).toContain('200000 cents');
    expect(f[0].likelyCents).toBe(20000 - 6000); // 4% of 500k minus 2% of 300k
    expect(of(spend(300000, {}, { periodEnd: '2026-12-31', claimDeadline: null }), 'rebate_accruing')[0].isOpportunity).toBe(true);
  });
  it('never promises eligibility: unknown enrollment or stale rules force low = 0 and lower confidence', () => {
    const unknown = of(spend(500000, {}, { enrollment: 'unknown' }), 'rebate_owed')[0];
    expect(unknown.lowCents).toBe(0); expect(unknown.likelyCents).toBe(20000); expect(unknown.confidence).toBeLessThan(0.7);
    const stale = of(spend(500000, {}, { lastVerifiedAt: '2024-01-01' }), 'rebate_owed')[0];
    expect(stale.lowCents).toBe(0); expect(stale.warnings.join(' ')).toContain('verified');
    const ok = of(spend(500000), 'rebate_owed')[0];
    expect(ok.lowCents).toBe(20000);
    expect(of(spend(500000, {}, { enrollment: 'not_enrolled' }), 'rebate_owed')).toHaveLength(0);
  });
  it('does not claim after the claim deadline has passed', () => {
    expect(of(spend(500000, {}, { claimDeadline: '2026-10-01' }), 'rebate_owed')).toHaveLength(0);
  });
  it('counts a carried-over invoice once and nets credit lines', () => {
    const s2 = stmt({ id: 's2', periodStart: '2026-04-01', periodEnd: '2026-06-30' });
    const out = runAudit(input({
      programs: [prog()], statements: [stmt(), s2],
      lines: [line({ invoiceNo: 'INV-9', extendedCents: 300000 }), line({ statementId: 's2', invoiceNo: 'INV-9', extendedCents: 300000 }),
        line({ invoiceNo: 'INV-10', extendedCents: 50000 }), line({ invoiceNo: 'CR-1', extendedCents: 250000, isCredit: true })],
    }));
    // 300000 (once) + 50000 - 250000 = 100000 -> first tier -> 2000
    expect(of(out, 'rebate_owed')[0].likelyCents).toBe(2000);
  });
  it('falls back to AP bill totals with a confidence penalty and low = 0', () => {
    const out = runAudit(input({ programs: [prog()], lines: [], vendorBills: [
      { id: 'b1', vendorId: V1, billNumber: 'X1', amountCents: 500000, billDate: '2026-02-01', status: 'paid' },
      { id: 'b2', vendorId: V1, billNumber: 'X1', amountCents: 500000, billDate: '2026-02-01', status: 'paid' }] }));
    const f = of(out, 'rebate_owed')[0];
    expect(f.likelyCents).toBe(20000); // the duplicated bill is not double-counted in spend
    expect(f.lowCents).toBe(0); expect(f.warnings.join(' ')).toContain('AP bill totals');
  });
});

describe('low-confidence parsing is never guessed', () => {
  const base = [line({ invoiceNo: 'A1', extendedCents: 100000 })];
  it('excludes pending lines from low/likely, includes them only in the upper bound, and says so', () => {
    const pend = line({ invoiceNo: 'A2', extendedCents: 400000, confidence: 0.6, reviewStatus: 'needs_review' });
    const f = of(runAudit(input({ programs: [prog()], lines: [...base, pend] })), 'rebate_owed')[0];
    expect(f.likelyCents).toBe(2000); expect(f.highCents).toBe(20000);
    expect(f.warnings.join(' ')).toContain('awaiting review');
  });
  it('a high confidence score alone is not acceptance unless the line was auto-accepted or confirmed', () => {
    const l = line({ invoiceNo: 'A3', extendedCents: 400000, confidence: 0.99, reviewStatus: 'needs_review' });
    expect(of(runAudit(input({ programs: [prog()], lines: [...base, l] })), 'rebate_owed')[0].likelyCents).toBe(2000);
  });
  it('a human-confirmed line is counted; a rejected line never is', () => {
    const c = line({ invoiceNo: 'A2', extendedCents: 400000, confidence: 0.4, reviewStatus: 'confirmed' });
    expect(of(runAudit(input({ programs: [prog()], lines: [...base, c] })), 'rebate_owed')[0].likelyCents).toBe(20000);
    const r = line({ invoiceNo: 'A2', extendedCents: 400000, reviewStatus: 'rejected' });
    expect(of(runAudit(input({ programs: [prog()], lines: [...base, r] })), 'rebate_owed')[0].likelyCents).toBe(2000);
  });
  it('lines with unreadable amounts, no date, or another currency are not counted', () => {
    const lines = [...base, line({ invoiceNo: 'B', extendedCents: null }), line({ invoiceNo: 'C', invoiceDate: null, extendedCents: 400000 }),
      line({ invoiceNo: 'D', currency: 'CAD', extendedCents: 400000 })];
    const f = of(runAudit(input({ programs: [prog()], lines })), 'rebate_owed')[0];
    expect(f.likelyCents).toBe(2000);
    expect(f.warnings.join(' ')).toContain('another currency');
    expect(f.warnings.join(' ')).toContain('without an invoice date');
  });
});

describe('price-agreement deviations', () => {
  const pa = (o: Partial<Program> = {}) => prog({ type: 'price_agreement', tiers: [], priceSchedule: [{ sku: 'A', unitPriceCents: 1000 }], toleranceBps: 100, periodEnd: '2026-12-31', ...o });
  const run = (ls: StatementLine[], p = pa()) => of(runAudit(input({ programs: [p], lines: ls })), 'price_deviation');

  it('ignores differences at or within tolerance and flags the first cent beyond it', () => {
    expect(run([line({ unitPriceCents: 1010, qty: 3, extendedCents: 3030 })])).toHaveLength(0); // tol = 10
    const f = run([line({ unitPriceCents: 1011, qty: 3, extendedCents: 3033 })]);
    expect(f).toHaveLength(1); expect(f[0].likelyCents).toBe(33); expect(f[0].lowCents).toBe(33);
  });
  it('rounds fractional quantities once and uses the larger of cents / bps tolerance', () => {
    expect(run([line({ unitPriceCents: 1011, qty: 2.5, extendedCents: 2528 })])[0].likelyCents).toBe(28); // 27.5 -> 28
    expect(run([line({ unitPriceCents: 1030, qty: 1, extendedCents: 1030 })], pa({ toleranceCents: 40 }))).toHaveLength(0);
  });
  it('subtracts credit lines for the same invoice and SKU', () => {
    const f = run([line({ unitPriceCents: 1011, qty: 3, extendedCents: 3033 }), line({ isCredit: true, extendedCents: 20, unitPriceCents: null, qty: null })]);
    expect(f[0].likelyCents).toBe(13);
  });
  it('lines awaiting review are only an upper bound; low stays 0', () => {
    const f = run([line({ unitPriceCents: 1100, qty: 1, extendedCents: 1100, confidence: 0.5, reviewStatus: 'needs_review' })]);
    expect(f).toHaveLength(1); expect(f[0].likelyCents).toBe(0); expect(f[0].highCents).toBe(100); expect(f[0].lowCents).toBe(0);
  });
  it('ignores SKUs not in the agreement and lines outside the program period', () => {
    expect(run([line({ sku: 'ZZZ', unitPriceCents: 9999 }), line({ unitPriceCents: 2000, invoiceDate: '2027-02-01' })])).toHaveLength(0);
  });
});

describe('unapplied credit memos', () => {
  const run = (m: CreditMemo[]) => of(runAudit(input({ creditMemos: m })), 'unapplied_credit');
  it('flags an old unapplied credit with low = full amount', () => {
    const f = run([memo()]); expect(f).toHaveLength(1);
    expect([f[0].lowCents, f[0].likelyCents, f[0].highCents]).toEqual([5000, 5000, 5000]);
  });
  it('a young memo is inside the grace period: low = 0 but still listed', () => {
    const f = run([memo({ memoDate: '2026-10-20' })]); expect(f[0].lowCents).toBe(0); expect(f[0].likelyCents).toBe(5000);
  });
  it('uses only the remaining balance of a partially applied memo; applied and void are ignored', () => {
    expect(run([memo({ appliedCents: 2000, appliedStatus: 'partially_applied' })])[0].likelyCents).toBe(3000);
    expect(run([memo({ appliedStatus: 'applied', appliedCents: 5000 }), memo({ id: 'm2', appliedStatus: 'void' })])).toHaveLength(0);
  });
  it('a low-confidence memo is never counted in low/likely', () => {
    const f = run([memo({ confidence: 0.4, needsReview: true })]); expect(f[0].likelyCents).toBe(0); expect(f[0].highCents).toBe(5000);
  });
});

describe('warranty credits', () => {
  const claim = (o: Partial<WarrantyClaimLite> = {}): WarrantyClaimLite => ({
    id: 'w1', vendorId: V1, label: 'Smith – compressor', status: 'approved', submittedAt: '2026-08-01', claimDeadline: '2026-12-01',
    claimedCents: 60000, approvedCents: 50000, creditReceivedCents: null, ...o,
  });
  const run = (c: WarrantyClaimLite[], m: CreditMemo[] = []) => runAudit(input({ warrantyClaims: c, creditMemos: m })).filter((f) => f.type.startsWith('warranty'));
  it('flags an approved claim with no credit after the grace period', () => {
    const f = run([claim()]); expect(f).toHaveLength(1);
    expect(f[0].type).toBe('warranty_credit_missing'); expect(f[0].lowCents).toBe(50000); expect(f[0].deadlineRisk).toBe('ok');
  });
  it('waits out the grace period and ignores claims that already have a credit or a linked memo', () => {
    expect(run([claim({ submittedAt: '2026-10-10' })])).toHaveLength(0);
    expect(run([claim({ creditReceivedCents: 10 })])).toHaveLength(0);
    expect(run([claim()], [memo({ warrantyClaimId: 'w1', amountCents: 50000 })])).toHaveLength(0);
  });
  it('a merely submitted claim never counts toward low/likely', () => {
    const f = run([claim({ status: 'submitted', approvedCents: null })]); expect(f[0].lowCents).toBe(0); expect(f[0].likelyCents).toBe(0); expect(f[0].highCents).toBe(60000);
  });
  it('detects a credit lower than the approved amount', () => {
    const f = run([claim({ status: 'credit_received', creditReceivedCents: 30000 })]);
    expect(f[0].type).toBe('warranty_credit_short'); expect(f[0].likelyCents).toBe(20000);
    expect(run([claim({ status: 'credit_received', creditReceivedCents: 50000 })])).toHaveLength(0);
  });
});

describe('co-op', () => {
  const coop = (o: Partial<Program> = {}) => prog({ type: 'co_op', tiers: [], coopAccrualBps: 200, requiredDocuments: ['Ad proof'], documentsOnFile: [], periodEnd: '2026-12-31', claimDeadline: '2027-02-15', ...o });
  const run = (p: Program, m: CreditMemo[] = []) => of(runAudit(input({ programs: [p], lines: [line({ extendedCents: 1000000 })], creditMemos: m })), 'coop_unclaimed');
  it('accrues on spend, subtracts claimed, and requires proof for low', () => {
    const f = run(coop())[0];
    expect(f.likelyCents).toBe(20000); expect(f.lowCents).toBe(0); expect(f.warnings.join(' ')).toContain('Ad proof');
    expect(run(coop({ documentsOnFile: ['Ad proof'] }))[0].lowCents).toBe(20000);
    expect(run(coop({ documentsOnFile: ['Ad proof'] }), [memo({ reason: 'co_op', amountCents: 5000, appliedCents: 5000, appliedStatus: 'applied' })])[0].likelyCents).toBe(15000);
  });
  it('respects the cap and shows lapsed claims as 0 likely', () => {
    expect(run(coop({ coopCapCents: 7500 }))[0].likelyCents).toBe(7500);
    const lapsed = run(coop({ claimDeadline: '2026-09-01' }))[0];
    expect(lapsed.kind).toBe('deadline_passed'); expect(lapsed.likelyCents).toBe(0); expect(lapsed.deadlineRisk).toBe('expired');
  });
});

describe('duplicate invoices', () => {
  const run = (o: Partial<AuditInput>) => of(runAudit(input(o)), 'duplicate_invoice');
  it('flags identical lines repeated on ONE statement but not open items carried across statements', () => {
    const d = [line({ invoiceNo: 'D1', extendedCents: 7000 }), line({ invoiceNo: 'd-1', extendedCents: 7000 })];
    const f = run({ lines: d }); expect(f).toHaveLength(1); expect(f[0].likelyCents).toBe(7000); expect(f[0].lowCents).toBe(0);
    const s2 = stmt({ id: 's2', periodStart: '2026-10-01', periodEnd: '2026-10-31' });
    expect(run({ statements: [stmt(), s2], lines: [line({ invoiceNo: 'D1', extendedCents: 7000 }), line({ statementId: 's2', invoiceNo: 'D1', extendedCents: 7000 })] })).toHaveLength(0);
  });
  it('treats the same total under different invoice numbers only as a weak upper-bound signal', () => {
    const f = run({ lines: [line({ invoiceNo: 'E1', extendedCents: 9000 }), line({ invoiceNo: 'E2', extendedCents: 9000 })] });
    expect(f).toHaveLength(1); expect(f[0].likelyCents).toBe(0); expect(f[0].highCents).toBe(9000); expect(f[0].confidenceBand).toBe('low');
  });
  it('a bill paid twice in AP is the strongest signal', () => {
    const f = run({ vendorBills: [
      { id: 'b1', vendorId: V1, billNumber: 'P-7', amountCents: 12000, billDate: '2026-05-01', status: 'paid' },
      { id: 'b2', vendorId: V1, billNumber: 'p7', amountCents: 12000, billDate: '2026-05-09', status: 'paid' }] });
    expect(f).toHaveLength(1); expect(f[0].kind).toBe('paid_twice'); expect(f[0].lowCents).toBe(12000);
  });
});

describe('idempotent re-runs', () => {
  const fixedLines = [line({ extendedCents: 500000 })];
  const data = () => input({ programs: [prog()], lines: fixedLines, creditMemos: [memo()] });
  it('runAudit is deterministic and never emits a key twice', () => {
    const a = runAudit(data()); const b = runAudit(data());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(new Set(a.map((f) => f.dedupeKey)).size).toBe(a.length);
  });
  it('merging the same run again creates no duplicates; dismissed findings stay dismissed', () => {
    const a = runAudit(data());
    const first = mergeFindings<{ dedupeKey: string; status: string; fingerprint: string }>([], a);
    expect(first.inserted).toBe(a.length);
    const rows = first.rows.map((r) => ({ dedupeKey: r.dedupeKey, fingerprint: r.fingerprint, status: r.dedupeKey === a[0].dedupeKey ? 'dismissed' : 'open' }));
    const second = mergeFindings(rows, a);
    expect(second.inserted).toBe(0); expect(second.updated).toBe(0); expect(second.rows).toHaveLength(a.length);
    expect(second.rows.find((r) => r.dedupeKey === a[0].dedupeKey)?.status).toBe('dismissed');
  });
  it('a finding that disappears is superseded and reopens if it returns', () => {
    const a = runAudit(data());
    const rows = a.map((f) => ({ dedupeKey: f.dedupeKey, fingerprint: f.fingerprint, status: 'open' }));
    const gone = mergeFindings(rows, []); expect(gone.superseded).toBe(a.length);
    const back = mergeFindings(gone.rows as typeof rows, a); expect(back.updated).toBe(a.length);
    expect(back.rows.every((r) => r.status === 'open')).toBe(true);
  });
});

describe('summary keeps estimated and recovered separate', () => {
  it('never adds recovered into estimated, and excludes opportunities and closed findings', () => {
    const s = summarize([
      { status: 'open', is_opportunity: false, low_cents: 100, likely_cents: 200, high_cents: 300, recovered_cents: 0 },
      { status: 'partially_recovered', is_opportunity: false, low_cents: 0, likely_cents: 1000, high_cents: 1000, recovered_cents: 400 },
      { status: 'recovered', is_opportunity: false, low_cents: 0, likely_cents: 500, high_cents: 500, recovered_cents: 500 },
      { status: 'dismissed', is_opportunity: false, low_cents: 9, likely_cents: 9, high_cents: 9, recovered_cents: 0 },
      { status: 'open', is_opportunity: true, low_cents: 0, likely_cents: 777, high_cents: 777, recovered_cents: 0 },
    ]);
    expect(s.estimatedLikelyCents).toBe(200 + 600); expect(s.recoveredCents).toBe(900); expect(s.opportunityCents).toBe(777);
  });
});

describe('resolveProgram (rules are data, with per-account overrides)', () => {
  it('merges overrides over rules and drops invalid rows with a warning', () => {
    const p = resolveProgram({
      id: 'p', vendor_id: V1, name: 'X', program_type: 'volume_rebate', status: 'active', period_start: '2026-01-01', period_end: '2026-12-31', currency: 'USD',
      rules: { tiers: [{ threshold_cents: 500000, rate_bps: 400 }, { threshold_cents: 100000, rate_bps: 200 }, { threshold_cents: -5, rate_bps: 1 }], tier_mode: 'marginal' },
      rules_override: { tier_mode: 'retroactive_all', tolerance_bps: 50 }, enrollment_status: 'enrolled', claim_deadline: null,
      required_documents: null, documents_on_file: null, source_url: null, last_verified_at: null,
    });
    expect(p.tiers.map((t) => t.thresholdCents)).toEqual([100000, 500000]);
    expect(p.tierMode).toBe('retroactive_all'); expect(p.toleranceBps).toBe(50); expect(p.warnings).toHaveLength(1);
  });
});

describe('claim packet and approval gate', () => {
  const f: PacketFinding = { id: 'f1', title: 't', summary: 'Spend reached tier.', type: 'rebate_owed', currency: 'USD', low_cents: 1000, likely_cents: 2000, high_cents: 3000, confidence: 0.8,
    deadline: '2026-11-01', evidence: [{ kind: 'statement_line', id: 'l1', label: 'x' }], warnings: [], how_calculated: [] };
  it('cannot be marked sent unless a human approved it', () => {
    expect(canMarkSent({ status: 'draft', approved_at: null, approved_by: null })).toBe(false);
    expect(canMarkSent({ status: 'approved', approved_at: '2026-10-25T00:00:00Z', approved_by: null })).toBe(false);
    expect(canMarkSent({ status: 'approved', approved_at: '2026-10-25T00:00:00Z', approved_by: 'u1' })).toBe(true);
    expect(canApprove({ status: 'draft', approved_at: null, approved_by: null })).toBe(true);
    expect(canApprove({ status: 'marked_sent', approved_at: 'x', approved_by: 'u' })).toBe(false);
  });
  it('flags missing items before the deadline and never asserts eligibility in the draft', () => {
    const items = missingItems(f, prog({ requiredDocuments: ['W-9'], sourceUrl: null, enrollment: 'unknown' }), '2026-10-25');
    expect(items.filter((i) => !i.ok).map((i) => i.label)).toEqual(expect.arrayContaining(['Required document: W-9', 'Enrollment confirmed']));
    expect(items.find((i) => i.label.startsWith('Deadline'))?.ok).toBe(false);
    const msg = buildDraftMessage(f, 'Acme Supply', 'Smith HVAC', prog());
    expect(msg).toContain('our own estimate'); expect(msg).not.toMatch(/you owe|you must|entitled/i);
  });
});

describe('bank deposit suggestions (confirmation loop)', () => {
  const fnd = { vendorName: 'Acme Supply Co', lowCents: 1000, likelyCents: 2000, highCents: 3000, firstSeenDate: '2026-10-01' };
  const tx = (o: Record<string, unknown>) => ({ id: 't', postedDate: '2026-10-10', amountCents: 2000, description: 'ACME DEPOSIT', ...o }) as Parameters<typeof suggestDepositMatches>[1][number];
  it('matches deposits only: positive, after the finding, not already used, with a plausible amount', () => {
    expect(suggestDepositMatches(fnd, [tx({ id: 'a' })], new Set())).toHaveLength(1);
    expect(suggestDepositMatches(fnd, [tx({ id: 'a', amountCents: -2000 })], new Set())).toHaveLength(0);
    expect(suggestDepositMatches(fnd, [tx({ id: 'a', postedDate: '2026-09-30' })], new Set())).toHaveLength(0);
    expect(suggestDepositMatches(fnd, [tx({ id: 'a' })], new Set(['a']))).toHaveLength(0);
    expect(suggestDepositMatches(fnd, [tx({ id: 'a', amountCents: 987654 })], new Set())).toHaveLength(0);
    expect(suggestDepositMatches(fnd, [tx({ id: 'a', description: 'RANDOM PAYER', amountCents: 1999 })], new Set())).toHaveLength(0);
  });
});

describe('role gate', () => {
  it('allows only the owner or office staff with billing access', () => {
    expect(canManageSupplierAudit(true, {})).toBe(true);
    expect(canManageSupplierAudit(false, { can_view_billing: true })).toBe(true);
    expect(canManageSupplierAudit(false, { can_view_billing: false })).toBe(false);
    expect(canManageSupplierAudit(false, null)).toBe(false);
  });
});

describe('tenant isolation (static check of the migration)', () => {
  const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20271122000000_supplier_entitlement_audit.sql'), 'utf8');
  const tables = ['supplier_programs', 'supplier_statements', 'supplier_statement_lines', 'supplier_credit_memos',
    'supplier_audit_findings', 'supplier_claim_packets', 'supplier_recoveries', 'supplier_audit_log'];
  it('enables RLS on every tenant table through the shared policy loop', () => {
    for (const t of tables) expect(sql).toContain(`'${t}'`);
    expect(sql).toContain("ALTER TABLE %I ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain('ALTER TABLE supplier_parse_usage ENABLE ROW LEVEL SECURITY');
  });
  it('scopes every policy by get_account_owner_id() and the role gate, never USING (true)', () => {
    const policies = sql.match(/CREATE POLICY[\s\S]*?;\n/g) ?? [];
    expect(policies.length).toBeGreaterThan(0);
    expect(sql).not.toMatch(/USING\s*\(\s*true\s*\)/i);
    expect(sql).not.toMatch(/WITH CHECK\s*\(\s*true\s*\)/i);
    expect(sql.match(/user_id = public\.get_account_owner_id\(\) AND public\.sa_can_manage\(\)/g)!.length).toBeGreaterThanOrEqual(5);
  });
  it('findings, packets, recoveries and the log have no client write policy', () => {
    const readOnly = sql.slice(sql.indexOf('Read-only for clients'), sql.indexOf('5. INTERNAL LOG HELPER'));
    expect(readOnly).toContain('FOR SELECT');
    expect(readOnly).not.toMatch(/FOR (INSERT|UPDATE|DELETE)/);
  });
  it('every RPC is SECURITY DEFINER with a pinned search_path and a role check, and the ledger is append-only', () => {
    for (const fn of ['sa_upsert_findings', 'sa_dismiss_finding', 'sa_reopen_finding', 'sa_save_packet', 'sa_approve_packet', 'sa_mark_packet_sent', 'sa_confirm_recovery', 'sa_sync_warranty_recoveries']) {
      const start = sql.indexOf(`FUNCTION public.${fn}(`); expect(start).toBeGreaterThan(0);
      const body = sql.slice(start, sql.indexOf('$$;', sql.indexOf('AS $$', start) + 5));
      expect(body).toContain('SECURITY DEFINER SET search_path = public'); expect(body).toContain('sa_assert_manage()');
    }
    expect(sql).toContain('trg_supplier_recoveries_immutable'); expect(sql).toContain('trg_supplier_audit_log_immutable');
    expect(sql).toContain("CHECK (status <> 'marked_sent' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL))");
  });
});
