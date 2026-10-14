/**
 * Invoice detail — /dashboard/invoicing/:id
 *
 * Line items, payments, refunds, reminder log, PDF, resend and audit trail.
 * Every read is scoped to the account owner (accountOwnerId) and the page is
 * gated on `can_view_billing`; the database enforces the same rules via RLS
 * and the SECURITY DEFINER RPCs, so this gate is UX, not security.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, BellRing, Copy, Download, FileX2, Loader2, Lock, Mail, Plus, RefreshCw, Send, Undo2, Ban, TriangleAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { InvoiceAuditTrail, InvoiceTimeline, fmtDateTime } from '@/components/invoicing/InvoiceActivity';
import { RecordPaymentDialog, RefundDialog, VoidDialog } from '@/components/invoicing/InvoiceDialogs';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { formatCents, getInvoiceLink } from '@/lib/invoices';
import {
  DISPLAY_STATUS_LABELS,
  DISPLAY_STATUS_STYLES,
  PAYMENT_METHOD_LABELS,
  buildTimeline,
  computeInvoiceLedger,
  fetchInvoiceAuditTrail,
  fetchInvoiceDetail,
  getDisplayStatus,
  recordInvoicePayment,
  recordInvoiceRefund,
  refundableForPayment,
  reminderCooldownMs,
  rpcErrorMessage,
  sendInvoiceEmail,
  voidInvoice,
  type InvoiceAuditEntry,
  type InvoiceDetailData,
  type ReminderKind,
} from '@/lib/invoiceDetail';
import { downloadInvoicePdf } from '@/lib/invoicePdf';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const card = 'rounded-2xl border border-border bg-bg-secondary p-4 shadow-card sm:p-5 dark:shadow-card-dark';
const fmtDate = (iso: string | null) => (iso ? new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

type Dialog = null | { type: 'payment' } | { type: 'refund'; paymentId?: string } | { type: 'void' };
type LoadState = 'loading' | 'ready' | 'not_found' | 'error';

function Shell({ children }: { children: React.ReactNode }) {
  return <DashboardLayout activeLabel="Invoicing"><div className="mx-auto max-w-6xl space-y-5">{children}</div></DashboardLayout>;
}

function BackLink() {
  return (
    <Link to="/dashboard/invoicing" className="focus-ring inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary">
      <ArrowLeft size={14} /> All invoices
    </Link>
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading invoice" className="space-y-5">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-bg-tertiary" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="h-72 animate-pulse rounded-2xl bg-bg-tertiary" />
        <div className="h-72 animate-pulse rounded-2xl bg-bg-tertiary" />
      </div>
    </div>
  );
}

function Stat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className={card}>
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums text-text-primary sm:text-xl ${tone}`}>{value}</p>
    </div>
  );
}

export function InvoiceDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { isOwner, permissions, profile, teamMember, profileLoading } = useAuth();
  const { toast } = useToast();

  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canView = isOwner || permissions.can_view_billing;
  const canAudit = isOwner || permissions.can_view_audit_log;

  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<InvoiceDetailData | null>(null);
  const [audit, setAudit] = useState<InvoiceAuditEntry[] | null>(null);
  const [auditError, setAuditError] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!UUID_RE.test(id)) { setState('not_found'); return; }
    if (!accountOwnerId) { setState('error'); return; }
    if (!opts.silent) setState('loading');
    try {
      const detail = await fetchInvoiceDetail(accountOwnerId, id);
      if (!detail) { setData(null); setState('not_found'); return; }
      setData(detail);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [accountOwnerId, id]);

  const loadAudit = useCallback(async () => {
    if (!canAudit) return;
    setAuditError(false);
    try {
      setAudit(await fetchInvoiceAuditTrail(id));
    } catch {
      setAuditError(true);
    }
  }, [canAudit, id]);

  useEffect(() => {
    if (!canView || profileLoading) return;
    void load();
  }, [canView, profileLoading, load]);

  useEffect(() => {
    if (canView && state === 'ready' && UUID_RE.test(id)) void loadAudit();
    // Re-fetch only when the invoice changes, not after every refresh; mutations call loadAudit() themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, state === 'ready', id]);

  const refreshAll = useCallback(async () => {
    await Promise.all([load({ silent: true }), loadAudit()]);
  }, [load, loadAudit]);

  const ledger = useMemo(() => (data ? computeInvoiceLedger(data.invoice, data.payments, data.refunds) : null), [data]);
  const timeline = useMemo(() => (data ? buildTimeline(data.invoice, data.payments, data.refunds, data.reminders) : []), [data]);

  const run = async (key: string, fn: () => Promise<void>, success: string, failure: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      toast(success, 'success');
      await refreshAll();
    } catch (e) {
      toast(rpcErrorMessage(e, failure), 'error');
    } finally {
      setBusy(null);
    }
  };

  // ─── Gates & page-level states ────────────────────────────────────────────
  if (profileLoading) {
    return <Shell><DetailSkeleton /></Shell>;
  }

  if (!canView) {
    return (
      <Shell>
        <BackLink />
        <EmptyState icon={Lock} title="You don’t have access to billing" description="Ask the account owner to enable “View billing” for your role to see invoice details." />
      </Shell>
    );
  }

  if (state === 'loading') return <Shell><BackLink /><DetailSkeleton /></Shell>;

  if (state === 'not_found') {
    return (
      <Shell>
        <BackLink />
        <EmptyState icon={FileX2} title="Invoice not found" description="It may have been deleted, or it belongs to a different account." />
      </Shell>
    );
  }

  if (state === 'error' || !data || !ledger) {
    return (
      <Shell>
        <BackLink />
        <EmptyState icon={TriangleAlert} title="Couldn’t load this invoice" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void load() }} />
      </Shell>
    );
  }

  const { invoice, payments, refunds, reminders, businessName } = data;
  const status = getDisplayStatus(invoice, ledger);
  const isVoid = invoice.status === 'void';
  const canRecordPayment = !isVoid && ledger.balanceCents > 0;
  const hasRefundable = payments.some((p) => refundableForPayment(p, refunds) > 0);
  const hasEmail = Boolean(invoice.customer_email?.trim());
  const cooldown = reminderCooldownMs(reminders);
  const canRemind = !isVoid && invoice.status !== 'draft' && ledger.balanceCents > 0;
  const cooldownLabel = cooldown > 0 ? `Available in ${Math.ceil(cooldown / 3_600_000)}h` : undefined;
  const sendKind: ReminderKind = invoice.status === 'draft' ? 'initial' : 'resend';

  const sendEmail = (kind: ReminderKind) =>
    run(`email-${kind}`, async () => { await sendInvoiceEmail(invoice.id, kind); }, kind === 'reminder' ? 'Reminder sent.' : 'Invoice emailed.', 'Could not send the email.');

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(getInvoiceLink(invoice.invoice_token));
      toast('Link copied.', 'success');
    } catch {
      toast('Could not copy the link.', 'error');
    }
  };

  const downloadPdf = async () => {
    setBusy('pdf');
    try {
      await downloadInvoicePdf({ invoice, ledger, payments, refunds, businessName });
    } catch {
      toast('Could not generate the PDF.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Shell>
      <BackLink />

      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold text-text-primary sm:text-2xl">{invoice.invoice_number}</h1>
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase ${DISPLAY_STATUS_STYLES[status]}`}>{DISPLAY_STATUS_LABELS[status]}</span>
          </div>
          <p className="mt-1 truncate text-sm text-text-secondary">{invoice.customer_name}{businessName ? ` · billed by ${businessName}` : ''}</p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          {canRecordPayment && (
            <Button size="sm" onClick={() => setDialog({ type: 'payment' })} disabled={!!busy}><Plus size={14} /> Record payment</Button>
          )}
          {!isVoid && ledger.state !== 'paid' && (
            <Button size="sm" variant="secondary" onClick={() => void sendEmail(sendKind)} disabled={!!busy || !hasEmail} title={hasEmail ? undefined : 'Add a customer email to this invoice first'}>
              {busy?.startsWith('email-') && busy !== 'email-reminder' ? <Loader2 size={14} className="animate-spin" /> : sendKind === 'initial' ? <Send size={14} /> : <Mail size={14} />}
              {sendKind === 'initial' ? 'Send' : 'Resend'}
            </Button>
          )}
          {canRemind && (
            <Button size="sm" variant="secondary" onClick={() => void sendEmail('reminder')} disabled={!!busy || !hasEmail || cooldown > 0} title={cooldownLabel}>
              {busy === 'email-reminder' ? <Loader2 size={14} className="animate-spin" /> : <BellRing size={14} />} Remind
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => void downloadPdf()} disabled={!!busy}>
            {busy === 'pdf' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} PDF
          </Button>
          {invoice.status !== 'draft' && !isVoid && (
            <Button size="sm" variant="ghost" onClick={() => void copyLink()}><Copy size={14} /> Copy link</Button>
          )}
          {hasRefundable && !isVoid && (
            <Button size="sm" variant="ghost" onClick={() => setDialog({ type: 'refund' })} disabled={!!busy}><Undo2 size={14} /> Refund</Button>
          )}
          {!isVoid && ledger.netPaidCents <= 0 && (
            <Button size="sm" variant="ghost" className="!text-danger" onClick={() => setDialog({ type: 'void' })} disabled={!!busy}><Ban size={14} /> Void</Button>
          )}
        </div>
      </div>

      {!hasEmail && !isVoid && ledger.state !== 'paid' && (
        <p className="flex items-center gap-2 rounded-xl bg-warning-500/10 px-3 py-2 text-xs text-warning-500">
          <TriangleAlert size={14} className="shrink-0" /> No customer email on file, so this invoice can’t be emailed. You can still copy the link once it’s sent.
        </p>
      )}
      {isVoid && (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-danger-500/10 px-3 py-2 text-sm text-danger-500">
          <Ban size={14} className="shrink-0" /> This invoice is void. It can’t be paid or sent.
        </p>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total" value={formatCents(ledger.totalCents)} />
        <Stat label="Paid (net of refunds)" value={formatCents(Math.max(0, ledger.netPaidCents))} tone={ledger.netPaidCents > 0 ? 'text-success-500' : ''} />
        <Stat label="Balance due" value={formatCents(isVoid ? 0 : ledger.balanceCents)} tone={!isVoid && ledger.balanceCents > 0 && status === 'overdue' ? 'text-danger-500' : ''} />
        <Stat label={status === 'overdue' ? 'Overdue since' : 'Due date'} value={fmtDate(invoice.due_date)} tone={status === 'overdue' ? 'text-danger-500' : ''} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          {/* Line items */}
          <section className={card} aria-labelledby="li-title">
            <h2 id="li-title" className="text-sm font-semibold text-text-primary">Line items</h2>
            {invoice.line_items.length === 0 ? (
              <p className="mt-3 text-sm text-text-secondary">This invoice has no line items.</p>
            ) : (
              <>
                <div className="mt-3 hidden overflow-hidden rounded-xl border border-border md:block">
                  <table className="w-full text-sm">
                    <thead className="bg-bg-tertiary text-xs text-text-secondary">
                      <tr><th className="px-3 py-2 text-left font-medium">Description</th><th className="px-3 py-2 text-right font-medium">Qty</th><th className="px-3 py-2 text-right font-medium">Unit</th><th className="px-3 py-2 text-right font-medium">Amount</th></tr>
                    </thead>
                    <tbody className="divide-y divide-border text-text-primary">
                      {invoice.line_items.map((li, i) => (
                        <tr key={i}>
                          <td className="px-3 py-2.5">{li.description}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{li.quantity}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatCents(li.unit_price_cents)}</td>
                          <td className="px-3 py-2.5 text-right font-medium tabular-nums">{formatCents(li.quantity * li.unit_price_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="mt-3 divide-y divide-border md:hidden">
                  {invoice.line_items.map((li, i) => (
                    <li key={i} className="flex items-start justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="break-words text-sm text-text-primary">{li.description}</p>
                        <p className="text-xs text-text-secondary">{li.quantity} × {formatCents(li.unit_price_cents)}</p>
                      </div>
                      <p className="text-sm font-medium tabular-nums text-text-primary">{formatCents(li.quantity * li.unit_price_cents)}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <dl className="mt-4 ml-auto w-full max-w-xs space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-text-secondary">Subtotal</dt><dd className="tabular-nums text-text-primary">{formatCents(ledger.subtotalCents)}</dd></div>
              {invoice.tax_percent > 0 && <div className="flex justify-between"><dt className="text-text-secondary">Tax ({invoice.tax_percent}%)</dt><dd className="tabular-nums text-text-primary">{formatCents(ledger.taxCents)}</dd></div>}
              <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><dt className="text-text-primary">Total</dt><dd className="tabular-nums text-text-primary">{formatCents(ledger.totalCents)}</dd></div>
            </dl>
            {invoice.notes?.trim() && (
              <div className="mt-4 rounded-xl bg-bg-tertiary p-3">
                <p className="text-xs font-medium text-text-secondary">Notes</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text-primary">{invoice.notes}</p>
              </div>
            )}
          </section>

          {/* Payments & refunds */}
          <section className={card} aria-labelledby="pay-title">
            <div className="flex items-center justify-between gap-3">
              <h2 id="pay-title" className="text-sm font-semibold text-text-primary">Payments &amp; refunds</h2>
              {canRecordPayment && <Button size="sm" variant="ghost" onClick={() => setDialog({ type: 'payment' })} disabled={!!busy}><Plus size={14} /> Add</Button>}
            </div>
            {payments.length === 0 ? (
              <p className="mt-3 text-sm text-text-secondary">No payments recorded yet.{canRecordPayment ? ' Record one when the customer pays.' : ''}</p>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {payments.map((p) => {
                  const prefunds = refunds.filter((r) => r.payment_id === p.id);
                  const left = refundableForPayment(p, refunds);
                  return (
                    <li key={p.id} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text-primary">{PAYMENT_METHOD_LABELS[p.method]}{p.reference ? ` · ${p.reference}` : ''}</p>
                          <p className="text-xs text-text-secondary">{fmtDate(p.paid_at)}{p.created_by_email ? ` · by ${p.created_by_email}` : ''}</p>
                          {p.note && <p className="mt-0.5 break-words text-xs text-text-secondary">{p.note}</p>}
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold tabular-nums text-success-500">{formatCents(p.amount_cents)}</p>
                          {left > 0 && !isVoid && (
                            <button type="button" onClick={() => setDialog({ type: 'refund', paymentId: p.id })} className="focus-ring mt-0.5 rounded text-xs font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">Refund</button>
                          )}
                        </div>
                      </div>
                      {prefunds.map((r) => (
                        <div key={r.id} className="mt-2 flex items-start justify-between gap-3 rounded-lg bg-danger-500/5 px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-danger-500">Refund · {fmtDate(r.refunded_at)}</p>
                            <p className="break-words text-xs text-text-secondary">{r.reason}</p>
                          </div>
                          <p className="text-sm font-semibold tabular-nums text-danger-500">−{formatCents(r.amount_cents)}</p>
                        </div>
                      ))}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-5">
          <section className={card} aria-labelledby="cust-title">
            <h2 id="cust-title" className="text-sm font-semibold text-text-primary">Customer</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div><dt className="text-xs text-text-secondary">Name</dt><dd className="break-words text-text-primary">{invoice.customer_name}</dd></div>
              <div><dt className="text-xs text-text-secondary">Email</dt><dd className="break-all text-text-primary">{invoice.customer_email || '—'}</dd></div>
              <div><dt className="text-xs text-text-secondary">Phone</dt><dd className="text-text-primary">{invoice.customer_phone || '—'}</dd></div>
              <div><dt className="text-xs text-text-secondary">Created</dt><dd className="text-text-primary">{fmtDateTime(invoice.created_at)}</dd></div>
            </dl>
          </section>

          <section className={card} aria-labelledby="rem-title">
            <h2 id="rem-title" className="text-sm font-semibold text-text-primary">Reminders &amp; emails</h2>
            {reminders.length === 0 ? (
              <p className="mt-3 text-sm text-text-secondary">Nothing sent by email yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {reminders.map((r) => (
                  <li key={r.id} className="py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium capitalize text-text-primary">{r.kind === 'initial' ? 'Invoice' : r.kind}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${r.status === 'sent' ? 'bg-success-500/15 text-success-500' : 'bg-danger-500/15 text-danger-500'}`}>{r.status}</span>
                    </div>
                    <p className="break-all text-xs text-text-secondary">{r.recipient} · {fmtDateTime(r.created_at)}</p>
                    {r.error && <p className="mt-0.5 break-words text-xs text-danger-500">{r.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={card} aria-labelledby="act-title">
            <div className="flex items-center justify-between">
              <h2 id="act-title" className="text-sm font-semibold text-text-primary">Activity</h2>
              <button type="button" onClick={() => void refreshAll()} aria-label="Refresh" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"><RefreshCw size={14} /></button>
            </div>
            <div className="mt-4"><InvoiceTimeline events={timeline} /></div>
          </section>

          {canAudit && (
            <section className={card} aria-labelledby="aud-title">
              <h2 id="aud-title" className="text-sm font-semibold text-text-primary">Audit trail</h2>
              <p className="mb-2 mt-0.5 text-xs text-text-secondary">Who did what — tamper-proof, written by the server.</p>
              <InvoiceAuditTrail entries={audit} error={auditError} onRetry={() => void loadAudit()} />
            </section>
          )}
        </aside>
      </div>

        {dialog?.type === 'payment' && (
          <RecordPaymentDialog
            key="payment"
            balanceCents={ledger.balanceCents}
            onClose={() => setDialog(null)}
            onSubmit={async (v) => {
              await recordInvoicePayment({ invoiceId: invoice.id, ...v });
              setDialog(null);
              toast('Payment recorded.', 'success');
              await refreshAll();
            }}
          />
        )}
        {dialog?.type === 'refund' && (
          <RefundDialog
            key="refund"
            payments={payments}
            refunds={refunds}
            initialPaymentId={dialog.paymentId}
            onClose={() => setDialog(null)}
            onSubmit={async (v) => {
              await recordInvoiceRefund({ invoiceId: invoice.id, ...v });
              setDialog(null);
              toast('Refund recorded.', 'success');
              await refreshAll();
            }}
          />
        )}
        {dialog?.type === 'void' && (
          <VoidDialog
            key="void"
            invoiceNumber={invoice.invoice_number}
            onClose={() => setDialog(null)}
            onSubmit={async (reason) => {
              await voidInvoice(invoice.id, reason);
              setDialog(null);
              toast('Invoice voided.', 'success');
              await refreshAll();
            }}
          />
        )}
    </Shell>
  );
}
