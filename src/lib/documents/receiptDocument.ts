/**
 * Payment receipt (one payment against an invoice) on the Vireek document design system.
 */

import { DocumentWriter, type DocBrandLike, type PdfDocLike } from './pdfKit';
import { formatDocDate, type DocLabels } from './locale';
import { DANGER, SUCCESS, readableOn } from './tokens';

export interface ReceiptDocInput {
  businessName: string | null;
  /** Derived, stable reference for this payment (e.g. RCT-1A2B3C4D). */
  number: string;
  invoiceNumber: string;
  customerName: string;
  contact: string[];
  paidAt: string;
  methodLabel: string;
  reference: string | null;
  note: string | null;
  amountCents: number;
  refundedCents: number;
  invoiceTotalCents: number;
  totalPaidCents: number;
  balanceCents: number;
}

export interface ReceiptDocEnv {
  brand: DocBrandLike;
  labels: DocLabels;
  localeTag: string;
  lang: string;
  rtl: boolean;
  money: (cents: number) => string;
  legalLine?: string | null;
}

export function renderReceiptDocument(doc: PdfDocLike, input: ReceiptDocInput, env: ReceiptDocEnv): PdfDocLike {
  const { labels: L, brand, money } = env;
  const accentText = readableOn(brand.primary);

  const w = new DocumentWriter(doc, {
    brand, lang: env.lang, rtl: env.rtl,
    title: `${L.receipt} ${input.number}`,
    subject: `${L.forInvoice} ${input.invoiceNumber}`,
    docNumber: input.number,
    pageLabel: { page: L.page, of: L.of },
    legalLine: env.legalLine,
  }).begin();

  w.titleBlock({ business: input.businessName || L.receipt, kind: L.receipt, number: input.number, stamp: { text: L.paid, color: SUCCESS } });

  w.metaRow([
    { at: 0, label: L.receivedFrom, lines: [input.customerName || '\u2014', ...input.contact] },
    { at: 0.6, label: L.datePaid, lines: [formatDocDate(input.paidAt, env.localeTag)] },
    { at: 0.8, label: L.paymentMethod, lines: [input.methodLabel] },
  ]);

  w.section(L.forInvoice);
  w.ledgerRow(input.invoiceNumber, '');
  if (input.reference) w.ledgerRow(`${L.reference}: ${input.reference}`, '');
  w.y += 14;

  w.summary([
    { label: L.amountPaid, value: money(input.amountCents), bold: true, color: accentText },
    ...(input.refundedCents > 0 ? [{ label: L.refunded, value: `-${money(input.refundedCents)}`, color: DANGER }] : []),
    { label: L.total, value: money(input.invoiceTotalCents) },
    { label: L.totalPaidToDate, value: money(input.totalPaidCents) },
    { label: L.balanceRemaining, value: money(input.balanceCents), bold: true },
  ]);

  if (input.note?.trim()) {
    w.y += 14;
    w.section(L.notes);
    w.paragraph(input.note.trim());
  }

  return w.finish();
}
