/**
 * Invoice rendered on the Vireek document design system.
 * Pure of app/runtime imports (types only) so it is unit-testable with a fake
 * PDF document; callers inject formatting and the brand.
 */

import type { Invoice } from '@/lib/invoices';
import type { InvoiceLedger, InvoicePayment, InvoiceRefund } from '@/lib/invoiceDetail';
import { DocumentWriter, type DocBrandLike, type PdfDocLike, type TableColumn } from './pdfKit';
import { formatDocDate, type DocLabels } from './locale';
import { DANGER, SUCCESS, readableOn } from './tokens';

export interface InvoiceDocInput {
  invoice: Invoice;
  ledger: InvoiceLedger;
  payments: InvoicePayment[];
  refunds: InvoiceRefund[];
  businessName: string | null;
}

export interface InvoiceDocEnv {
  brand: DocBrandLike;
  labels: DocLabels;
  /** BCP-47 tag from `pdfLocaleTag()` (Latin digits unless the script's font is embedded). */
  localeTag: string;
  /** Base language, e.g. "en". */
  lang: string;
  rtl: boolean;
  money: (cents: number) => string;
  paymentMethodLabel: (method: string) => string;
  legalLine?: string | null;
}

export function renderInvoiceDocument(doc: PdfDocLike, input: InvoiceDocInput, env: InvoiceDocEnv): PdfDocLike {
  const { invoice, ledger, payments, refunds, businessName } = input;
  const { labels: L, brand, money } = env;
  const accentText = readableOn(brand.primary);

  const w = new DocumentWriter(doc, {
    brand,
    lang: env.lang,
    rtl: env.rtl,
    title: `${L.invoice} ${invoice.invoice_number}`,
    subject: businessName ?? L.invoice,
    docNumber: invoice.invoice_number,
    pageLabel: { page: L.page, of: L.of },
    legalLine: env.legalLine,
  }).begin();

  const stamp =
    invoice.status === 'void' ? { text: L.void, color: DANGER }
    : ledger.state === 'paid' ? { text: L.paid, color: SUCCESS }
    : ledger.state === 'partial' ? { text: L.partiallyPaid, color: accentText }
    : null;

  w.titleBlock({ business: businessName || L.invoice, kind: L.invoice, number: invoice.invoice_number, stamp });

  const contact = [invoice.customer_email, invoice.customer_phone].filter((c): c is string => Boolean(c));
  w.metaRow([
    { at: 0, label: L.billTo, lines: [invoice.customer_name, ...contact] },
    { at: 0.6, label: L.issued, lines: [formatDocDate(invoice.sent_at ?? invoice.created_at, env.localeTag)] },
    { at: 0.8, label: L.due, lines: [formatDocDate(invoice.due_date, env.localeTag)] },
  ]);

  const cols: TableColumn[] = [
    { header: L.description, weight: 0.5 },
    { header: L.qty, weight: 0.12, align: 'right' },
    { header: L.unit, weight: 0.18, align: 'right' },
    { header: L.amount, weight: 0.2, align: 'right' },
  ];
  w.table(
    cols,
    invoice.line_items.map((li) => [
      li.description || '\u2014',
      String(li.quantity),
      money(li.unit_price_cents),
      money(li.quantity * li.unit_price_cents),
    ]),
  );

  w.y += 4;
  w.summary([
    { label: L.subtotal, value: money(ledger.subtotalCents) },
    ...(invoice.tax_percent > 0 ? [{ label: `${L.tax} (${invoice.tax_percent}%)`, value: money(ledger.taxCents) }] : []),
    { label: L.total, value: money(ledger.totalCents), bold: true },
    ...(ledger.paidCents > 0 ? [{ label: L.paymentsReceived, value: `-${money(ledger.paidCents)}`, color: SUCCESS }] : []),
    ...(ledger.refundedCents > 0 ? [{ label: L.refunded, value: money(ledger.refundedCents), color: DANGER }] : []),
    { label: L.balanceDue, value: money(invoice.status === 'void' ? 0 : ledger.balanceCents), bold: true, color: accentText },
  ]);

  if (payments.length > 0) {
    w.y += 14;
    w.section(L.paymentHistory);
    for (const p of payments) {
      const refunded = refunds.filter((r) => r.payment_id === p.id).reduce((s, r) => s + r.amount_cents, 0);
      const label = [formatDocDate(p.paid_at, env.localeTag), env.paymentMethodLabel(p.method), p.reference].filter(Boolean).join(' \u00B7 ');
      w.ledgerRow(label, money(p.amount_cents));
      if (refunded > 0) w.ledgerRow(L.refunded, `-${money(refunded)}`, { color: DANGER, size: 9, indent: 12 });
    }
  }

  if (invoice.notes?.trim()) {
    w.y += 14;
    w.section(L.notes);
    w.paragraph(invoice.notes.trim());
  }

  return w.finish();
}
