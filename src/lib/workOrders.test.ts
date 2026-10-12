import { describe, it, expect } from 'vitest';
import {
  allowedBillingMoves,
  allowedVisitMoves,
  canStartWork,
  centsToDollarsInput,
  describeSaveError,
  dollarsToCents,
  EMPTY_VISIT_FORM,
  EMPTY_WORK_ORDER_FORM,
  filterWorkOrders,
  formatMoney,
  groupVisitsByOrder,
  isoToLocalInput,
  summarizeWorkOrder,
  toVisitPayload,
  toWorkOrderPayload,
  validateVisitForm,
  validateWorkOrderForm,
  type WorkOrder,
  type WorkOrderVisit,
} from './workOrders';

const NOW = Date.parse('2026-10-10T12:00:00Z');

function visit(over: Partial<WorkOrderVisit> = {}): WorkOrderVisit {
  return {
    id: 'v1',
    user_id: 'u1',
    work_order_id: 'w1',
    visit_number: 1,
    scheduled_start: '2026-10-12T14:00:00Z',
    scheduled_end: '2026-10-12T16:00:00Z',
    assigned_technician_id: null,
    status: 'scheduled',
    completed_at: null,
    notes: null,
    billing_status: 'unbilled',
    billable_amount_cents: null,
    invoice_reference: null,
    billed_at: null,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

function order(over: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'w1',
    user_id: 'u1',
    customer_id: 'c1',
    work_order_number: 'WO-00001',
    po_number: 'PO-7781',
    title: 'Rooftop unit repair',
    description: null,
    status: 'scheduled',
    approval_status: 'approved',
    approver_name: null,
    approved_at: null,
    approval_notes: null,
    site_name: 'Harbor Plaza',
    site_address: '1 Dock St',
    site_contact_name: 'Dana',
    site_contact_phone: null,
    site_contact_email: null,
    not_to_exceed_cents: 100_000,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

describe('money', () => {
  it('parses dollars to cents', () => {
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('$1,234.50')).toBe(123_450);
    expect(dollarsToCents('99')).toBe(9_900);
    expect(dollarsToCents('0.1')).toBe(10);
  });
  it('rejects junk, negatives and overflow', () => {
    expect(dollarsToCents('abc')).toBeNaN();
    expect(dollarsToCents('-5')).toBeNaN();
    expect(dollarsToCents('1.234')).toBeNaN();
    expect(dollarsToCents('99999999999')).toBeNaN();
  });
  it('formats', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(450_000)).toBe('$4,500');
    expect(formatMoney(12_345)).toBe('$123.45');
    expect(centsToDollarsInput(12_345)).toBe('123.45');
    expect(centsToDollarsInput(null)).toBe('');
  });
});

describe('approval gate', () => {
  it('only lets approved or not-required orders start', () => {
    expect(canStartWork('approved')).toBe(true);
    expect(canStartWork('not_required')).toBe(true);
    expect(canStartWork('pending')).toBe(false);
    expect(canStartWork('rejected')).toBe(false);
  });
  it('hides Start until approved', () => {
    const labels = (a: Parameters<typeof allowedVisitMoves>[1]) =>
      allowedVisitMoves(visit(), a).map((m) => m.label);
    expect(labels('pending')).not.toContain('Start');
    expect(labels('approved')).toContain('Start');
  });
  it('freezes billed visits', () => {
    expect(allowedVisitMoves(visit({ status: 'completed', billing_status: 'invoiced' }), 'approved')).toEqual([]);
  });
});

describe('billing moves', () => {
  it('requires a completed visit with an amount to bill', () => {
    expect(allowedBillingMoves(visit({ status: 'scheduled', billable_amount_cents: 500 }))).toEqual([]);
    expect(allowedBillingMoves(visit({ status: 'completed', billable_amount_cents: null }))).toEqual([]);
    expect(
      allowedBillingMoves(visit({ status: 'completed', billable_amount_cents: 500 })).map((m) => m.to),
    ).toEqual(['ready_to_bill']);
  });
  it('walks ready -> invoiced -> paid and allows void on invoiced', () => {
    expect(allowedBillingMoves(visit({ billing_status: 'ready_to_bill' })).map((m) => m.to)).toEqual(['invoiced', 'unbilled']);
    expect(allowedBillingMoves(visit({ billing_status: 'invoiced' })).map((m) => m.to)).toEqual(['paid', 'void']);
    expect(allowedBillingMoves(visit({ billing_status: 'paid' }))).toEqual([]);
  });
});

describe('summarizeWorkOrder', () => {
  it('rolls up per-visit billing against the NTE cap', () => {
    const visits = [
      visit({ id: 'a', visit_number: 1, status: 'completed', billing_status: 'paid', billable_amount_cents: 30_000 }),
      visit({ id: 'b', visit_number: 2, status: 'completed', billing_status: 'invoiced', billable_amount_cents: 20_000 }),
      visit({ id: 'c', visit_number: 3, status: 'completed', billing_status: 'ready_to_bill', billable_amount_cents: 10_000 }),
      visit({ id: 'd', visit_number: 4, billable_amount_cents: 5_000 }),
      visit({ id: 'e', visit_number: 5, status: 'cancelled', billable_amount_cents: 99_000 }),
      visit({ id: 'f', visit_number: 6, status: 'completed', billing_status: 'void', billable_amount_cents: 99_000 }),
    ];
    const s = summarizeWorkOrder({ not_to_exceed_cents: 100_000 }, visits, NOW);
    expect(s.committedCents).toBe(65_000);
    expect(s.paidCents).toBe(30_000);
    expect(s.invoicedCents).toBe(20_000);
    expect(s.readyCents).toBe(10_000);
    expect(s.unbilledCents).toBe(5_000);
    expect(s.remainingCents).toBe(35_000);
    expect(s.overNte).toBe(false);
    expect(s.completedCount).toBe(4);
    expect(s.nextVisitAt).toBe('2026-10-12T14:00:00.000Z');
  });
  it('flags over-cap and handles no cap', () => {
    const v = [visit({ billable_amount_cents: 150_000 })];
    expect(summarizeWorkOrder({ not_to_exceed_cents: 100_000 }, v, NOW).overNte).toBe(true);
    const noCap = summarizeWorkOrder({ not_to_exceed_cents: null }, v, NOW);
    expect(noCap.remainingCents).toBeNull();
    expect(noCap.overNte).toBe(false);
  });
  it('ignores past scheduled visits for next-visit', () => {
    const v = [visit({ scheduled_start: '2026-10-01T10:00:00Z' })];
    expect(summarizeWorkOrder({ not_to_exceed_cents: null }, v, NOW).nextVisitAt).toBeNull();
  });
});

describe('work order form', () => {
  it('requires a title and validates fields', () => {
    const errors = validateWorkOrderForm({
      ...EMPTY_WORK_ORDER_FORM,
      not_to_exceed: 'abc',
      site_contact_email: 'nope',
      site_contact_phone: 'xx',
    });
    expect(errors.title).toBeTruthy();
    expect(errors.not_to_exceed).toBeTruthy();
    expect(errors.site_contact_email).toBeTruthy();
    expect(errors.site_contact_phone).toBeTruthy();
  });
  it('accepts a valid form and builds a trimmed payload', () => {
    const form = {
      ...EMPTY_WORK_ORDER_FORM,
      title: '  HVAC PM  ',
      po_number: ' PO-1 ',
      not_to_exceed: '$2,500.50',
      site_contact_phone: '+1 (555) 010-2000',
      site_contact_email: 'dana@example.com',
    };
    expect(validateWorkOrderForm(form)).toEqual({});
    const p = toWorkOrderPayload(form);
    expect(p.title).toBe('HVAC PM');
    expect(p.po_number).toBe('PO-1');
    expect(p.not_to_exceed_cents).toBe(250_050);
    expect(p.work_order_number).toBeNull();
    expect(p.customer_id).toBeNull();
  });
});

describe('visit form', () => {
  it('requires a start and an end after it', () => {
    expect(validateVisitForm(EMPTY_VISIT_FORM).scheduled_start).toBeTruthy();
    const bad = validateVisitForm({
      ...EMPTY_VISIT_FORM,
      scheduled_start: '2026-10-12T10:00',
      scheduled_end: '2026-10-12T09:00',
    });
    expect(bad.scheduled_end).toBeTruthy();
    expect(
      validateVisitForm({ ...EMPTY_VISIT_FORM, scheduled_start: '2026-10-12T10:00', scheduled_end: '2026-10-12T12:00' }),
    ).toEqual({});
  });
  it('builds ISO payloads and round-trips the local input', () => {
    const p = toVisitPayload({
      ...EMPTY_VISIT_FORM,
      scheduled_start: '2026-10-12T10:00',
      billable_amount: '450',
      notes: ' bring ladder ',
    });
    expect(p.scheduled_start).toMatch(/^2026-10-12T/);
    expect(p.scheduled_end).toBeNull();
    expect(p.billable_amount_cents).toBe(45_000);
    expect(p.notes).toBe('bring ladder');
    expect(isoToLocalInput(p.scheduled_start)).toBe('2026-10-12T10:00');
    expect(isoToLocalInput(null)).toBe('');
  });
});

describe('filtering + grouping', () => {
  const orders = [
    order({ id: 'w1' }),
    order({ id: 'w2', work_order_number: 'WO-00002', po_number: 'PO-9', title: 'Boiler', approval_status: 'pending' }),
    order({ id: 'w3', work_order_number: 'WO-00003', status: 'completed', title: 'Done job' }),
  ];
  const visits = groupVisitsByOrder([
    visit({ id: 'b', work_order_id: 'w1', visit_number: 2, billing_status: 'ready_to_bill' }),
    visit({ id: 'a', work_order_id: 'w1', visit_number: 1 }),
  ]);
  it('groups and sorts visits by number', () => {
    expect(visits.w1.map((v) => v.id)).toEqual(['a', 'b']);
  });
  it('filters by tab', () => {
    expect(filterWorkOrders(orders, visits, 'open', '').map((o) => o.id)).toEqual(['w1', 'w2']);
    expect(filterWorkOrders(orders, visits, 'needs_approval', '').map((o) => o.id)).toEqual(['w2']);
    expect(filterWorkOrders(orders, visits, 'ready_to_bill', '').map((o) => o.id)).toEqual(['w1']);
    expect(filterWorkOrders(orders, visits, 'all', '')).toHaveLength(3);
  });
  it('searches PO, number, title and customer name', () => {
    expect(filterWorkOrders(orders, visits, 'all', 'po-9').map((o) => o.id)).toEqual(['w2']);
    expect(filterWorkOrders(orders, visits, 'all', 'wo-00003').map((o) => o.id)).toEqual(['w3']);
    expect(filterWorkOrders(orders, visits, 'all', 'acme', { c1: 'Acme Property Mgmt' })).toHaveLength(3);
    expect(filterWorkOrders(orders, visits, 'all', 'zzz')).toHaveLength(0);
  });
});

describe('describeSaveError', () => {
  it('maps database errors', () => {
    expect(describeSaveError({ code: '23505' })).toMatch(/already in use/);
    expect(describeSaveError({ code: '42501' })).toMatch(/permission/);
    expect(describeSaveError({ code: '23514', message: 'Only completed visits can be billed' })).toBe(
      'Only completed visits can be billed',
    );
    expect(describeSaveError(null)).toMatch(/try again/);
  });
});
