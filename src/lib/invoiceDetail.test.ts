import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import type { Invoice } from '@/lib/invoices';
import {
  buildTimeline,
  computeInvoiceLedger,
  getDisplayStatus,
  parseMoneyInput,
  refundableForPayment,
  reminderCooldownMs,
  type InvoicePayment,
  type InvoiceRefund,
  type InvoiceReminder,
} from './invoiceDetail';

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: 'i1', job_id: null, quote_id: null, invoice_number: 'INV-0001', customer_name: 'Ada', customer_email: 'a@x.com', customer_phone: null,
  line_items: [{ description: 'Repair', quantity: 2, unit_price_cents: 5000 }, { description: 'Part', quantity: 1, unit_price_cents: 2500 }],
  tax_percent: 10, notes: null, status: 'sent', due_date: null, invoice_token: 't', sent_at: '2026-01-02T00:00:00Z', viewed_at: null,
  paid_at: null, payment_method: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
});
// subtotal 12500, tax 1250, total 13750

const pay = (id: string, amount: number, over: Partial<InvoicePayment> = {}): InvoicePayment => ({
  id, invoice_id: 'i1', amount_cents: amount, method: 'cash', reference: null, note: null, paid_at: '2026-01-05T00:00:00Z', created_by_email: null, created_at: '2026-01-05T00:00:00Z', ...over,
});
const ref = (id: string, paymentId: string, amount: number): InvoiceRefund => ({
  id, invoice_id: 'i1', payment_id: paymentId, amount_cents: amount, reason: 'Goodwill', refunded_at: '2026-01-06T00:00:00Z', created_by_email: null, created_at: '2026-01-06T00:00:00Z',
});

describe('computeInvoiceLedger', () => {
  it('computes totals and an unpaid balance', () => {
    const l = computeInvoiceLedger(inv(), [], []);
    expect(l).toMatchObject({ subtotalCents: 12500, taxCents: 1250, totalCents: 13750, balanceCents: 13750, state: 'unpaid' });
  });
  it('handles partial then full payment', () => {
    expect(computeInvoiceLedger(inv(), [pay('p1', 5000)], []).state).toBe('partial');
    const full = computeInvoiceLedger(inv(), [pay('p1', 5000), pay('p2', 8750)], []);
    expect(full).toMatchObject({ state: 'paid', balanceCents: 0 });
  });
  it('reopens the balance after a partial refund and flags full refunds', () => {
    const p = pay('p1', 13750);
    expect(computeInvoiceLedger(inv(), [p], [ref('r1', 'p1', 2000)])).toMatchObject({ state: 'partial', balanceCents: 2000, netPaidCents: 11750 });
    expect(computeInvoiceLedger(inv(), [p], [ref('r1', 'p1', 13750)])).toMatchObject({ state: 'refunded', balanceCents: 13750 });
  });
  it('treats void as void regardless of payments', () => {
    expect(computeInvoiceLedger(inv({ status: 'void' }), [], []).state).toBe('void');
  });
  it('never reports a negative balance or paid for a zero-total invoice', () => {
    const l = computeInvoiceLedger(inv({ line_items: [] }), [], []);
    expect(l.totalCents).toBe(0);
    expect(l.state).toBe('unpaid');
    expect(computeInvoiceLedger(inv(), [pay('p1', 99999)], []).balanceCents).toBe(0);
  });
});

describe('refundableForPayment', () => {
  it('subtracts prior refunds on the same payment only', () => {
    const p = pay('p1', 1000);
    expect(refundableForPayment(p, [ref('r1', 'p1', 300), ref('r2', 'other', 900)])).toBe(700);
    expect(refundableForPayment(p, [ref('r1', 'p1', 1000)])).toBe(0);
  });
});

describe('parseMoneyInput', () => {
  it('parses dollars to exact cents without float error', () => {
    expect(parseMoneyInput('19.99', 100000)).toEqual({ ok: true, cents: 1999 });
    expect(parseMoneyInput('0.1', 100000)).toEqual({ ok: true, cents: 10 });
    expect(parseMoneyInput('$1,250.5', 1000000)).toEqual({ ok: true, cents: 125050 });
    expect(parseMoneyInput('1.15', 1000)).toEqual({ ok: true, cents: 115 });
  });
  it('rejects empty, zero, negative, too many decimals, junk and over-max', () => {
    for (const bad of ['', '0', '0.00', '-5', '1.234', 'abc', '1e3']) {
      expect(parseMoneyInput(bad, 100000).ok, bad).toBe(false);
    }
    const over = parseMoneyInput('10.01', 1000);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain('$10.00');
  });
});

describe('getDisplayStatus', () => {
  it('prioritises void > refunded > paid > overdue > partial > stored status', () => {
    const past = '2000-01-01';
    const open = inv({ due_date: past });
    expect(getDisplayStatus(open, computeInvoiceLedger(open, [], []))).toBe('overdue');
    expect(getDisplayStatus(open, computeInvoiceLedger(open, [pay('p', 13750)], []))).toBe('paid');
    const notDue = inv({ due_date: '2999-01-01' });
    expect(getDisplayStatus(notDue, computeInvoiceLedger(notDue, [pay('p', 100)], []))).toBe('partial');
    expect(getDisplayStatus(inv({ status: 'viewed' }), computeInvoiceLedger(inv(), [], []))).toBe('viewed');
    const v = inv({ status: 'void' });
    expect(getDisplayStatus(v, computeInvoiceLedger(v, [], []))).toBe('void');
  });
});

describe('buildTimeline', () => {
  it('merges every source newest-first', () => {
    const reminders: InvoiceReminder[] = [
      { id: 'm1', invoice_id: 'i1', kind: 'reminder', channel: 'email', recipient: 'a@x.com', status: 'failed', error: 'bounce', sent_by_email: null, created_at: '2026-01-07T00:00:00Z' },
    ];
    const t = buildTimeline(inv({ viewed_at: '2026-01-03T00:00:00Z' }), [pay('p1', 500)], [ref('r1', 'p1', 100)], reminders);
    expect(t.map((e) => e.kind)).toEqual(['reminder', 'refund', 'payment', 'viewed', 'sent', 'created']);
    expect(t[0]).toMatchObject({ tone: 'danger', detail: 'bounce' });
  });
});

describe('reminderCooldownMs', () => {
  const now = new Date('2026-01-10T12:00:00Z').getTime();
  const r = (kind: InvoiceReminder['kind'], status: InvoiceReminder['status'], at: string) => ({ kind, status, created_at: at });
  it('is zero with no successful reminder, ignoring failures and non-reminders', () => {
    expect(reminderCooldownMs([], now)).toBe(0);
    expect(reminderCooldownMs([r('reminder', 'failed', '2026-01-10T11:00:00Z'), r('resend', 'sent', '2026-01-10T11:00:00Z')], now)).toBe(0);
  });
  it('counts down 12h from the last sent reminder', () => {
    expect(reminderCooldownMs([r('reminder', 'sent', '2026-01-10T06:00:00Z')], now)).toBe(6 * 3600_000);
    expect(reminderCooldownMs([r('reminder', 'sent', '2026-01-09T06:00:00Z')], now)).toBe(0);
  });
});
