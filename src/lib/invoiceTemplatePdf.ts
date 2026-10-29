import { fetchBrandSettings, logoPublicUrl } from '@/lib/branding';
import { fetchDefaultTemplate } from '@/lib/documentTemplatesApi';
import { downloadTemplatePdf, loadLogoDataUrl } from '@/lib/documentTemplatePdf';
import { invoicePdfFilename, type InvoicePdfInput } from '@/lib/invoicePdf';
import type { RenderData } from '@/lib/documentTemplates';
import { formatCents } from '@/lib/quotes';

/**
 * Bridges a real invoice to the template renderer. Used by the invoice detail page: when the account has a
 * default invoice template the PDF is drawn with it, otherwise (or on ANY failure) the caller falls back to
 * the built-in invoicePdf, so downloading an invoice can never break because of templates.
 *
 * Numbers mirror computeInvoiceLedger() exactly (tax comes from the ledger, no extra discount), so the PDF
 * always agrees with the invoice screen.
 */

export function invoiceToRenderData(input: InvoicePdfInput, logoDataUrl: string | null): RenderData {
  const { invoice, ledger, businessName } = input;
  const stamp: RenderData['stamp'] =
    invoice.status === 'void'
      ? { text: 'VOID', tone: 'danger' }
      : ledger.state === 'paid'
        ? { text: 'PAID', tone: 'success' }
        : ledger.state === 'partial'
          ? { text: 'PARTIALLY PAID', tone: 'primary' }
          : null;

  const extraTotals: NonNullable<RenderData['extraTotals']> = [];
  if (ledger.paidCents > 0) extraTotals.push({ label: 'Payments received', value: `-${formatCents(ledger.paidCents)}`, tone: 'success' });
  if (ledger.refundedCents > 0) extraTotals.push({ label: 'Refunded', value: formatCents(ledger.refundedCents), tone: 'danger' });
  extraTotals.push({ label: 'Balance due', value: formatCents(invoice.status === 'void' ? 0 : ledger.balanceCents), tone: 'primary', bold: true });

  return {
    docType: 'invoice',
    documentNumber: invoice.invoice_number,
    issueDate: invoice.sent_at ?? invoice.created_at,
    secondaryDateLabel: 'Due',
    secondaryDate: invoice.due_date,
    business: { name: businessName ?? '', lines: [], logoDataUrl },
    customer: {
      name: invoice.customer_name,
      lines: [invoice.customer_email, invoice.customer_phone].filter((v): v is string => Boolean(v && v.trim())),
    },
    lineItems: invoice.line_items.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unit_price_cents: li.unit_price_cents,
    })),
    taxPercent: invoice.tax_percent,
    taxCentsOverride: ledger.taxCents,
    discountCents: 0,
    currency: null,
    notes: invoice.notes,
    paymentInstructions: null,
    report: null,
    stamp,
    extraTotals,
  };
}

/**
 * Downloads the invoice with the account's default invoice template.
 * Returns true when a template PDF was produced, false when the caller should use the built-in PDF.
 */
export async function downloadInvoiceWithDefaultTemplate(accountOwnerId: string, input: InvoicePdfInput): Promise<boolean> {
  try {
    const template = await fetchDefaultTemplate(accountOwnerId, 'invoice');
    if (!template) return false;
    let logo: string | null = null;
    if (template.design.header.showLogo) {
      const brand = await fetchBrandSettings(accountOwnerId).catch(() => null);
      logo = await loadLogoDataUrl(logoPublicUrl(brand?.logo_path ?? null));
    }
    await downloadTemplatePdf(template.design, invoiceToRenderData(input, logo), invoicePdfFilename(input.invoice));
    return true;
  } catch {
    return false;
  }
}
