import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  CreditCard,
  Download,
  ExternalLink,
  Loader as Loader2,
  Lock,
  Receipt,
  RefreshCw,
  ShieldCheck,
  TriangleAlert as AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { supabase } from '@/lib/supabase';
import {
  INVOICE_STATUS_META,
  TONE_CLASSES,
  brandLabel,
  cardExpiryState,
  formatExpiry,
  formatInvoiceAmount,
  formatInvoiceDate,
  invoicePeriodLabel,
  mergeInvoices,
  summarizeInvoices,
  type SavedCard,
  type SubscriptionInvoice,
  type SubscriptionInvoicesResponse,
} from '@/lib/subscriptionInvoices';

// ============================================================
// BillingInvoicesPage — /dashboard/billing/invoices
// ============================================================
//
// The Vireek subscription's invoice history (PDF + hosted invoice links come
// straight from Stripe, so they are the legal record) and the cards on file.
// Data comes from the billing-invoices edge function, which enforces the same
// owner / can_view_billing rule as this page's UI gate. Card changes are never
// handled here — they hand off to the existing Stripe Billing Portal flow at
// /dashboard/billing/update-payment, so card data never touches Vireek.

type LoadState = 'loading' | 'ready' | 'error';

interface PageMeta {
  hasBillingAccount: boolean;
  canManagePaymentMethods: boolean;
  hasMore: boolean;
  nextCursor: string | null;
}

const INITIAL_META: PageMeta = { hasBillingAccount: true, canManagePaymentMethods: false, hasMore: false, nextCursor: null };

/** supabase-js hides the JSON body of non-2xx responses; pull our friendly message back out. */
async function readFunctionError(error: unknown, fallback: string): Promise<string> {
  try {
    const response = (error as { context?: Response } | null)?.context;
    if (response && typeof response.json === 'function') {
      const body = (await response.json()) as { error?: string };
      if (body?.error) return body.error;
    }
  } catch {
    // fall through to the generic message
  }
  return error instanceof Error && error.message && !/non-2xx/i.test(error.message) ? error.message : fallback;
}

function NoAccess() {
  return (
    <DashboardLayout activeLabel="Billing Invoices">
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
          <Lock size={26} />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          Billing access is restricted. Ask your account owner to grant you the "View Billing" permission.
        </p>
      </div>
    </DashboardLayout>
  );
}

function StatusBadge({ status }: { status: SubscriptionInvoice['status'] }) {
  const meta = INVOICE_STATUS_META[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[meta.tone]}`}>
      {meta.label}
    </span>
  );
}

const ACTION_LINK =
  'focus-ring inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary transition-colors hover:border-accent/40 hover:bg-bg-tertiary';

function InvoiceActions({ invoice }: { invoice: SubscriptionInvoice }) {
  const label = invoice.number ?? invoice.id;
  const canPay = invoice.status === 'open' && invoice.hostedUrl;
  if (!invoice.pdfUrl && !invoice.hostedUrl) return <span className="text-xs text-text-secondary">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {invoice.pdfUrl && (
        <a
          href={invoice.pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={ACTION_LINK}
          aria-label={`Download PDF for invoice ${label}`}
        >
          <Download size={13} aria-hidden="true" /> PDF
        </a>
      )}
      {invoice.hostedUrl && (
        <a
          href={invoice.hostedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={canPay ? `${ACTION_LINK} border-warning-500/40 text-warning-500` : ACTION_LINK}
          aria-label={`${canPay ? 'Pay' : 'View'} invoice ${label} online`}
        >
          <ExternalLink size={13} aria-hidden="true" /> {canPay ? 'Pay now' : 'View'}
        </a>
      )}
    </div>
  );
}

function StatTile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warning' | 'success' }) {
  const valueColor = tone === 'warning' ? 'text-warning-500' : tone === 'success' ? 'text-success-500' : 'text-text-primary';
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className={`mt-1.5 text-2xl font-bold tracking-tight ${valueColor}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function PaymentMethodRow({ card }: { card: SavedCard }) {
  const expiry = cardExpiryState(card);
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-3.5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
        <CreditCard size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-text-primary">
          {brandLabel(card.brand)} •••• {card.last4}
        </p>
        <p className="text-xs text-text-secondary">Expires {formatExpiry(card)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
        {card.isDefault && (
          <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">Default</span>
        )}
        {expiry === 'expired' && (
          <span className="rounded-full bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">Expired</span>
        )}
        {expiry === 'expiring' && (
          <span className="rounded-full bg-warning-500/10 px-2.5 py-1 text-xs font-medium text-warning-500">Expiring soon</span>
        )}
      </div>
    </li>
  );
}

export function BillingInvoicesPage() {
  const navigate = useNavigate();
  const { user, profileLoading, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_view_billing;

  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [invoices, setInvoices] = useState<SubscriptionInvoice[]>([]);
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [meta, setMeta] = useState<PageMeta>(INITIAL_META);
  const [loadingMore, setLoadingMore] = useState(false);
  const generationRef = useRef(0);

  const fetchPage = useCallback(async (cursor: string | null): Promise<SubscriptionInvoicesResponse> => {
    const { data, error } = await supabase.functions.invoke<SubscriptionInvoicesResponse>('billing-invoices', {
      body: cursor ? { cursor } : {},
    });
    if (error || !data || data.error) {
      throw new Error(data?.error || (await readFunctionError(error, 'Could not load your invoices.')));
    }
    return data;
  }, []);

  const loadInitial = useCallback(async () => {
    const generation = ++generationRef.current;
    setState('loading');
    setErrorMessage('');
    try {
      const res = await fetchPage(null);
      if (generation !== generationRef.current) return;
      setInvoices(res.invoices);
      setCards(res.cards);
      setMeta({
        hasBillingAccount: res.hasBillingAccount,
        canManagePaymentMethods: res.canManagePaymentMethods,
        hasMore: res.hasMore,
        nextCursor: res.nextCursor,
      });
      setState('ready');
    } catch (err) {
      if (generation !== generationRef.current) return;
      setErrorMessage(err instanceof Error ? err.message : 'Could not load your invoices.');
      setState('error');
    }
  }, [fetchPage]);

  useEffect(() => {
    if (profileLoading || !user || !canAccess) return;
    void loadInitial();
    return () => {
      generationRef.current += 1; // drop any in-flight response after unmount / re-run
    };
  }, [profileLoading, user, canAccess, loadInitial]);

  const loadMore = useCallback(async () => {
    if (!meta.nextCursor || loadingMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    try {
      const res = await fetchPage(meta.nextCursor);
      if (generation !== generationRef.current) return;
      setInvoices((prev) => mergeInvoices(prev, res.invoices));
      setMeta((prev) => ({ ...prev, hasMore: res.hasMore, nextCursor: res.nextCursor }));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load more invoices.', 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [meta.nextCursor, loadingMore, fetchPage, toast]);

  const summary = useMemo(() => summarizeInvoices(invoices), [invoices]);
  const hasDefaultExpired = cards.some((c) => c.isDefault && cardExpiryState(c) === 'expired');
  const goUpdatePayment = () => navigate('/dashboard/billing/update-payment');

  if (profileLoading) {
    return (
      <DashboardLayout activeLabel="Billing Invoices">
        <SkeletonStatGrid count={3} />
      </DashboardLayout>
    );
  }
  if (!canAccess) return <NoAccess />;

  return (
    <DashboardLayout activeLabel="Billing Invoices">
      <button
        type="button"
        onClick={() => navigate('/dashboard/billing')}
        className="focus-ring mb-4 flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Back to Billing
      </button>

      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Receipt size={24} aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Subscription invoices</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Your Vireek invoice history, PDF receipts and the payment methods on file.
          </p>
        </div>
      </div>

      {state === 'loading' && (
        <div aria-busy="true" aria-live="polite">
          <SkeletonStatGrid count={3} className="mb-6" />
          <SkeletonTable rows={5} columns={5} />
        </div>
      )}

      {state === 'error' && (
        <div role="alert" className="flex flex-col items-center rounded-2xl border border-danger/30 bg-danger/10 px-6 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/15 text-danger">
            <AlertTriangle size={22} aria-hidden="true" />
          </span>
          <h3 className="mt-4 text-base font-semibold text-text-primary">We couldn't load your invoices</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">{errorMessage}</p>
          <Button variant="primary" size="sm" className="mt-5" onClick={() => void loadInitial()}>
            <RefreshCw size={14} aria-hidden="true" /> Try again
          </Button>
        </div>
      )}

      {state === 'ready' && !meta.hasBillingAccount && (
        <EmptyState
          icon={Receipt}
          title="No invoices yet"
          description="Your Starter plan is free, so there is nothing to invoice. Invoices appear here after your first paid subscription charge."
          action={{ label: 'View plans', onClick: () => navigate('/dashboard/billing') }}
        />
      )}

      {state === 'ready' && meta.hasBillingAccount && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
          {(summary.outstandingCount > 0 || hasDefaultExpired) && (
            <div
              role="alert"
              className="mb-6 flex flex-col gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/10 p-4 sm:flex-row sm:items-center"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning-500/15 text-warning-500">
                <AlertTriangle size={20} aria-hidden="true" />
              </span>
              <p className="flex-1 text-sm font-semibold text-text-primary">
                {summary.outstandingCount > 0
                  ? `${summary.outstandingCount} unpaid invoice${summary.outstandingCount === 1 ? '' : 's'} totaling ${formatInvoiceAmount(summary.outstandingMinor, summary.currency)}.`
                  : 'Your default card has expired.'}{' '}
                <span className="font-normal text-text-secondary">
                  {meta.canManagePaymentMethods ? 'Update your card to keep your service running.' : 'Ask the account owner to update the card.'}
                </span>
              </p>
              {meta.canManagePaymentMethods && (
                <Button variant="primary" size="sm" onClick={goUpdatePayment}>
                  Update payment method
                </Button>
              )}
            </div>
          )}

          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <StatTile
              label="Outstanding balance"
              value={formatInvoiceAmount(summary.outstandingMinor, summary.currency)}
              hint={summary.outstandingCount > 0 ? `${summary.outstandingCount} unpaid` : 'All paid up'}
              tone={summary.outstandingCount > 0 ? 'warning' : 'success'}
            />
            <StatTile
              label="Last payment"
              value={summary.lastPaid ? formatInvoiceAmount(summary.lastPaid.amountPaid, summary.lastPaid.currency) : '—'}
              hint={summary.lastPaid ? formatInvoiceDate(summary.lastPaid.createdAt) : 'No payments yet'}
            />
            <StatTile
              label="Invoices"
              value={`${invoices.length}${meta.hasMore ? '+' : ''}`}
              hint="Newest first"
            />
          </div>

          {invoices.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No invoices yet"
              description="Your first invoice will show up here as soon as it is issued."
            />
          ) : (
            <section aria-label="Invoice history" className="mb-8">
              {/* Desktop table */}
              <div className="hidden overflow-hidden rounded-2xl border border-border bg-bg-secondary md:block">
                <table className="w-full text-sm">
                  <caption className="sr-only">Vireek subscription invoices, newest first</caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-text-secondary">
                      <th scope="col" className="px-5 py-3 font-medium">Invoice</th>
                      <th scope="col" className="px-5 py-3 font-medium">Date</th>
                      <th scope="col" className="px-5 py-3 font-medium">Amount</th>
                      <th scope="col" className="px-5 py-3 font-medium">Status</th>
                      <th scope="col" className="px-5 py-3 font-medium">Receipt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {invoices.map((invoice) => (
                      <tr key={invoice.id}>
                        <td className="px-5 py-3.5">
                          <p className="font-semibold text-text-primary">{invoice.number ?? invoice.id}</p>
                          {(invoicePeriodLabel(invoice) ?? invoice.description) && (
                            <p className="mt-0.5 max-w-xs truncate text-xs text-text-secondary">
                              {invoicePeriodLabel(invoice) ?? invoice.description}
                            </p>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5 text-text-secondary">{formatInvoiceDate(invoice.createdAt)}</td>
                        <td className="whitespace-nowrap px-5 py-3.5 font-semibold text-text-primary">
                          {formatInvoiceAmount(invoice.total, invoice.currency)}
                        </td>
                        <td className="px-5 py-3.5"><StatusBadge status={invoice.status} /></td>
                        <td className="px-5 py-3.5"><InvoiceActions invoice={invoice} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <ul className="space-y-3 md:hidden">
                {invoices.map((invoice) => (
                  <li key={invoice.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text-primary">{invoice.number ?? invoice.id}</p>
                        <p className="mt-0.5 text-xs text-text-secondary">{formatInvoiceDate(invoice.createdAt)}</p>
                      </div>
                      <StatusBadge status={invoice.status} />
                    </div>
                    <p className="mt-3 text-lg font-bold text-text-primary">{formatInvoiceAmount(invoice.total, invoice.currency)}</p>
                    {invoicePeriodLabel(invoice) && <p className="mt-0.5 text-xs text-text-secondary">{invoicePeriodLabel(invoice)}</p>}
                    <div className="mt-3"><InvoiceActions invoice={invoice} /></div>
                  </li>
                ))}
              </ul>

              {meta.hasMore && (
                <div className="mt-4 flex justify-center">
                  <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                    {loadingMore ? 'Loading…' : 'Load more invoices'}
                  </Button>
                </div>
              )}
            </section>
          )}

          <Card>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <CreditCard size={18} className="text-text-secondary" aria-hidden="true" />
                  <h2 className="text-base font-semibold text-text-primary">Payment methods</h2>
                </div>
                <p className="mt-1 text-xs text-text-secondary">The card charged for your Vireek subscription.</p>
              </div>
              {meta.canManagePaymentMethods ? (
                <Button variant="secondary" size="sm" onClick={goUpdatePayment}>
                  Update payment method
                </Button>
              ) : (
                <p className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <Lock size={12} aria-hidden="true" /> Only the account owner can change payment methods.
                </p>
              )}
            </div>

            {cards.length === 0 ? (
              <p className="mt-5 rounded-xl border border-dashed border-border bg-bg-primary p-4 text-sm text-text-secondary">
                There is no card on file for this account.
              </p>
            ) : (
              <ul className="mt-5 space-y-2.5">
                {cards.map((card) => (
                  <PaymentMethodRow key={card.id} card={card} />
                ))}
              </ul>
            )}

            <p className="mt-5 flex items-center gap-1.5 border-t border-border pt-4 text-xs text-text-secondary">
              <ShieldCheck size={13} className="text-accent" aria-hidden="true" />
              Card details are stored by Stripe, never on Vireek's servers.
            </p>
          </Card>
        </motion.div>
      )}
    </DashboardLayout>
  );
}
