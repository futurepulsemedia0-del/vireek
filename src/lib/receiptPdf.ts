import type { Invoice } from '@/lib/invoices';
import { PAYMENT_METHOD_LABELS, type InvoiceLedger, type InvoicePayment, type InvoiceRefund } from '@/lib/invoiceDetail';
import { exportFilename } from '@/lib/documents/exportFile';
import { buildDocEnv } from '@/lib/documents/docEnv';
import { renderReceiptDocument, type ReceiptDocInput } from '@/lib/documents/receiptDocument';

export interface ReceiptPdfInput {
  invoice: Invoice;
  ledger: InvoiceLedger;
  payment: InvoicePayment;
  refunds: InvoiceRefund[];
  businessName: string | null;
}

export const receiptReference = (paymentId: string): string => `RCT-${paymentId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

export function buildReceiptDocInput(i: ReceiptPdfInput): ReceiptDocInput {
  const { invoice, ledger, payment, refunds, businessName } = i;
  return {
    businessName,
    number: receiptReference(payment.id),
    invoiceNumber: invoice.invoice_number,
    customerName: invoice.customer_name,
    contact: [invoice.customer_email, invoice.customer_phone].filter((c): c is string => Boolean(c)),
    paidAt: payment.paid_at,
    methodLabel: (PAYMENT_METHOD_LABELS as Record<string, string>)[payment.method] ?? payment.method,
    reference: payment.reference,
    note: payment.note,
    amountCents: payment.amount_cents,
    refundedCents: refunds.filter((r) => r.payment_id === payment.id).reduce((s, r) => s + r.amount_cents, 0),
    invoiceTotalCents: ledger.totalCents,
    totalPaidCents: ledger.paidCents,
    balanceCents: invoice.status === 'void' ? 0 : ledger.balanceCents,
  };
}

export function receiptPdfFilename(i: Pick<ReceiptPdfInput, 'invoice' | 'payment' | 'businessName'>, date = new Date()): string {
  return exportFilename({ business: i.businessName, kind: 'receipt', ext: 'pdf', detail: i.invoice.invoice_number, date });
}

export async function downloadReceiptPdf(input: ReceiptPdfInput): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const env = await buildDocEnv();
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  renderReceiptDocument(doc as unknown as Parameters<typeof renderReceiptDocument>[0], buildReceiptDocInput(input), env);
  doc.save(receiptPdfFilename(input));
}
