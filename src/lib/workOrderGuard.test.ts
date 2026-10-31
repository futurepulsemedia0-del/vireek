import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SERVICECHANNEL_DEFAULTS, auditToCsv, evaluateOrder, mergeRules, previousQuarter, runAudit, validateRules,
  type FlagCode, type PortalRules, type WorkOrder,
} from './workOrderGuard';
import { parseWorkOrderCsv } from './workOrderGuardImport';

const TZ = 'America/New_York';
/** New York wall-clock (EDT, UTC-4) -> ISO instant. */
const ny = (s: string) => new Date(`${s.replace(' ', 'T')}:00-04:00`).toISOString();
const NOW = new Date(ny('2026-08-20 12:00'));

/** A clean, paid-quality order under the default rules (received Mon 2026-08-03 09:00 NY). */
const base = (over: Partial<WorkOrder> = {}): WorkOrder => ({
  woNumber: 'T-1', location: 'Store 1', trade: 'HVAC', priority: 'normal', nteCents: 20000, estimateCents: null,
  receivedAt: ny('2026-08-03 09:00'), acceptedAt: ny('2026-08-03 09:10'), declinedAt: null,
  checkedInAt: ny('2026-08-03 11:00'), checkInDistanceMiles: 0.05,
  proposalStatus: 'none', proposalAmountCents: null, proposalApprovedAt: null,
  completedAt: ny('2026-08-03 15:00'), invoiceNumber: 'INV-1', invoiceSubmittedAt: ny('2026-08-05 10:00'), invoiceCount: 1,
  invoiceLaborCents: 10000, invoiceTechnicians: 1, invoiceMaterialsCents: 4000, invoiceTripCents: 1000, invoiceFreightCents: 0,
  invoiceTaxCents: 0, invoiceMgmtFeeCents: 0, invoiceTotalCents: 15000, outcome: 'approved', outcomeReason: null, ...over,
});
/** An order that is only received (nothing done yet). */
const fresh = (over: Partial<WorkOrder> = {}): WorkOrder => base({
  acceptedAt: null, checkedInAt: null, checkInDistanceMiles: null, completedAt: null, invoiceNumber: null, invoiceSubmittedAt: null,
  invoiceCount: 0, invoiceLaborCents: null, invoiceTechnicians: null, invoiceMaterialsCents: null, invoiceTripCents: null,
  invoiceFreightCents: null, invoiceTaxCents: null, invoiceMgmtFeeCents: null, invoiceTotalCents: null, outcome: 'open', ...over,
});
const run = (o: WorkOrder, rules: Partial<PortalRules> = {}, now = NOW) =>
  evaluateOrder(o, { rules: { ...SERVICECHANNEL_DEFAULTS, ...rules }, timezone: TZ, now });
const codes = (o: WorkOrder, rules: Partial<PortalRules> = {}, now = NOW): FlagCode[] => run(o, rules, now).map((f) => f.code);

describe('defaults', () => {
  it('match the Jan 2025 ServiceChannel values supplied for this feature', () => {
    expect(SERVICECHANNEL_DEFAULTS).toMatchObject({
      acceptWindowMinutes: 30, acceptWindowEmergencyMinutes: 15, checkInRadiusMiles: 0.25, invoiceWithinDays: 10,
      ineligibleAfterDays: 90, invoiceMayNotExceedNte: true, allowSalesTax: false, allowManagementFee: false,
    });
    expect(SERVICECHANNEL_DEFAULTS.requiredBreakdown).toEqual(['labor', 'technicians', 'materials', 'trip', 'freight']);
  });
  it('a clean order raises no flags', () => expect(run(base())).toEqual([]));
  it('cancelled orders are never flagged', () => expect(run(base({ outcome: 'cancelled', acceptedAt: null }))).toEqual([]));
});

describe('R1 accept window', () => {
  it('passes at exactly 30 minutes, fails at 31', () => {
    expect(codes(base({ acceptedAt: ny('2026-08-03 09:30') }))).not.toContain('accept_late');
    expect(codes(base({ acceptedAt: ny('2026-08-03 09:31') }))).toContain('accept_late');
  });
  it('uses the 15-minute emergency window', () => {
    expect(codes(base({ priority: 'Emergency', acceptedAt: ny('2026-08-03 09:15') }))).not.toContain('accept_late');
    expect(codes(base({ priority: 'Emergency', acceptedAt: ny('2026-08-03 09:16') }))).toContain('accept_late');
  });
  it('flags a window that is about to close, one that closed, and ignores a distant one', () => {
    expect(codes(fresh(), {}, new Date(ny('2026-08-03 09:15')))).toEqual([]);
    const warn = run(fresh(), {}, new Date(ny('2026-08-03 09:20')));
    expect(warn.map((f) => f.code)).toEqual(['accept_expiring']);
    expect(warn[0].level).toBe('warning');
    expect(warn[0].deadline).toBe(ny('2026-08-03 09:30'));
    expect(codes(fresh(), {}, new Date(ny('2026-08-03 09:31')))).toContain('accept_missed');
  });
  it('flags a late decline and stops there for a declined order', () => {
    expect(codes(fresh({ declinedAt: ny('2026-08-03 09:45'), outcome: 'cancelled' }))).toEqual([]); // cancelled: never flagged
    expect(codes(fresh({ declinedAt: ny('2026-08-03 09:45'), outcome: 'open' }))).toEqual(['accept_late']);
    expect(codes(fresh({ declinedAt: ny('2026-08-03 09:10'), outcome: 'open' }))).toEqual([]);
  });
  it('does not call an order missed when it was clearly worked', () => {
    expect(codes(base({ acceptedAt: null }))).not.toContain('accept_missed');
  });
});

describe('R2 NTE', () => {
  const over = { invoiceLaborCents: 20000, invoiceTotalCents: 25000 }; // 20000+4000+1000 = 25000
  it('fails over NTE with no proposal and reports the excess', () => {
    const f = run(base(over)).find((x) => x.code === 'over_nte');
    expect(f?.excessCents).toBe(5000);
    expect(f?.detail).toContain('no proposal was approved');
  });
  it('passes at exactly the NTE and when NTE is unknown', () => {
    expect(codes(base({ nteCents: 15000 }))).not.toContain('over_nte');
    expect(codes(base({ ...over, nteCents: null }))).not.toContain('over_nte');
  });
  it('an approved proposal that covers the invoice passes; one that does not still fails', () => {
    expect(codes(base({ ...over, proposalStatus: 'approved', proposalAmountCents: 25000, proposalApprovedAt: ny('2026-08-03 10:00') }))).not.toContain('over_nte');
    expect(run(base({ ...over, proposalStatus: 'approved', proposalAmountCents: 24000, proposalApprovedAt: ny('2026-08-03 10:00') })).find((x) => x.code === 'over_nte')?.excessCents).toBe(1000);
  });
  it('a pending proposal does not raise the cap', () => {
    const f = run(base({ ...over, proposalStatus: 'pending', proposalAmountCents: 30000 })).find((x) => x.code === 'over_nte');
    expect(f?.detail).toContain('pending');
  });
  it('checks the working estimate before an invoice exists', () => {
    expect(codes(fresh({ acceptedAt: ny('2026-08-03 09:05'), estimateCents: 25000 }), {}, new Date(ny('2026-08-03 10:00')))).toContain('over_nte');
  });
});

describe('R3 check-in', () => {
  it('passes at 0.25 mi and fails at 0.26', () => {
    expect(codes(base({ checkInDistanceMiles: 0.25 }))).not.toContain('checkin_out_of_range');
    expect(codes(base({ checkInDistanceMiles: 0.26 }))).toContain('checkin_out_of_range');
  });
  const prop = { proposalStatus: 'approved' as const, proposalAmountCents: 20000 };
  it('fails when check-in precedes proposal approval, passes after', () => {
    expect(codes(base({ ...prop, proposalApprovedAt: ny('2026-08-03 12:00') }))).toContain('checkin_before_proposal');
    expect(codes(base({ ...prop, proposalApprovedAt: ny('2026-08-03 10:30') }))).not.toContain('checkin_before_proposal');
  });
  it('fails when the proposal is still pending or rejected', () => {
    expect(codes(base({ proposalStatus: 'pending' }))).toContain('checkin_before_proposal');
    expect(codes(base({ proposalStatus: 'rejected' }))).toContain('checkin_before_proposal');
  });
  it('can be switched off per profile', () => {
    expect(codes(base({ proposalStatus: 'pending' }), { checkInAfterProposalApproval: false })).not.toContain('checkin_before_proposal');
  });
});

describe('R4 invoice within 10 days of completion (local calendar days)', () => {
  it('passes on day 10, fails on day 11', () => {
    expect(codes(base({ invoiceSubmittedAt: ny('2026-08-13 16:00') }))).not.toContain('invoice_late');
    const late = run(base({ invoiceSubmittedAt: ny('2026-08-14 09:00') })).find((f) => f.code === 'invoice_late');
    expect(late?.deadline).toBe('2026-08-13');
  });
  it('counts days in the profile timezone, not UTC', () => {
    // completed 11:30 PM NY on 8/3 (= 8/4 UTC)
    const o = base({ completedAt: ny('2026-08-03 23:30') });
    expect(codes({ ...o, invoiceSubmittedAt: ny('2026-08-13 08:00') })).not.toContain('invoice_late');
    expect(codes({ ...o, invoiceSubmittedAt: ny('2026-08-14 00:30') })).toContain('invoice_late');
  });
  const done = fresh({ acceptedAt: ny('2026-08-03 09:10'), checkedInAt: ny('2026-08-03 11:00'), checkInDistanceMiles: 0.1, completedAt: ny('2026-08-03 15:00') });
  it('warns before the deadline and flags it once passed (only while open)', () => {
    expect(codes(done, {}, new Date(ny('2026-08-09 12:00')))).toEqual([]); // 6 days elapsed, 4 left
    expect(codes(done, {}, new Date(ny('2026-08-10 12:00')))).toEqual(['invoice_due_soon']); // 3 left
    expect(run(done, {}, new Date(ny('2026-08-13 12:00')))[0].detail).toContain('due today');
    expect(codes(done, {}, new Date(ny('2026-08-14 12:00')))).toContain('invoice_overdue');
  });
});

describe('R5 one invoice per work order', () => {
  it('flags two invoices, accepts one', () => {
    expect(codes(base({ invoiceCount: 2 }))).toContain('duplicate_invoice');
    expect(codes(base({ invoiceCount: 1 }))).not.toContain('duplicate_invoice');
  });
});

describe('R6 90-day eligibility', () => {
  const old = { receivedAt: ny('2026-05-01 09:00'), acceptedAt: ny('2026-05-01 09:10'), checkedInAt: ny('2026-07-28 09:00'), completedAt: ny('2026-07-28 15:00') };
  it('passes when invoiced on day 90, fails on day 91', () => {
    expect(codes(base({ ...old, invoiceSubmittedAt: ny('2026-07-30 10:00') }))).not.toContain('invoice_after_90d');
    const f = run(base({ ...old, invoiceSubmittedAt: ny('2026-07-31 10:00') })).find((x) => x.code === 'invoice_after_90d');
    expect(f?.deadline).toBe('2026-07-30');
  });
  it('flags a never-invoiced order past 90 days and warns just before', () => {
    const open = fresh({ receivedAt: ny('2026-05-01 09:00'), acceptedAt: ny('2026-05-01 09:10') });
    expect(codes(open, {}, new Date(ny('2026-08-20 12:00')))).toContain('wo_ineligible');
    expect(codes(open, {}, new Date(ny('2026-07-28 12:00')))).toEqual(['wo_expiring_90d']);
    expect(codes(open, {}, new Date(ny('2026-07-20 12:00')))).toEqual([]);
  });
});

describe('R7 invoice would be rejected', () => {
  it('sales tax and management fee', () => {
    expect(codes(base({ invoiceTaxCents: 100, invoiceTotalCents: 15100 }))).toEqual(['sales_tax']);
    expect(codes(base({ invoiceMgmtFeeCents: 500, invoiceTotalCents: 15500 }))).toEqual(['management_fee']);
  });
  it('missing breakout categories, and technicians only matter when there is labor', () => {
    const f = run(base({ invoiceTripCents: null, invoiceTotalCents: 14000 })).find((x) => x.code === 'breakdown_missing');
    expect(f?.detail).toContain('trip');
    expect(codes(base({ invoiceTechnicians: null }))).toContain('breakdown_missing');
    expect(codes(base({ invoiceLaborCents: 0, invoiceTechnicians: null, invoiceTotalCents: 5000 }))).toEqual([]);
  });
  it('total must equal the sum of its parts (within tolerance)', () => {
    expect(codes(base({ invoiceTotalCents: 15100 }))).toEqual(['breakdown_mismatch']);
    expect(codes(base({ invoiceTotalCents: 15100 }), { breakdownToleranceCents: 100 })).toEqual([]);
  });
});

describe('profile overrides', () => {
  it('every rule can be changed', () => {
    expect(codes(base({ acceptedAt: ny('2026-08-03 09:45') }), { acceptWindowMinutes: 60 })).toEqual([]);
    expect(codes(base({ priority: 'p1', acceptedAt: ny('2026-08-03 09:20') }), { emergencyPriorities: ['p1'] })).toContain('accept_late');
    expect(codes(base({ checkInDistanceMiles: 0.5 }), { checkInRadiusMiles: 1 })).toEqual([]);
    expect(codes(base({ invoiceSubmittedAt: ny('2026-08-14 09:00') }), { invoiceWithinDays: 14 })).toEqual([]);
    expect(codes(base({ invoiceTaxCents: 100, invoiceTotalCents: 15100 }), { allowSalesTax: true })).toEqual([]);
    expect(codes(base({ invoiceMgmtFeeCents: 500, invoiceTotalCents: 15500 }), { allowManagementFee: true })).toEqual([]);
    expect(codes(base({ invoiceLaborCents: 20000, invoiceTotalCents: 25000 }), { invoiceMayNotExceedNte: false })).toEqual([]);
    expect(codes(base({ invoiceTripCents: null, invoiceTotalCents: 14000 }), { requiredBreakdown: ['labor', 'technicians', 'materials', 'freight'] })).toEqual([]);
    expect(codes(base({ invoiceCount: 3 }), { oneInvoicePerWorkOrder: false })).toEqual([]);
    expect(codes(base({ receivedAt: ny('2026-05-01 09:00'), acceptedAt: ny('2026-05-01 09:10'), checkedInAt: ny('2026-07-28 09:00'), completedAt: ny('2026-07-28 15:00'), invoiceSubmittedAt: ny('2026-07-31 10:00') }), { ineligibleAfterDays: 120 })).toEqual([]);
  });
  it('mergeRules fills missing keys from defaults and ignores junk', () => {
    const r = mergeRules({ acceptWindowMinutes: 45, allowSalesTax: 'yes', bogus: 1, emergencyPriorities: [' P1 ', 7] });
    expect(r.acceptWindowMinutes).toBe(45);
    expect(r.allowSalesTax).toBe(false);
    expect(r.invoiceWithinDays).toBe(10);
    expect(r.emergencyPriorities).toEqual(['p1']);
    expect(mergeRules(null)).toEqual(SERVICECHANNEL_DEFAULTS);
  });
  it('validateRules rejects impossible values', () => {
    expect(validateRules(SERVICECHANNEL_DEFAULTS)).toEqual([]);
    expect(validateRules({ ...SERVICECHANNEL_DEFAULTS, acceptWindowMinutes: 0 })).toHaveLength(1);
    expect(validateRules({ ...SERVICECHANNEL_DEFAULTS, checkInRadiusMiles: -1, invoiceWithinDays: 1.5 })).toHaveLength(2);
  });
});

describe('Quarter Audit on the 40-order sample', () => {
  const text = readFileSync(fileURLToPath(new URL('../../public/samples/work-orders-sample.csv', import.meta.url)), 'utf8');
  const parsed = parseWorkOrderCsv(text, { timezone: TZ });
  const asOf = new Date('2026-10-15T12:00:00Z');
  const audit = (rules: Partial<PortalRules> = {}, range: { from?: string; to?: string } = { from: '2026-07-01', to: '2026-09-30' }) =>
    runAudit(parsed.orders, { rules: { ...SERVICECHANNEL_DEFAULTS, ...rules }, timezone: TZ, asOf, ...range });

  it('parses all 40 rows with no errors', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.orders).toHaveLength(40);
  });
  it('hand-verifiable totals', () => {
    const t = audit().totals;
    expect(t).toEqual({
      ordersReviewed: 38, lostCount: 15, lateCount: 3, lostCents: 420500, lateCents: 41000, atRiskCents: 461500,
      avoidableCount: 16, avoidableCents: 425500, unavoidableCount: 2, unavoidableCents: 36000, noAmountCount: 0,
    });
  });
  it('each audit item carries exactly the expected rule', () => {
    const got = Object.fromEntries(audit().items.map((i) => [i.order.woNumber, i.flags.map((f) => f.code)]));
    expect(got).toEqual({
      '1001': ['over_nte'], '1002': ['sales_tax'], '1003': ['management_fee'], '1004': ['breakdown_missing'], '1005': ['breakdown_mismatch'],
      '1006': ['invoice_late'], '1007': ['invoice_after_90d'], '1008': ['accept_missed'], '1009': ['accept_late'], '1010': ['accept_late'],
      '1011': ['checkin_out_of_range'], '1012': ['checkin_before_proposal'], '1013': ['duplicate_invoice'], '1014': [], '1015': [],
      '1016': ['invoice_late'], '1017': ['accept_late'], '1018': ['accept_late'],
    });
  });
  it('boundary orders (30 min accept, day-10 invoice, covered NTE) and a paid order with only a tax issue stay out', () => {
    const ids = audit().items.map((i) => i.order.woNumber);
    for (const id of ['1019', '1020', '1021', '1022', '1023', '1040']) expect(ids).not.toContain(id);
  });
  it('is stable regardless of when the audit is run (all sample outcomes are terminal)', () => {
    const later = runAudit(parsed.orders, { rules: SERVICECHANNEL_DEFAULTS, timezone: TZ, asOf: new Date('2026-12-31T00:00:00Z'), from: '2026-07-01', to: '2026-09-30' });
    expect(later.totals).toEqual(audit().totals);
  });
  it('date range uses local received dates', () => {
    expect(audit({}, { from: '2026-08-01', to: '2026-09-30' }).totals).toMatchObject({ ordersReviewed: 31, lostCount: 8, lateCount: 3, atRiskCents: 236000 });
    expect(audit({}, { from: '2026-07-01', to: '2026-09-29' }).totals.ordersReviewed).toBe(37); // 1040 received 9/30 11:30 PM NY
  });
  it('profile overrides change what is avoidable (hand arithmetic)', () => {
    // tax/fee/NTE/breakout rules relaxed -> 1001-1005 (62500+31000+44000+25000+16000 = 178500) become unavoidable
    const relaxed = audit({ allowSalesTax: true, allowManagementFee: true, invoiceMayNotExceedNte: false, requiredBreakdown: [], breakdownToleranceCents: 1000 }).totals;
    expect(relaxed).toMatchObject({ atRiskCents: 461500, avoidableCents: 247000, avoidableCount: 11, unavoidableCents: 214500, unavoidableCount: 7 });
    // no emergency priority -> 1010 (54000) only had the 15-min rule -> unavoidable; 1018 (8000) leaves the audit
    const noEmergency = audit({ emergencyPriorities: [] }).totals;
    expect(noEmergency).toMatchObject({ atRiskCents: 453500, avoidableCents: 363500, avoidableCount: 14, lateCount: 2 });
  });
  it('byRule ranks dollars per rule', () => {
    // accept_late: 1009 (12000) + 1010 (54000) + 1017 (12000) + 1018 (8000) = 86000 — the costliest rule.
    const rules = audit().byRule;
    expect(rules[0]).toEqual({ code: 'accept_late', count: 4, cents: 86000 });
    expect(rules.find((r) => r.code === 'over_nte')).toEqual({ code: 'over_nte', count: 1, cents: 62500 });
  });
  it('csv export neutralises formula injection', () => {
    const o = base({ woNumber: '=HYPERLINK("x")', outcome: 'voided', acceptedAt: ny('2026-08-03 10:00') });
    const csv = auditToCsv(runAudit([o], { rules: SERVICECHANNEL_DEFAULTS, timezone: TZ, asOf }));
    expect(csv.split('\r\n')[1].startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true);
  });
});

describe('previousQuarter', () => {
  it('returns the calendar quarter before today in the profile timezone', () => {
    expect(previousQuarter(new Date('2026-10-29T12:00:00Z'), TZ)).toEqual({ from: '2026-07-01', to: '2026-09-30', label: 'Q3 2026' });
    expect(previousQuarter(new Date('2027-01-05T12:00:00Z'), TZ)).toEqual({ from: '2026-10-01', to: '2026-12-31', label: 'Q4 2026' });
    expect(previousQuarter(new Date('2026-04-01T03:00:00Z'), TZ)).toEqual({ from: '2025-10-01', to: '2025-12-31', label: 'Q4 2025' }); // 11 PM Mar 31 in NY is still Q1
  });
});
