/**
 * Split payments card for /dashboard/invoicing/:id
 *
 * Lets several payers (customer + insurer, landlord + tenant, ...) cover one
 * invoice. Each payer has a share and a private pay link. Every payment still
 * lands in the normal invoice ledger (with a payer_id), so balance, status,
 * refunds and the PDF keep working unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Copy, Loader2, Mail, Pencil, Plus, RefreshCw, Trash2, TriangleAlert, Users } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { RecordSplitPaymentDialog, RemoveSplitDialog, SplitPlanDialog } from '@/components/invoicing/SplitDialogs';
import { useToast } from '@/contexts/ToastContext';
import { formatCents, type Invoice } from '@/lib/invoices';
import { rpcErrorMessage, type InvoiceLedger, type InvoicePayment, type InvoiceRefund } from '@/lib/invoiceDetail';
import {
  SPLIT_ROLE_LABELS,
  clearInvoiceSplit,
  computePayerStandings,
  emailSplitLink,
  fetchSplitPayers,
  getSplitPayLink,
  isSplitStale,
  recordSplitPayment,
  saveInvoiceSplit,
  unattributedNetCents,
  type PayerState,
  type SplitPayer,
} from '@/lib/invoiceSplit';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 shadow-card sm:p-5 dark:shadow-card-dark';

const STATE_LABELS: Record<PayerState, string> = { unpaid: 'Unpaid', partial: 'Partly paid', paid: 'Paid' };
const STATE_STYLES: Record<PayerState, string> = {
  unpaid: 'bg-bg-tertiary text-text-secondary',
  partial: 'bg-warning-500/15 text-warning-500',
  paid: 'bg-success-500/15 text-success-500',
};

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function shareSummary(p: SplitPayer): string {
  if (p.share_type === 'percent') return `${Number(p.share_value ?? 0)}% of the invoice`;
  if (p.share_type === 'remainder') return 'Covers the remainder';
  return 'Fixed amount';
}

type Dialog = null | { type: 'plan' } | { type: 'pay'; payerId: string } | { type: 'remove' };
type LoadState = 'loading' | 'ready' | 'error';

interface Props {
  ownerId: string;
  invoice: Invoice;
  ledger: InvoiceLedger;
  payments: InvoicePayment[];
  refunds: InvoiceRefund[];
  /** Re-fetches the invoice detail (payments, refunds, status) after a change. */
  onChanged: () => Promise<void>;
}

export function SplitPaymentsCard({ ownerId, invoice, ledger, payments, refunds, onChanged }: Props) {
  const { toast } = useToast();
  const [state, setState] = useState<LoadState>('loading');
  const [payers, setPayers] = useState<SplitPayer[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      setPayers(await fetchSplitPayers(ownerId, invoice.id));
      loadedOnce.current = true;
      setState('ready');
    } catch {
      // Keep showing what we already have if a background refresh fails.
      if (!loadedOnce.current) setState('error');
    }
  }, [ownerId, invoice.id]);

  // Re-runs whenever the page re-fetches the invoice, so online payments show up after a refresh.
  useEffect(() => { void load(); }, [load, payments]);

  const standings = useMemo(() => computePayerStandings(payers, payments, refunds), [payers, payments, refunds]);
  const looseCents = useMemo(() => unattributedNetCents(payers, payments, refunds), [payers, payments, refunds]);

  const isVoid = invoice.status === 'void';
  const isDraft = invoice.status === 'draft';
  const stale = isSplitStale(payers, ledger.totalCents);
  const hasPayerPayments = payments.some((p) => p.payer_id && payers.some((x) => x.id === p.payer_id));
  const canPay = !isVoid && !stale && ledger.balanceCents > 0;

  const refreshAll = useCallback(async () => { await Promise.all([load(), onChanged()]); }, [load, onChanged]);

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

  const copyLink = async (p: SplitPayer) => {
    try {
      await navigator.clipboard.writeText(getSplitPayLink(p.public_token));
      toast(`Link for ${p.name} copied.`, 'success');
    } catch {
      toast('Could not copy the link.', 'error');
    }
  };

  if (state === 'ready' && payers.length === 0 && isVoid) return null;

  return (
    <section className={card} aria-labelledby="split-title">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="split-title" className="text-sm font-semibold text-text-primary">Split payments</h2>
          {payers.length > 0 && <p className="text-xs text-text-secondary">{payers.length} payers · each pays their own share</p>}
        </div>
        {payers.length > 0 && !isVoid && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setDialog({ type: 'plan' })} disabled={!!busy}><Pencil size={14} /> Edit</Button>
            <Button
              size="sm"
              variant="ghost"
              className="!text-danger"
              onClick={() => setDialog({ type: 'remove' })}
              disabled={!!busy || hasPayerPayments}
              title={hasPayerPayments ? 'Money was already collected through this split' : undefined}
              aria-label="Remove split"
            >
              <Trash2 size={14} />
            </Button>
          </div>
        )}
      </div>

      {state === 'loading' && (
        <div aria-busy="true" aria-label="Loading split payments" className="mt-4 space-y-3">
          <div className="h-12 animate-pulse rounded-xl bg-bg-tertiary" />
          <div className="h-12 animate-pulse rounded-xl bg-bg-tertiary" />
        </div>
      )}

      {state === 'error' && (
        <EmptyState
          className="mt-4"
          icon={TriangleAlert}
          title="Couldn’t load the split"
          description="Check your connection and try again."
          action={{ label: 'Try again', onClick: () => { setState('loading'); void load(); } }}
        />
      )}

      {state === 'ready' && payers.length === 0 && (
        <EmptyState
          className="mt-4"
          icon={Users}
          title="Split this invoice"
          description={
            ledger.totalCents > 0
              ? 'Let an insurer, landlord or another party pay part of it. Each payer gets their own secure link.'
              : 'Add line items to this invoice before splitting it.'
          }
          action={ledger.totalCents > 0 ? { label: 'Set up split', onClick: () => setDialog({ type: 'plan' }) } : undefined}
        />
      )}

      {state === 'ready' && payers.length > 0 && (
        <>
          {stale && (
            <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warning-500/10 px-3 py-2 text-xs text-warning-500">
              <span className="flex items-start gap-2"><TriangleAlert size={14} className="mt-0.5 shrink-0" /> The invoice total changed after this split was saved. Payer links are paused until you update it.</span>
              {!isVoid && <Button size="sm" variant="secondary" onClick={() => setDialog({ type: 'plan' })}><RefreshCw size={14} /> Update split</Button>}
            </div>
          )}
          {isDraft && !isVoid && (
            <p className="mt-3 rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">Send the invoice first — payer links start working once it is no longer a draft.</p>
          )}

          <ul className="mt-2 divide-y divide-border">
            {standings.map((s) => {
              const p = s.payer;
              const pct = Math.min(100, Math.round((Math.max(0, s.netPaidCents) / p.amount_cents) * 100));
              const canEmail = !!p.email && !isVoid && !stale && !isDraft && s.remainingCents > 0;
              return (
                <li key={p.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="break-words text-sm font-medium text-text-primary">{p.name}</p>
                        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-semibold uppercase text-text-secondary">{SPLIT_ROLE_LABELS[p.role]}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATE_STYLES[s.state]}`}>{STATE_LABELS[s.state]}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-text-secondary">{shareSummary(p)}{p.link_sent_at ? ` · link emailed ${fmtDate(p.link_sent_at)}` : ''}</p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums text-text-primary">{formatCents(p.amount_cents)}</p>
                  </div>

                  <div
                    role="progressbar"
                    aria-label={`${p.name} paid`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-tertiary"
                  >
                    <div className={`h-full rounded-full ${s.state === 'paid' ? 'bg-success-500' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">
                    Paid {formatCents(Math.max(0, s.netPaidCents))} · Remaining {formatCents(s.remainingCents)}
                  </p>

                  {s.overCents > 0 && (
                    <p className="mt-1 text-xs text-warning-500">Paid {formatCents(s.overCents)} more than their share. Edit the split to rebalance.</p>
                  )}
                  {p.needs_review && (
                    <p role="alert" className="mt-1 flex items-start gap-1.5 text-xs text-danger-500">
                      <TriangleAlert size={12} className="mt-0.5 shrink-0" /> An online payment from this payer couldn’t be booked (the invoice was voided or already covered). Check Stripe and refund it if needed.
                    </p>
                  )}

                  {!isVoid && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={() => void copyLink(p)} disabled={!!busy}><Copy size={14} /> Copy link</Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!!busy || !canEmail}
                        title={!p.email ? 'Add an email for this payer first' : isDraft ? 'Send the invoice first' : undefined}
                        onClick={() => void run(`email-${p.id}`, async () => { await emailSplitLink(p.id); }, `Link emailed to ${p.name}.`, 'Could not send the email.')}
                      >
                        {busy === `email-${p.id}` ? <Loader2 size={14} className="animate-spin" /> : p.link_sent_at ? <BellRing size={14} /> : <Mail size={14} />}
                        {p.link_sent_at ? 'Resend' : 'Email link'}
                      </Button>
                      {canPay && s.remainingCents > 0 && (
                        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setDialog({ type: 'pay', payerId: p.id })}><Plus size={14} /> Record payment</Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {looseCents > 0 && (
            <p className="mt-1 rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
              {formatCents(looseCents)} was paid on this invoice without being assigned to a payer.
            </p>
          )}
        </>
      )}

      {dialog?.type === 'plan' && (
        <SplitPlanDialog
          key="plan"
          totalCents={ledger.totalCents}
          payers={payers}
          standings={standings}
          onClose={() => setDialog(null)}
          onSubmit={async (payload) => {
            await saveInvoiceSplit(invoice.id, payload);
            setDialog(null);
            toast('Split saved.', 'success');
            await refreshAll();
          }}
        />
      )}
      {dialog?.type === 'pay' && (() => {
        const target = standings.find((s) => s.payer.id === dialog.payerId);
        if (!target) return null;
        return (
          <RecordSplitPaymentDialog
            key="pay"
            payerName={target.payer.name}
            remainingCents={target.remainingCents}
            balanceCents={ledger.balanceCents}
            onClose={() => setDialog(null)}
            onSubmit={async (v) => {
              await recordSplitPayment({ payerId: target.payer.id, ...v });
              setDialog(null);
              toast('Payment recorded.', 'success');
              await refreshAll();
            }}
          />
        );
      })()}
      {dialog?.type === 'remove' && (
        <RemoveSplitDialog
          key="remove"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await clearInvoiceSplit(invoice.id);
            setDialog(null);
            toast('Split removed.', 'success');
            await refreshAll();
          }}
        />
      )}
    </section>
  );
}
