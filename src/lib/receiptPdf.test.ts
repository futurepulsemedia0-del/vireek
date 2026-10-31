import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));

import { buildReceiptDocInput, receiptPdfFilename, receiptReference, type ReceiptPdfInput } from './receiptPdf';

const input = (over: Partial<ReceiptPdfInput> = {}): ReceiptPdfInput => ({
  invoice: { invoice_number: 'INV-7', customer_name: 'Jane', customer_email: null, customer_phone: '555', status: 'sent' },
  ledger: { totalCents: 33000, paidCents: 10000, balanceCents: 23000 },
  payment: { id: 'abcd1234-0000', amount_cents: 10000, method: 'bank_transfer', reference: 'R1', note: 'n', paid_at: '2026-10-31T00:00:00Z' },
  refunds: [{ payment_id: 'abcd1234-0000', amount_cents: 500 }, { payment_id: 'other', amount_cents: 999 }],
  businessName: 'Acme',
  ...over,
} as unknown as ReceiptPdfInput);

describe('buildReceiptDocInput', () => {
  it('maps the payment, only its own refunds, and the ledger', () => {
    const d = buildReceiptDocInput(input());
    expect(d).toMatchObject({ number: 'RCT-ABCD1234', invoiceNumber: 'INV-7', amountCents: 10000, refundedCents: 500, invoiceTotalCents: 33000, totalPaidCents: 10000, balanceCents: 23000, methodLabel: 'Bank transfer', contact: ['555'] });
  });
  it('void invoice → zero balance', () => {
    const d = buildReceiptDocInput(input({ invoice: { invoice_number: 'INV-7', customer_name: 'J', customer_email: null, customer_phone: null, status: 'void' } as never }));
    expect(d.balanceCents).toBe(0);
  });
  it('filename and reference are stable and safe', () => {
    expect(receiptReference('ab-cd')).toBe('RCT-ABCD');
    expect(receiptPdfFilename(input(), new Date('2026-10-30T00:00:00Z'))).toBe('acme-receipt-2026-10-30-inv-7.pdf');
  });
});
