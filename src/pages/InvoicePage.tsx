// Recreated: verify against original intent
// /invoice/:token  (public, no sign-in)
//
// Read-only invoice for the customer. The link token is the only credential; the database function
// `get_invoice_for_token` returns nothing for draft or void invoices. Every value comes from the server and is
// rendered as text only.
// TODO(vireek): there is no customer-facing "pay by invoice token" function in this repository (payments go through
// payment requests at /pay/:token), so this page does not offer a Pay button; it tells the customer to use the
// payment link they were sent. Add one here if an invoice-token payment flow exists in the original.

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, FileText, Printer } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { fetchInvoiceForToken, recordInvoiceView, type PublicInvoiceInfo } from '@/lib/invoices';
import { calculateQuoteTotals, formatCents } from '@/lib/quotes';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type View = { kind: 'loading' } | { kind: 'notfound' } | { kind: 'error' } | { kind: 'ready'; invoice: PublicInvoiceInfo };

function fmtDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function isPastDue(due: string | null, status: string): boolean {
  if (!due || status === 'paid') return false;
  const d = new Date(`${due}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return !Number.isNaN(d.getTime()) && d < today;
}

export function InvoicePage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const viewed = useRef(false);

  const load = async () => {
    if (!token || !UUID_RE.test(token)) {
      setView({ kind: 'notfound' });
      return;
    }
    setView({ kind: 'loading' });
    try {
      const invoice = await fetchInvoiceForToken(token);
      if (!invoice) {
        setView({ kind: 'notfound' });
        return;
      }
      setView({ kind: 'ready', invoice });
      if (!viewed.current) {
        viewed.current = true;
        void recordInvoiceView(token).catch(() => undefined); // a failed view receipt must never break the page
      }
    } catch {
      setView({ kind: 'error' });
    }
  };

  useEffect(() => {
    viewed.current = false;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        {view.kind === 'loading' && <p role="status" className="py-16 text-center text-sm text-text-secondary">Loading invoice…</p>}

        {view.kind === 'notfound' && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
            <AlertCircle className="mx-auto mb-3 h-8 w-8 text-text-secondary" aria-hidden="true" />
            <h1 className="text-lg font-semibold text-text-primary">Invoice not found</h1>
            <p className="mt-1 text-sm text-text-secondary">This link may be incorrect or the invoice is no longer available. Please contact the business that sent it.</p>
          </div>
        )}

        {view.kind === 'error' && (
          <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 p-8 text-center">
            <h1 className="text-lg font-semibold text-text-primary">We could not load this invoice</h1>
            <p className="mt-1 text-sm text-text-secondary">Check your connection and try again.</p>
            <button type="button" onClick={() => void load()} className="focus-ring mt-4 min-h-[44px] rounded-lg bg-accent px-5 text-sm font-semibold text-white">Try again</button>
          </div>
        )}

        {view.kind === 'ready' && <InvoiceBody invoice={view.invoice} />}
      </main>
      <Footer />
    </div>
  );
}

function InvoiceBody({ invoice }: { invoice: PublicInvoiceInfo }) {
  const items = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  const calc = calculateQuoteTotals(items, Number(invoice.tax_percent) || 0);
  // When the server computed jurisdiction tax, that figure wins over the flat percentage.
  const serverTax = typeof invoice.tax_cents === 'number' ? invoice.tax_cents : null;
  const taxCents = serverTax ?? calc.taxCents;
  const totalCents = calc.subtotalCents + taxCents;
  const paid = invoice.status === 'paid';
  const pastDue = isPastDue(invoice.due_date, invoice.status);
  const due = fmtDay(invoice.due_date);
  const breakdown = invoice.tax_breakdown ?? [];

  return (
    <article aria-labelledby="inv-title" className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-sm text-text-secondary"><FileText size={15} aria-hidden="true" />{invoice.business_name ?? 'Invoice'}</p>
          <h1 id="inv-title" className="mt-1 text-2xl font-bold text-text-primary">Invoice {invoice.invoice_number}</h1>
          <p className="mt-1 text-sm text-text-secondary">For {invoice.customer_name}</p>
        </div>
        <div className="text-right">
          {paid ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success-500/10 px-3 py-1 text-sm font-semibold text-success-500"><CheckCircle2 size={14} aria-hidden="true" />Paid</span>
          ) : pastDue ? (
            <span className="rounded-full bg-danger/10 px-3 py-1 text-sm font-semibold text-danger">Past due</span>
          ) : (
            <span className="rounded-full bg-bg-tertiary px-3 py-1 text-sm font-semibold text-text-secondary">Awaiting payment</span>
          )}
          {due && <p className="mt-2 text-xs text-text-secondary">Due {due}</p>}
        </div>
      </header>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-sm">
          <thead className="border-b border-border text-xs text-text-secondary">
            <tr><th scope="col" className="py-2 pe-3 font-semibold">Description</th><th scope="col" className="px-3 py-2 text-right font-semibold">Qty</th><th scope="col" className="px-3 py-2 text-right font-semibold">Price</th><th scope="col" className="ps-3 py-2 text-right font-semibold">Amount</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((li, i) => (
              <tr key={i}>
                <td className="py-2 pe-3 text-text-primary">{li.description}</td>
                <td className="px-3 py-2 text-right text-text-secondary">{li.quantity}</td>
                <td className="px-3 py-2 text-right text-text-secondary">{formatCents(li.unit_price_cents)}</td>
                <td className="ps-3 py-2 text-right text-text-primary">{formatCents(li.quantity * li.unit_price_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="mt-4 ms-auto w-full max-w-xs space-y-1 text-sm">
        <div className="flex justify-between"><dt className="text-text-secondary">Subtotal</dt><dd className="text-text-primary">{formatCents(calc.subtotalCents)}</dd></div>
        {breakdown.length > 0 ? (
          breakdown.map((b) => (
            <div key={`${b.level}:${b.name}`} className="flex justify-between"><dt className="text-text-secondary">{b.name} ({b.rate_percent}%)</dt><dd className="text-text-primary">{formatCents(b.tax_cents)}</dd></div>
          ))
        ) : (
          taxCents > 0 && <div className="flex justify-between"><dt className="text-text-secondary">Tax</dt><dd className="text-text-primary">{formatCents(taxCents)}</dd></div>
        )}
        {invoice.tax_exempt && <p className="text-xs text-text-secondary">Tax exempt</p>}
        <div className="flex justify-between border-t border-border pt-2 text-base font-bold"><dt className="text-text-primary">Total</dt><dd className="text-text-primary">{formatCents(totalCents)}</dd></div>
      </dl>

      {invoice.notes && <p className="mt-6 whitespace-pre-wrap break-words rounded-xl bg-bg-primary p-3 text-sm text-text-secondary">{invoice.notes}</p>}

      {!paid && <p className="mt-6 text-sm text-text-secondary">To pay online, use the payment link {invoice.business_name ?? 'the business'} sent you, or contact them to arrange payment.</p>}

      <div className="mt-6 print:hidden">
        <button type="button" onClick={() => window.print()} className="focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-border px-4 text-sm font-semibold text-text-primary"><Printer size={15} aria-hidden="true" />Print or save as PDF</button>
      </div>
    </article>
  );
}
