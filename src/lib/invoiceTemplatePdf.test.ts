import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const fetchDefaultTemplate = vi.fn();
vi.mock('@/lib/documentTemplatesApi', () => ({ fetchDefaultTemplate: (...a: unknown[]) => fetchDefaultTemplate(...a) }));
const downloadTemplatePdf = vi.fn();
vi.mock('@/lib/documentTemplatePdf', () => ({
  downloadTemplatePdf: (...a: unknown[]) => downloadTemplatePdf(...a),
  loadLogoDataUrl: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/branding', () => ({ fetchBrandSettings: vi.fn().mockResolvedValue(null), logoPublicUrl: () => null }));

import { downloadInvoiceWithDefaultTemplate, invoiceToRenderData } from './invoiceTemplatePdf';
import { defaultDesign } from './documentTemplates';
import type { InvoicePdfInput } from './invoicePdf';

const input = (over: Record<string, unknown> = {}, ledger: Record<string, unknown> = {}): InvoicePdfInput =>
  ({
    invoice: {
      invoice_number: 'INV-9',
      customer_name: 'Pat',
      customer_email: 'p@x.com',
      customer_phone: null,
      line_items: [{ description: 'Work', quantity: 2, unit_price_cents: 5000 }],
      tax_percent: 10,
      notes: 'n',
      status: 'sent',
      due_date: '2026-02-01',
      sent_at: null,
      created_at: '2026-01-01T00:00:00Z',
      ...over,
    },
    ledger: { subtotalCents: 10000, taxCents: 1000, totalCents: 11000, paidCents: 0, refundedCents: 0, netPaidCents: 0, balanceCents: 11000, state: 'unpaid', ...ledger },
    payments: [],
    refunds: [],
    businessName: 'Acme',
  }) as unknown as InvoicePdfInput;

beforeEach(() => vi.clearAllMocks());

describe('invoiceToRenderData', () => {
  it('mirrors the ledger: tax override, balance due, no stamp when unpaid', () => {
    const d = invoiceToRenderData(input(), null);
    expect(d.taxCentsOverride).toBe(1000);
    expect(d.stamp).toBeNull();
    expect(d.extraTotals?.map((r) => r.label)).toEqual(['Balance due']);
    expect(d.customer.lines).toEqual(['p@x.com']);
    expect(d.issueDate).toBe('2026-01-01T00:00:00Z');
  });
  it('stamps paid / partial / void and lists payments and refunds', () => {
    expect(invoiceToRenderData(input({}, { state: 'paid', paidCents: 11000, balanceCents: 0 }), null).stamp?.text).toBe('PAID');
    expect(invoiceToRenderData(input({}, { state: 'partial', paidCents: 5000, balanceCents: 6000 }), null).stamp?.text).toBe('PARTIALLY PAID');
    const v = invoiceToRenderData(input({ status: 'void' }, { paidCents: 100, refundedCents: 100 }), null);
    expect(v.stamp?.text).toBe('VOID');
    expect(v.extraTotals?.map((r) => r.label)).toEqual(['Payments received', 'Refunded', 'Balance due']);
  });
});

describe('downloadInvoiceWithDefaultTemplate', () => {
  it('returns false (caller falls back) when there is no default template', async () => {
    fetchDefaultTemplate.mockResolvedValue(null);
    expect(await downloadInvoiceWithDefaultTemplate('o', input())).toBe(false);
    expect(downloadTemplatePdf).not.toHaveBeenCalled();
  });
  it('returns true after drawing with the default template', async () => {
    fetchDefaultTemplate.mockResolvedValue({ design: defaultDesign('invoice') });
    downloadTemplatePdf.mockResolvedValue(undefined);
    expect(await downloadInvoiceWithDefaultTemplate('o', input())).toBe(true);
    expect(downloadTemplatePdf.mock.calls[0][2]).toBe('INV-9.pdf');
  });
  it('never throws: any failure becomes a fallback', async () => {
    fetchDefaultTemplate.mockRejectedValue(new Error('offline'));
    expect(await downloadInvoiceWithDefaultTemplate('o', input())).toBe(false);
    fetchDefaultTemplate.mockResolvedValue({ design: defaultDesign('invoice') });
    downloadTemplatePdf.mockRejectedValue(new Error('pdf'));
    expect(await downloadInvoiceWithDefaultTemplate('o', input())).toBe(false);
  });
});
