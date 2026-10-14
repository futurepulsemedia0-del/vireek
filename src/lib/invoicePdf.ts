import type { jsPDF as JsPdfType } from 'jspdf';
import { formatCents, type Invoice } from '@/lib/invoices';
import {
  PAYMENT_METHOD_LABELS,
  type InvoiceLedger,
  type InvoicePayment,
  type InvoiceRefund,
} from '@/lib/invoiceDetail';

// Manual vector layout (same approach as src/lib/pdf.ts). jsPDF is loaded on
// demand so it never lands in the main dashboard bundle.

const ACCENT: [number, number, number] = [32, 58, 216];
const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const SUCCESS: [number, number, number] = [22, 130, 87];
const DANGER: [number, number, number] = [200, 55, 55];
const LINE: [number, number, number] = [225, 225, 232];

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 48;
const RIGHT = PAGE_W - M;
const BOTTOM = PAGE_H - 64;

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

export interface InvoicePdfInput {
  invoice: Invoice;
  ledger: InvoiceLedger;
  payments: InvoicePayment[];
  refunds: InvoiceRefund[];
  businessName: string | null;
}

export function invoicePdfFilename(invoice: Pick<Invoice, 'invoice_number'>): string {
  return `${invoice.invoice_number.replace(/[^A-Za-z0-9_-]+/g, '_')}.pdf`;
}

export async function buildInvoicePdf(input: InvoicePdfInput): Promise<JsPdfType> {
  const { jsPDF } = await import('jspdf');
  const { invoice, ledger, payments, refunds, businessName } = input;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = 0;

  const footer = () => {
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...MUTED);
      doc.text(`${invoice.invoice_number} · Page ${i} of ${pages}`, M, PAGE_H - 36);
      doc.text('Generated with Vireek', RIGHT, PAGE_H - 36, { align: 'right' });
    }
  };

  const ensure = (needed: number) => {
    if (y + needed > BOTTOM) {
      doc.addPage();
      doc.setFillColor(...ACCENT);
      doc.rect(0, 0, PAGE_W, 6, 'F');
      y = 48;
    }
  };

  // Header band
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 6, 'F');
  y = 52;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...INK);
  doc.text(businessName || 'Invoice', M, y);

  doc.setFontSize(26);
  doc.setTextColor(...ACCENT);
  doc.text('INVOICE', RIGHT, y, { align: 'right' });

  y += 20;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text(invoice.invoice_number, RIGHT, y, { align: 'right' });

  // Status stamp
  const stamp =
    invoice.status === 'void' ? { t: 'VOID', c: DANGER } :
    ledger.state === 'paid' ? { t: 'PAID', c: SUCCESS } :
    ledger.state === 'partial' ? { t: 'PARTIALLY PAID', c: ACCENT } : null;
  if (stamp) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...stamp.c);
    doc.text(stamp.t, RIGHT, y + 16, { align: 'right' });
  }

  // Bill to / dates
  y += 40;
  doc.setDrawColor(...LINE);
  doc.line(M, y, RIGHT, y);
  y += 22;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text('BILL TO', M, y);
  doc.text('ISSUED', 340, y);
  doc.text('DUE', 450, y);
  y += 15;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text(invoice.customer_name, M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(fmtDate(invoice.sent_at ?? invoice.created_at), 340, y);
  doc.text(fmtDate(invoice.due_date), 450, y);
  const contact = [invoice.customer_email, invoice.customer_phone].filter(Boolean) as string[];
  for (const c of contact) {
    y += 14;
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(c, M, y);
  }

  // Line items table
  y += 34;
  const COL_QTY = 360;
  const COL_UNIT = 450;
  const drawTableHead = () => {
    doc.setFillColor(245, 245, 248);
    doc.rect(M, y - 12, RIGHT - M, 22, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text('DESCRIPTION', M + 8, y + 2);
    doc.text('QTY', COL_QTY, y + 2, { align: 'right' });
    doc.text('UNIT', COL_UNIT, y + 2, { align: 'right' });
    doc.text('AMOUNT', RIGHT - 8, y + 2, { align: 'right' });
    y += 24;
  };
  drawTableHead();

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  for (const li of invoice.line_items) {
    const lines: string[] = doc.splitTextToSize(li.description || '—', COL_QTY - M - 50);
    const rowH = Math.max(18, lines.length * 13 + 6);
    if (y + rowH > BOTTOM) {
      ensure(rowH + 40);
      drawTableHead();
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text(lines, M + 8, y);
    doc.text(String(li.quantity), COL_QTY, y, { align: 'right' });
    doc.text(formatCents(li.unit_price_cents), COL_UNIT, y, { align: 'right' });
    doc.text(formatCents(li.quantity * li.unit_price_cents), RIGHT - 8, y, { align: 'right' });
    y += rowH;
    doc.setDrawColor(...LINE);
    doc.line(M, y - 10, RIGHT, y - 10);
  }

  // Totals
  const totalRow = (label: string, value: string, opts: { bold?: boolean; color?: [number, number, number] } = {}) => {
    ensure(22);
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    doc.setFontSize(opts.bold ? 12 : 10);
    doc.setTextColor(...(opts.color ?? INK));
    doc.text(label, 380, y);
    doc.text(value, RIGHT - 8, y, { align: 'right' });
    y += opts.bold ? 22 : 17;
  };
  y += 8;
  totalRow('Subtotal', formatCents(ledger.subtotalCents));
  if (invoice.tax_percent > 0) totalRow(`Tax (${invoice.tax_percent}%)`, formatCents(ledger.taxCents));
  totalRow('Total', formatCents(ledger.totalCents), { bold: true });
  if (ledger.paidCents > 0) totalRow('Payments received', `-${formatCents(ledger.paidCents)}`, { color: SUCCESS });
  if (ledger.refundedCents > 0) totalRow('Refunded', formatCents(ledger.refundedCents), { color: DANGER });
  totalRow('Balance due', formatCents(invoice.status === 'void' ? 0 : ledger.balanceCents), { bold: true, color: ACCENT });

  // Payment history
  if (payments.length > 0) {
    y += 14;
    ensure(60);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text('PAYMENT HISTORY', M, y);
    y += 16;
    doc.setFontSize(10);
    for (const p of payments) {
      ensure(18);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...INK);
      const refunded = refunds.filter((r) => r.payment_id === p.id).reduce((s, r) => s + r.amount_cents, 0);
      doc.text(`${fmtDate(p.paid_at)} · ${PAYMENT_METHOD_LABELS[p.method] ?? p.method}${p.reference ? ` · ${p.reference}` : ''}`, M, y);
      doc.text(formatCents(p.amount_cents), RIGHT - 8, y, { align: 'right' });
      y += 15;
      if (refunded > 0) {
        ensure(15);
        doc.setFontSize(9);
        doc.setTextColor(...DANGER);
        doc.text('Refunded', M + 12, y);
        doc.text(`-${formatCents(refunded)}`, RIGHT - 8, y, { align: 'right' });
        doc.setFontSize(10);
        y += 15;
      }
    }
  }

  // Notes
  if (invoice.notes?.trim()) {
    y += 14;
    ensure(50);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text('NOTES', M, y);
    y += 15;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    const noteLines: string[] = doc.splitTextToSize(invoice.notes.trim(), RIGHT - M);
    for (const line of noteLines) {
      ensure(14);
      doc.text(line, M, y);
      y += 13;
    }
  }

  footer();
  return doc;
}

export async function downloadInvoicePdf(input: InvoicePdfInput): Promise<void> {
  const doc = await buildInvoicePdf(input);
  doc.save(invoicePdfFilename(input.invoice));
}
