import { formatInvoiceAmount, invoiceTaxView, type SubscriptionInvoice } from '@/lib/subscriptionInvoices';

/**
 * Tax breakdown under an invoice amount: subtotal, each tax line exactly as
 * Stripe reports it, a reverse-charge notice, and the customer's tax IDs.
 * Renders nothing when the invoice carries no tax information.
 */
export function InvoiceTaxDetails({ invoice }: { invoice: SubscriptionInvoice }) {
  const view = invoiceTaxView(invoice);
  if (!view.hasDetails) return null;

  return (
    <div className="mt-1 space-y-0.5 text-xs font-normal text-text-secondary" role="group" aria-label="Tax details">
      {view.subtotalMinor !== null && view.lines.length > 0 && (
        <p>Subtotal {formatInvoiceAmount(view.subtotalMinor, invoice.currency)}</p>
      )}
      {view.lines.map((line) => (
        <p key={line.key}>
          {line.label} {formatInvoiceAmount(line.amountMinor, invoice.currency)}
        </p>
      ))}
      {view.reverseCharge && <p>Reverse charge applies. No tax was charged on this invoice.</p>}
      {view.taxIds.map((id) => (
        <p key={id.key}>
          {id.label}: <span className="font-medium text-text-primary">{id.value}</span>
        </p>
      ))}
    </div>
  );
}
