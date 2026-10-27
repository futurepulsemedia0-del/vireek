import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM,
  actionsFor,
  centsToDollarsInput,
  changeOrderError,
  changeOrderLink,
  computeImpact,
  computeTotals,
  displayStatus,
  dollarsToCents,
  formTotals,
  formatScheduleImpact,
  lineFormAmount,
  parseLines,
  parsePublicChangeOrder,
  roundHalfAway,
  summarize,
  toPayload,
  validateForm,
  type ChangeOrder,
  type FormValues,
} from '@/lib/changeOrders';

const NOW = new Date('2027-03-10T12:00:00Z');

const co = (over: Partial<ChangeOrder> = {}): ChangeOrder => ({
  id: 'c1', user_id: 'u1', co_number: 'CO-0001', job_id: 'j1', project_id: null, customer_id: null,
  customer_name: 'Dana Whitfield', customer_email: null, customer_phone: null, site_address: null,
  title: 'Replace contactor', reason: 'unforeseen_condition', description: '', internal_notes: '',
  line_items: [{ description: 'Contactor', quantity: 1, unit_price_cents: 10000 }],
  tax_percent: 0, subtotal_cents: 10000, tax_cents: 0, total_cents: 10000, schedule_impact_days: 0,
  status: 'draft', approval_token: '00000000-0000-4000-8000-000000000001', content_hash: null,
  sent_at: null, expires_at: null, viewed_at: null, responded_at: null, approval_method: null,
  approver_name: null, response_note: null, cancelled_at: null, cancel_reason: null, invoice_id: null,
  invoiced_at: null, created_at: '2027-03-01T00:00:00Z', updated_at: '2027-03-01T00:00:00Z',
  ...over,
});

const form = (over: Partial<FormValues> = {}): FormValues => ({
  ...EMPTY_FORM,
  title: 'Add zone damper',
  customerName: 'Dana',
  lines: [{ description: 'Damper', quantity: '1', unitPrice: '120.50' }],
  ...over,
});

describe('money', () => {
  it('rounds half away from zero like PostgreSQL', () => {
    expect(roundHalfAway(2.5)).toBe(3);
    expect(roundHalfAway(-2.5)).toBe(-3);
    expect(roundHalfAway(0.4999)).toBe(0);
    expect(roundHalfAway(-0.2)).toBe(0);
    expect(Object.is(roundHalfAway(-0.2), 0)).toBe(true);
    expect(roundHalfAway(1.005 * 100)).toBe(101);
    expect(roundHalfAway(NaN)).toBe(0);
  });

  it('matches the SQL reference case exactly (25249 subtotal, 2083 tax, 27332 total)', () => {
    const t = computeTotals(
      [
        { quantity: 2.5, unit_price_cents: 8500 },
        { quantity: 1, unit_price_cents: 4999 },
        { quantity: 1, unit_price_cents: -1000 },
      ],
      8.25,
    );
    expect(t).toEqual({ subtotalCents: 25249, taxCents: 2083, totalCents: 27332 });
  });

  it('handles credits and empty lists', () => {
    expect(computeTotals([{ quantity: 1, unit_price_cents: -250000 }], 0).totalCents).toBe(-250000);
    expect(computeTotals([], 8).totalCents).toBe(0);
    expect(computeTotals([{ quantity: 1, unit_price_cents: 100 }], NaN).totalCents).toBe(100);
  });

  it('parses dollars to cents', () => {
    expect(dollarsToCents('12,500.50')).toBe(1250050);
    expect(dollarsToCents('$1,200')).toBe(120000);
    expect(dollarsToCents('-45')).toBe(-4500);
    expect(dollarsToCents('')).toBe(0);
    expect(dollarsToCents('1.234')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(centsToDollarsInput(12000)).toBe('120');
    expect(centsToDollarsInput(12050)).toBe('120.50');
  });
});

describe('status & actions', () => {
  it('derives expiry only for sent change orders', () => {
    expect(displayStatus(co({ status: 'sent', expires_at: '2027-03-09T00:00:00Z' }), NOW)).toBe('expired');
    expect(displayStatus(co({ status: 'sent', expires_at: '2027-03-11T00:00:00Z' }), NOW)).toBe('sent');
    expect(displayStatus(co({ status: 'approved', expires_at: '2027-03-09T00:00:00Z' }), NOW)).toBe('approved');
  });

  it('offers the right actions per state', () => {
    expect(actionsFor(co(), NOW)).toMatchObject({ canEdit: true, canSend: true, canInvoice: false, needsCancelReason: false });
    expect(actionsFor(co({ line_items: [] }), NOW).canSend).toBe(false);
    const live = actionsFor(co({ status: 'sent', expires_at: '2027-03-20T00:00:00Z' }), NOW);
    expect(live).toMatchObject({ canEdit: false, canSend: false, canResend: false, canRecordDecision: true, canCancel: true, needsCancelReason: true });
    expect(actionsFor(co({ status: 'sent', expires_at: '2027-03-01T00:00:00Z' }), NOW).canResend).toBe(true);
    expect(actionsFor(co({ status: 'approved' }), NOW).canInvoice).toBe(true);
    expect(actionsFor(co({ status: 'approved', invoice_id: 'i1' }), NOW).canInvoice).toBe(false);
    const credit = actionsFor(co({ status: 'approved', total_cents: -500 }), NOW);
    expect(credit.canInvoice).toBe(false);
    expect(credit.isCredit).toBe(true);
    for (const s of ['declined', 'cancelled'] as const) {
      expect(actionsFor(co({ status: s }), NOW)).toMatchObject({ canEdit: false, canSend: false, canCancel: false, canInvoice: false, canRecordDecision: false });
    }
  });
});

describe('impact', () => {
  const list = [
    co({ id: 'a', status: 'approved', total_cents: 50000, schedule_impact_days: 2, invoice_id: 'i1' }),
    co({ id: 'b', status: 'approved', total_cents: 30000, schedule_impact_days: 1 }),
    co({ id: 'c', status: 'approved', total_cents: -10000 }),
    co({ id: 'd', status: 'sent', total_cents: 20000, expires_at: '2027-03-20T00:00:00Z' }),
    co({ id: 'e', status: 'sent', total_cents: 99999, expires_at: '2027-03-01T00:00:00Z' }),
    co({ id: 'f', status: 'declined', total_cents: 77777 }),
    co({ id: 'g', status: 'draft', total_cents: 5555 }),
  ];

  it('rolls approved, pending and billable amounts up per parent', () => {
    expect(computeImpact(1_000_000, list, NOW)).toEqual({
      originalCents: 1_000_000, approvedCents: 70000, pendingCents: 20000, revisedCents: 1_070_000,
      approvedCount: 3, pendingCount: 1, scheduleDays: 3, invoicedCents: 50000, toInvoiceCents: 30000,
    });
  });

  it('shows no revised value when the original is unknown', () => {
    expect(computeImpact(null, list, NOW).revisedCents).toBeNull();
  });

  it('summarises the portfolio', () => {
    expect(summarize(list, NOW)).toEqual({
      awaiting: 1, awaitingCents: 20000, approvedToInvoiceCents: 30000, approvedCents: 70000, declinedCount: 1, drafts: 1, expired: 1,
    });
  });
});

describe('form', () => {
  it('accepts a valid form and builds the RPC payload', () => {
    expect(validateForm(form())).toEqual({});
    const p = toPayload(form({ taxPercent: '8.25', scheduleDays: '2', title: '  Add zone damper ' }));
    expect(p).toMatchObject({ title: 'Add zone damper', tax_percent: 8.25, schedule_impact_days: 2, line_items: [{ description: 'Damper', quantity: 1, unit_price_cents: 12050 }] });
  });

  it('flags missing required fields', () => {
    const e = validateForm(form({ title: ' ', customerName: '' }));
    expect(e.title).toBeTruthy();
    expect(e.customerName).toBeTruthy();
  });

  it('requires at least one priced line, ignoring untouched blank rows', () => {
    expect(validateForm(form({ lines: [{ description: '', quantity: '1', unitPrice: '' }] })).lines).toBeTruthy();
    expect(validateForm(form({ lines: [{ description: 'A', quantity: '1', unitPrice: '5' }, { description: '', quantity: '1', unitPrice: '' }] }))).toEqual({});
  });

  it('validates each line', () => {
    const bad = validateForm(form({ lines: [{ description: '', quantity: '1', unitPrice: '5' }, { description: 'B', quantity: '0', unitPrice: '5' }, { description: 'C', quantity: '1', unitPrice: 'x' }, { description: 'D', quantity: '1.234', unitPrice: '5' }] }));
    expect(Object.keys(bad.lineErrors ?? {})).toEqual(['0', '1', '2', '3']);
  });

  it('validates tax, schedule and email', () => {
    expect(validateForm(form({ taxPercent: '31' })).taxPercent).toBeTruthy();
    expect(validateForm(form({ taxPercent: '-1' })).taxPercent).toBeTruthy();
    expect(validateForm(form({ scheduleDays: '1.5' })).scheduleDays).toBeTruthy();
    expect(validateForm(form({ scheduleDays: '400' })).scheduleDays).toBeTruthy();
    expect(validateForm(form({ customerEmail: 'nope' })).customerEmail).toBeTruthy();
    expect(validateForm(form({ customerEmail: 'a@b.co' })).customerEmail).toBeUndefined();
  });

  it('computes live totals and line amounts', () => {
    expect(formTotals(form({ taxPercent: '10', lines: [{ description: 'A', quantity: '2', unitPrice: '10' }] }))).toEqual({ subtotalCents: 2000, taxCents: 200, totalCents: 2200 });
    expect(lineFormAmount({ description: 'A', quantity: '2.5', unitPrice: '85' })).toBe(21250);
    expect(lineFormAmount({ description: '', quantity: '1', unitPrice: '85' })).toBeNull();
    expect(parseLines([{ description: 'A', quantity: '1', unitPrice: '-10' }]).items[0].unit_price_cents).toBe(-1000);
  });
});

describe('errors, links & public parsing', () => {
  it('maps database codes to friendly copy', () => {
    expect(changeOrderError(new Error('change_order_locked'), 'x')).toMatch(/already sent/);
    expect(changeOrderError({ message: 'change_order_expired' }, 'x')).toMatch(/expired/);
    expect(changeOrderError({ message: 'permission denied for table change_orders' }, 'x')).toMatch(/permission/);
    expect(changeOrderError(new Error('boom'), 'fallback')).toBe('fallback');
    expect(changeOrderError(null, 'fallback')).toBe('fallback');
  });

  it('builds the customer link', () => {
    expect(changeOrderLink('abc', 'https://app.test')).toBe('https://app.test/change-order/abc');
  });

  it('formats schedule impact', () => {
    expect(formatScheduleImpact(0)).toBe('No schedule change');
    expect(formatScheduleImpact(1)).toBe('+1 day');
    expect(formatScheduleImpact(-3)).toBe('−3 days');
  });

  it('parses the public payload defensively', () => {
    expect(parsePublicChangeOrder(null)).toBeNull();
    expect(parsePublicChangeOrder({ status: 'draft' })).toBeNull();
    expect(parsePublicChangeOrder({ status: 'weird' })).toBeNull();
    const p = parsePublicChangeOrder({
      number: 'CO-0001', title: 'T', reason: 'nope', status: 'sent', total_cents: 5000,
      line_items: [{ description: 'A', quantity: 2, unit_price_cents: 2500 }, null], customer_name: 'D',
    });
    expect(p).toMatchObject({ number: 'CO-0001', reason: 'other', totalCents: 5000, status: 'sent', description: '' });
    expect(p?.lineItems).toHaveLength(2);
    expect(p?.lineItems[1]).toEqual({ description: '', quantity: 1, unit_price_cents: 0 });
  });
});
