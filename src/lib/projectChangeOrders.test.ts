import { describe, expect, it } from 'vitest';
import {
  CHANGE_ORDER_TRANSITIONS,
  EMPTY_CHANGE_ORDER_FORM,
  approvalImpact,
  approvedChangeTotals,
  availableActions,
  buildSignatureSummary,
  canTransition,
  changeOrderBillingState,
  changeOrderTotals,
  formFromChangeOrder,
  hasFormErrors,
  isFinalStatus,
  isSendable,
  lineTotalCents,
  markupCentsFor,
  parseQuantity,
  pendingChangeCents,
  signedDollarsToCents,
  toChangeOrderPayload,
  validateChangeOrderForm,
  type ChangeOrder,
  type ChangeOrderFormValues,
  type ChangeOrderStatus,
} from '@/lib/projectChangeOrders';
import {
  billingSummary,
  buildRollup,
  friendlyError,
  marginForecast,
  revisedContractCents,
  type InstallProject,
  type InvoiceLite,
} from '@/lib/installProjects';

const TODAY = '2027-03-10';

const project = (over: Partial<InstallProject> = {}): InstallProject => ({
  id: 'p1',
  user_id: 'u1',
  project_number: 'PRJ-0001',
  name: 'Full system replacement',
  customer_id: null,
  quote_id: null,
  customer_name: 'Ada Lovelace',
  site_address: null,
  project_type: 'hvac',
  status: 'active',
  contract_value_cents: 1_000_000,
  estimated_labor_cost_cents: 200_000,
  retainage_percent: 0,
  start_date: '2027-03-01',
  target_end_date: '2027-03-31',
  completed_at: null,
  retainage_invoice_id: null,
  notes: null,
  created_at: '2027-02-01T00:00:00Z',
  updated_at: '2027-02-01T00:00:00Z',
  ...over,
});

const co = (over: Partial<ChangeOrder> = {}): ChangeOrder => ({
  id: 'c1',
  user_id: 'u1',
  project_id: 'p1',
  seq: 1,
  co_number: 'CO-001',
  title: 'Upgrade unit',
  reason: 'customer_request',
  description: null,
  line_items: [],
  markup_percent: 0,
  subtotal_cents: 0,
  markup_cents: 0,
  cost_delta_cents: 0,
  estimated_cost_cents: 0,
  schedule_delta_days: 0,
  status: 'draft',
  signature_request_id: null,
  sent_at: null,
  decided_at: null,
  decided_by_name: null,
  decision_note: null,
  invoice_id: null,
  invoiced_gross_cents: null,
  invoiced_at: null,
  created_at: '2027-03-02T00:00:00Z',
  updated_at: '2027-03-02T00:00:00Z',
  ...over,
});

const inv = (id: string, status: string, due: string | null = null): InvoiceLite => ({ id, invoice_number: id.toUpperCase(), status, due_date: due });

describe('line and markup rounding', () => {
  it('multiplies quantity by unit price', () => {
    expect(lineTotalCents({ quantity: 2, unit_price_cents: 15_000 })).toBe(30_000);
    expect(lineTotalCents({ quantity: 0.25, unit_price_cents: 10_000 })).toBe(2_500);
  });

  it('rounds half away from zero like Postgres round()', () => {
    expect(lineTotalCents({ quantity: 1.5, unit_price_cents: 333 })).toBe(500);
    expect(lineTotalCents({ quantity: 1.5, unit_price_cents: -333 })).toBe(-500);
    expect(lineTotalCents({ quantity: 0.15, unit_price_cents: 30 })).toBe(5);
    expect(lineTotalCents({ quantity: 1.15, unit_price_cents: 1000 })).toBe(1150);
  });

  it('never returns negative zero', () => {
    expect(Object.is(lineTotalCents({ quantity: 0.01, unit_price_cents: -1 }), 0)).toBe(true);
    expect(Object.is(markupCentsFor(-1, 1), 0)).toBe(true);
  });

  it('computes markup exactly, including ties and credits', () => {
    expect(markupCentsFor(10_000, 10)).toBe(1_000);
    expect(markupCentsFor(333, 7.5)).toBe(25);
    expect(markupCentsFor(-333, 7.5)).toBe(-25);
    expect(markupCentsFor(12_345, 0)).toBe(0);
    expect(markupCentsFor(100_000_000_000_000, 100)).toBe(100_000_000_000_000);
  });
});

describe('changeOrderTotals', () => {
  it('sums lines, markup and total', () => {
    const t = changeOrderTotals(
      [
        { quantity: 2, unit_price_cents: 15_000 },
        { quantity: 1, unit_price_cents: 45_050 },
      ],
      10,
    );
    expect(t.lineCents).toEqual([30_000, 45_050]);
    expect(t.subtotalCents).toBe(75_050);
    expect(t.markupCents).toBe(7_505);
    expect(t.totalCents).toBe(82_555);
  });

  it('supports credits and an empty list', () => {
    expect(changeOrderTotals([{ quantity: 1, unit_price_cents: 20_000 }, { quantity: 1, unit_price_cents: -45_000 }], 0).totalCents).toBe(-25_000);
    expect(changeOrderTotals([], 15)).toEqual({ lineCents: [], subtotalCents: 0, markupCents: 0, totalCents: 0 });
  });
});

describe('status transitions', () => {
  it('allows the documented flow', () => {
    expect(canTransition('draft', 'sent')).toBe(true);
    expect(canTransition('sent', 'approved')).toBe(true);
    expect(canTransition('sent', 'rejected')).toBe(true);
    expect(canTransition('sent', 'draft')).toBe(true);
    expect(canTransition('rejected', 'draft')).toBe(true);
    expect(canTransition('draft', 'voided')).toBe(true);
    expect(canTransition('sent', 'voided')).toBe(true);
  });

  it('blocks everything else', () => {
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('draft', 'rejected')).toBe(false);
    expect(canTransition('rejected', 'approved')).toBe(false);
    expect(canTransition('rejected', 'sent')).toBe(false);
    expect(canTransition('approved', 'draft')).toBe(false);
    expect(canTransition('approved', 'voided')).toBe(false);
    expect(canTransition('voided', 'draft')).toBe(false);
  });

  it('treats approved and voided as final', () => {
    const finals = (Object.keys(CHANGE_ORDER_TRANSITIONS) as ChangeOrderStatus[]).filter(isFinalStatus);
    expect(finals.sort()).toEqual(['approved', 'voided']);
  });

  it('only sends a change order that changes something', () => {
    expect(isSendable(co())).toBe(false);
    expect(isSendable(co({ cost_delta_cents: -100 }))).toBe(true);
    expect(isSendable(co({ schedule_delta_days: 3 }))).toBe(true);
    expect(isSendable(co({ status: 'sent', cost_delta_cents: 100 }))).toBe(false);
  });

  it('offers the right actions per status', () => {
    const priced = { cost_delta_cents: 5_000, schedule_delta_days: 0 };
    expect(availableActions({ status: 'draft', ...priced }, 'active', false)).toEqual(['edit', 'send', 'void', 'delete']);
    expect(availableActions({ status: 'draft', cost_delta_cents: 0, schedule_delta_days: 0 }, 'active', false)).toEqual(['edit', 'void', 'delete']);
    expect(availableActions({ status: 'draft', ...priced }, 'cancelled', false)).toEqual(['edit', 'void', 'delete']);
    expect(availableActions({ status: 'sent', ...priced }, 'active', false)).toEqual(['reopen', 'void']);
    expect(availableActions({ status: 'rejected', ...priced }, 'active', false)).toEqual(['reopen']);
    expect(availableActions({ status: 'approved', ...priced }, 'active', false)).toEqual(['invoice']);
    expect(availableActions({ status: 'approved', ...priced }, 'active', true)).toEqual([]);
    expect(availableActions({ status: 'approved', cost_delta_cents: 0, schedule_delta_days: 2 }, 'active', false)).toEqual([]);
    expect(availableActions({ status: 'voided', ...priced }, 'active', false)).toEqual([]);
  });
});

describe('project impact', () => {
  it('adds the cost and moves the target end date', () => {
    const i = approvalImpact(project(), co({ cost_delta_cents: 250_000, schedule_delta_days: 5 }));
    expect(i.contractBeforeCents).toBe(1_000_000);
    expect(i.contractAfterCents).toBe(1_250_000);
    expect(i.targetEndAfter).toBe('2027-04-05');
    expect(i.problem).toBeNull();
  });

  it('builds on earlier approved changes', () => {
    const i = approvalImpact(project({ approved_change_cents: 100_000 }), co({ cost_delta_cents: -50_000 }));
    expect(i.contractBeforeCents).toBe(1_100_000);
    expect(i.contractAfterCents).toBe(1_050_000);
    expect(i.targetEndAfter).toBe('2027-03-31');
  });

  it('flags a schedule that would end before the start', () => {
    const i = approvalImpact(project({ start_date: '2027-03-20', target_end_date: '2027-03-25' }), co({ schedule_delta_days: -10 }));
    expect(i.problem).toBe('schedule_before_start');
  });

  it('leaves a missing target date alone', () => {
    const i = approvalImpact(project({ target_end_date: null }), co({ schedule_delta_days: 7 }));
    expect(i.targetEndAfter).toBeNull();
    expect(i.problem).toBeNull();
  });

  it('totals only approved change orders', () => {
    const list = [
      co({ status: 'approved', cost_delta_cents: 300_000, estimated_cost_cents: 180_000, schedule_delta_days: 4 }),
      co({ id: 'c2', status: 'approved', cost_delta_cents: -50_000, estimated_cost_cents: 0, schedule_delta_days: 0 }),
      co({ id: 'c3', status: 'sent', cost_delta_cents: 999_999 }),
      co({ id: 'c4', status: 'voided', cost_delta_cents: 123 }),
    ];
    expect(approvedChangeTotals(list)).toEqual({ count: 2, priceCents: 250_000, internalCostCents: 180_000, scheduleDays: 4 });
    expect(pendingChangeCents(list)).toBe(999_999);
  });
});

describe('contract value and billing', () => {
  it('revised contract is original plus approved changes', () => {
    expect(revisedContractCents(project())).toBe(1_000_000);
    expect(revisedContractCents(project({ approved_change_cents: 250_000 }))).toBe(1_250_000);
    expect(revisedContractCents(project({ approved_change_cents: -100_000 }))).toBe(900_000);
  });

  it('adds invoiced change orders to billing and keeps draws on the original contract', () => {
    const p = project({ approved_change_cents: 200_000 });
    const s = billingSummary(
      p,
      [],
      { i1: inv('i1', 'sent', '2027-03-01'), i2: inv('i2', 'paid') },
      TODAY,
      [
        { status: 'approved', cost_delta_cents: 120_000, invoice_id: 'i1', invoiced_gross_cents: 120_000 },
        { status: 'approved', cost_delta_cents: 80_000, invoice_id: 'i2', invoiced_gross_cents: 80_000 },
      ],
    );
    expect(s.contractCents).toBe(1_200_000);
    expect(s.invoicedGrossCents).toBe(200_000);
    expect(s.paidCents).toBe(80_000);
    expect(s.outstandingCents).toBe(120_000);
    expect(s.overdueCents).toBe(120_000);
    expect(s.billedPercent).toBeCloseTo((200_000 / 1_200_000) * 100, 6);
  });

  it('ignores void invoices, unapproved and uninvoiced change orders', () => {
    const s = billingSummary(project(), [], { i1: inv('i1', 'void') }, TODAY, [
      { status: 'approved', cost_delta_cents: 50_000, invoice_id: 'i1', invoiced_gross_cents: 50_000 },
      { status: 'approved', cost_delta_cents: 50_000, invoice_id: null, invoiced_gross_cents: null },
      { status: 'sent', cost_delta_cents: 50_000, invoice_id: 'i1', invoiced_gross_cents: 50_000 },
    ]);
    expect(s.invoicedGrossCents).toBe(0);
    expect(s.outstandingCents).toBe(0);
  });

  it('is unchanged when there are no change orders', () => {
    const s = billingSummary(project(), [], {}, TODAY);
    expect(s.contractCents).toBe(1_000_000);
    expect(s.invoicedGrossCents).toBe(0);
  });

  it('feeds the portfolio rollup', () => {
    const r = buildRollup(project({ approved_change_cents: 100_000 }), [], [], [], { i1: inv('i1', 'sent', '2027-04-01') }, TODAY, [
      { status: 'approved', cost_delta_cents: 100_000, invoice_id: 'i1', invoiced_gross_cents: 100_000 },
    ]);
    expect(r.billing.contractCents).toBe(1_100_000);
    expect(r.billing.outstandingCents).toBe(100_000);
  });

  it('includes approved price and internal cost in the margin forecast', () => {
    const before = marginForecast(project(), 300_000);
    expect(before.marginCents).toBe(500_000);
    const after = marginForecast(project({ approved_change_cents: 300_000, approved_change_cost_cents: 150_000 }), 300_000);
    expect(after.costCents).toBe(650_000);
    expect(after.marginCents).toBe(650_000);
    expect(after.marginPercent).toBeCloseTo(50, 6);
  });

  it('classifies change order invoicing', () => {
    const base = { status: 'approved' as const, cost_delta_cents: 10_000 };
    expect(changeOrderBillingState({ ...base, invoice_id: null }, {}, TODAY)).toBe('not_invoiced');
    expect(changeOrderBillingState({ ...base, invoice_id: 'i1' }, { i1: inv('i1', 'void') }, TODAY)).toBe('not_invoiced');
    expect(changeOrderBillingState({ ...base, invoice_id: 'i1' }, { i1: inv('i1', 'sent', '2027-04-01') }, TODAY)).toBe('invoiced');
    expect(changeOrderBillingState({ ...base, invoice_id: 'i1' }, { i1: inv('i1', 'sent', '2027-03-01') }, TODAY)).toBe('overdue');
    expect(changeOrderBillingState({ ...base, invoice_id: 'i1' }, { i1: inv('i1', 'paid') }, TODAY)).toBe('paid');
    expect(changeOrderBillingState({ status: 'sent', cost_delta_cents: 10_000, invoice_id: null }, {}, TODAY)).toBe('not_applicable');
    expect(changeOrderBillingState({ status: 'approved', cost_delta_cents: 0, invoice_id: null }, {}, TODAY)).toBe('not_applicable');
  });
});

describe('form parsing and validation', () => {
  const valid = (over: Partial<ChangeOrderFormValues> = {}): ChangeOrderFormValues => ({
    ...EMPTY_CHANGE_ORDER_FORM,
    title: 'Upgrade to 5-ton unit',
    lines: [{ description: 'Larger condenser', quantity: '1', unitPrice: '1,250.50' }],
    ...over,
  });

  it('parses dollars with optional sign', () => {
    expect(signedDollarsToCents('1,250.50')).toBe(125_050);
    expect(signedDollarsToCents('$-120')).toBe(-12_000);
    expect(signedDollarsToCents('-120.5')).toBe(-12_050);
    expect(signedDollarsToCents('1.234')).toBeNull();
    expect(signedDollarsToCents('')).toBeNull();
    expect(Object.is(signedDollarsToCents('-0'), 0)).toBe(true);
  });

  it('parses quantities', () => {
    expect(parseQuantity('2.5')).toBe(2.5);
    expect(parseQuantity('0')).toBeNull();
    expect(parseQuantity('-1')).toBeNull();
    expect(parseQuantity('10001')).toBeNull();
    expect(parseQuantity('1.234')).toBeNull();
  });

  it('accepts a valid form and builds the payload', () => {
    const v = valid({ markupPercent: '10', scheduleDays: '3', estimatedCost: '800', description: '  Extra scope  ' });
    expect(hasFormErrors(validateChangeOrderForm(v))).toBe(false);
    expect(toChangeOrderPayload(v)).toEqual({
      title: 'Upgrade to 5-ton unit',
      reason: 'customer_request',
      description: 'Extra scope',
      line_items: [{ description: 'Larger condenser', quantity: 1, unit_price_cents: 125_050 }],
      markup_percent: 10,
      schedule_delta_days: 3,
      estimated_cost_cents: 80_000,
    });
  });

  it('ignores blank rows and allows a schedule-only change order', () => {
    const v = valid({ lines: [{ description: '', quantity: '1', unitPrice: '' }], scheduleDays: '-2' });
    expect(hasFormErrors(validateChangeOrderForm(v))).toBe(false);
    expect(toChangeOrderPayload(v).line_items).toEqual([]);
  });

  it('reports field and line errors', () => {
    const e = validateChangeOrderForm(
      valid({
        title: '   ',
        markupPercent: '150',
        scheduleDays: '1.5',
        estimatedCost: '-5',
        lines: [
          { description: 'ok', quantity: '1', unitPrice: '10' },
          { description: '', quantity: '1', unitPrice: '10' },
          { description: 'bad qty', quantity: '0', unitPrice: '10' },
          { description: 'bad price', quantity: '1', unitPrice: 'abc' },
        ],
      }),
    );
    expect(e.title).toBeDefined();
    expect(e.markupPercent).toBeDefined();
    expect(e.scheduleDays).toBeDefined();
    expect(e.estimatedCost).toBeDefined();
    expect(Object.keys(e.lines).map(Number)).toEqual([1, 2, 3]);
    expect(hasFormErrors(e)).toBe(true);
  });

  it('round-trips an existing change order into the form', () => {
    const existing = co({ line_items: [{ description: 'Credit', quantity: 2.5, unit_price_cents: -12_050 }], markup_percent: 7.5, schedule_delta_days: -2, estimated_cost_cents: 5_000 });
    const back = toChangeOrderPayload(formFromChangeOrder(existing));
    expect(back.line_items).toEqual(existing.line_items);
    expect(back.markup_percent).toBe(7.5);
    expect(back.schedule_delta_days).toBe(-2);
    expect(back.estimated_cost_cents).toBe(5_000);
  });
});

describe('customer summary', () => {
  it('states the total, schedule and contract change', () => {
    const items = [{ description: 'Larger condenser', quantity: 1, unit_price_cents: 125_050 }];
    const text = buildSignatureSummary(project(), co({ line_items: items, markup_percent: 10, cost_delta_cents: 137_555, schedule_delta_days: 3 }));
    expect(text).toContain('CO-001');
    expect(text).toContain('Larger condenser');
    expect(text).toContain('+$1,375.55');
    expect(text).toContain('+3 days');
  });

  it('marks credits', () => {
    const text = buildSignatureSummary(project(), co({ line_items: [{ description: 'Deleted item', quantity: 1, unit_price_cents: -10_000 }], cost_delta_cents: -10_000 }));
    expect(text).toContain('(credit)');
  });

  it('stays within the 2,000 character limit of the signing request', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ description: `Line item number ${i} with a fairly long description text`, quantity: 1, unit_price_cents: 1_000 }));
    const text = buildSignatureSummary(project(), co({ line_items: items, description: 'x'.repeat(4000), cost_delta_cents: 100_000 }));
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain('Total change');
  });
});

describe('error copy', () => {
  it('maps database errors to friendly messages', () => {
    expect(friendlyError(new Error('invalid_transition'), 'x')).not.toBe('x');
    expect(friendlyError(new Error('change_order_locked'), 'x')).not.toBe('x');
    expect(friendlyError(new Error('schedule_before_start'), 'x')).not.toBe('x');
    expect(friendlyError(new Error('signature_mismatch'), 'x')).not.toBe('x');
    expect(friendlyError(new Error('something unrelated'), 'fallback')).toBe('fallback');
  });
});
