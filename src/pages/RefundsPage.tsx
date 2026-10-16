import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CreditCard, RefreshCw, Search, ShieldAlert, TriangleAlert as AlertTriangle, Undo2, Loader as Loader2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { RefundDialog } from '@/components/refunds/RefundDialog';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  REASON_META,
  REFUND_STATUS_META,
  fetchRefundablePayments,
  fetchRefunds,
  formatMoney,
  needsAttention,
  refundStateOf,
  resumeRefund,
  summarizeRefunds,
  type Refund,
  type RefundablePayment,
} from '@/lib/refunds';

type Tab = 'payments' | 'history';
type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary border-border',
  accent: 'bg-accent/10 text-accent border-accent/25',
  success: 'bg-success/10 text-success border-success/25',
  danger: 'bg-danger/10 text-danger border-danger/25',
  warning: 'bg-warning-500/10 text-warning-500 border-warning-500/25',
};

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[tone]}`}>{children}</span>;
}

function noticeBadge(r: Refund): { tone: Tone; label: string } {
  if (!r.notify_customer) return { tone: 'neutral', label: 'No notice' };
  if (r.notice_status === 'sent') return { tone: 'success', label: 'Customer notified' };
  if (r.notice_status === 'failed') return { tone: 'danger', label: 'Notice failed' };
  if (r.notice_status === 'skipped') return { tone: 'neutral', label: 'No contact on file' };
  return { tone: 'neutral', label: 'Notice pending' };
}

function ledgerBadge(r: Refund): { tone: Tone; label: string } | null {
  if (r.accounting_status === 'posted') return { tone: 'success', label: 'Posted to ledger' };
  if (r.accounting_status === 'reversed') return { tone: 'neutral', label: 'Ledger reversed' };
  if (r.accounting_status === 'failed') return { tone: 'danger', label: 'Ledger failed' };
  return r.status === 'pending' ? { tone: 'neutral', label: 'Ledger pending' } : null;
}

export function RefundsPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { isOwner, permissions } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canView = isOwner || permissions.can_view_billing;
  const canIssue = isOwner || permissions.can_issue_refunds;

  const [tab, setTab] = useState<Tab>('payments');
  const [payments, setPayments] = useState<RefundablePayment[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<RefundablePayment | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const loadedOnce = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    if (loadedOnce.current) setRefreshing(true);
    setError(null);
    try {
      const [p, r] = await Promise.all([fetchRefundablePayments({ search: debounced }), fetchRefunds()]);
      setPayments(p);
      setRefunds(r);
      loadedOnce.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load refunds');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [canView, debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep link from the Payments page: /dashboard/refunds?payment=<id> opens the refund dialog.
  const deepLinkId = searchParams.get('payment');
  useEffect(() => {
    if (!deepLinkId || !canView) return;
    let cancelled = false;
    fetchRefundablePayments({ paymentId: deepLinkId })
      .then((rows) => {
        if (cancelled) return;
        if (!canIssue) toast('You need refund permission to issue refunds.', 'error');
        else if (rows[0] && rows[0].refundable_cents > 0) setTarget(rows[0]);
        else toast('That payment has nothing left to refund.', 'error');
      })
      .catch(() => {
        if (!cancelled) toast('Could not open that payment', 'error');
      })
      .finally(() => {
        if (cancelled) return;
        const next = new URLSearchParams(searchParams);
        next.delete('payment');
        setSearchParams(next, { replace: true });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkId, canView, canIssue]);

  const stats = useMemo(() => summarizeRefunds(refunds), [refunds]);

  async function handleResume(r: Refund) {
    setResumingId(r.id);
    try {
      const outcome = await resumeRefund(r.id);
      if (outcome.warning) toast(outcome.message ?? 'Still needs attention — try again shortly.', 'error');
      else toast('Refund updated', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not resume this refund', 'error');
    } finally {
      setResumingId(null);
    }
  }

  if (!canView) {
    return (
      <DashboardLayout activeLabel="Refunds">
        <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
          <EmptyState icon={ShieldAlert} title="Refunds are restricted" description="Ask the account owner for billing access to view refunds." />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Refunds">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Undo2 className="h-6 w-6" /> Refunds
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Issue full or partial refunds. Each one creates a credit memo, a ledger entry, and an audit record.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={refreshing || loading}>
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>

        {!canIssue && (
          <p className="flex items-center gap-2 rounded-lg border border-warning-500/25 bg-warning-500/10 px-3 py-2 text-sm text-warning-500">
            <AlertTriangle className="h-4 w-4 shrink-0" /> You can view refunds, but issuing them needs the “Issue refunds” permission.
          </p>
        )}

        {loading ? (
          <>
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={4} rows={2} />
          </>
        ) : error ? (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm text-danger">
                <AlertTriangle className="h-4 w-4" /> {error}
              </p>
              <Button variant="secondary" size="sm" onClick={() => void load()}>Try again</Button>
            </div>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Card className="!p-4"><p className="text-xs text-text-secondary">Refunded (30 days)</p><p className="mt-1 text-xl font-bold text-text-primary">{formatMoney(stats.refundedCents)}</p></Card>
              <Card className="!p-4"><p className="text-xs text-text-secondary">Refunds (30 days)</p><p className="mt-1 text-xl font-bold text-text-primary">{stats.count}</p></Card>
              <Card className="!p-4"><p className="text-xs text-text-secondary">Processing</p><p className="mt-1 text-xl font-bold text-text-primary">{stats.processing}</p></Card>
              <Card className="!p-4"><p className="text-xs text-text-secondary">Needs attention</p><p className={`mt-1 text-xl font-bold ${stats.attention ? 'text-danger' : 'text-text-primary'}`}>{stats.attention}</p></Card>
            </div>

            <div role="tablist" aria-label="Refund views" className="flex gap-1 border-b border-border">
              {(['payments', 'history'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`focus-ring -mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                    tab === t ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {t === 'payments' ? 'Refundable payments' : `History (${refunds.length})`}
                </button>
              ))}
            </div>

            {tab === 'payments' && (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by customer name or email"
                    aria-label="Search payments"
                    className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-2.5 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-secondary/60 focus-visible:border-accent"
                  />
                </div>

                {payments.length === 0 ? (
                  debounced ? (
                    <EmptyState icon={Search} title="No matching payments" description="Try a different name or email." />
                  ) : (
                    <EmptyState
                      icon={CreditCard}
                      title="No refundable payments yet"
                      description="Payments collected through Stripe payment links show up here once they are paid."
                      action={{ label: 'Go to Payments', onClick: () => navigate('/dashboard/payments') }}
                    />
                  )
                ) : (
                  <Card className="!p-0 overflow-hidden">
                    <ul className="divide-y divide-border">
                      {payments.map((p) => {
                        const state = refundStateOf(p);
                        return (
                          <li key={p.payment_request_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
                            <div className="min-w-0">
                              <p className="truncate font-medium text-text-primary">{p.customer_name}</p>
                              <p className="text-sm text-text-secondary">
                                {formatMoney(p.amount_cents, p.currency)}
                                {p.paid_at && ` · paid ${new Date(p.paid_at).toLocaleDateString()}`}
                                {p.refunded_cents > 0 && ` · ${formatMoney(p.refunded_cents, p.currency)} refunded`}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {state === 'partial' && <Badge tone="warning">Partially refunded</Badge>}
                              {state === 'full' && <Badge tone="neutral">Fully refunded</Badge>}
                              {p.in_flight_count > 0 && <Badge tone="accent">Processing</Badge>}
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={!canIssue || p.refundable_cents <= 0}
                                title={!canIssue ? 'You need the “Issue refunds” permission' : p.refundable_cents <= 0 ? 'Nothing left to refund' : undefined}
                                onClick={() => setTarget(p)}
                              >
                                <Undo2 className="h-3.5 w-3.5" /> Refund
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </Card>
                )}
              </>
            )}

            {tab === 'history' &&
              (refunds.length === 0 ? (
                <EmptyState icon={Undo2} title="No refunds yet" description="Refunds you issue will appear here with their credit memo and ledger status." />
              ) : (
                <Card className="!p-0 overflow-hidden">
                  <ul className="divide-y divide-border">
                    {refunds.map((r) => {
                      const meta = REFUND_STATUS_META[r.status];
                      const notice = noticeBadge(r);
                      const ledger = ledgerBadge(r);
                      const attention = needsAttention(r);
                      return (
                        <li key={r.id} className="space-y-2 px-4 py-4 sm:px-6">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate font-medium text-text-primary">
                                {r.customer_name} · {formatMoney(r.amount_cents, r.currency)}
                              </p>
                              <p className="text-sm text-text-secondary">
                                {REASON_META[r.reason_code]?.label ?? r.reason_code} · {new Date(r.created_at).toLocaleString()}
                                {r.credit_memo_number && ` · ${r.credit_memo_number}`}
                                {r.created_by_email && ` · by ${r.created_by_email}`}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge tone={meta.tone}>{meta.label}</Badge>
                              {attention && canIssue && (
                                <Button variant="secondary" size="sm" disabled={resumingId === r.id} onClick={() => void handleResume(r)}>
                                  {resumingId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                  Resume
                                </Button>
                              )}
                            </div>
                          </div>
                          {r.reason_note && <p className="text-sm text-text-secondary">“{r.reason_note}”</p>}
                          {r.status === 'failed' && r.failure_reason && <p className="text-sm text-danger">{r.failure_reason}</p>}
                          {r.accounting_status === 'failed' && r.accounting_error && <p className="text-sm text-danger">{r.accounting_error}</p>}
                          {r.status !== 'failed' && r.status !== 'canceled' && (
                            <div className="flex flex-wrap gap-2">
                              {ledger && <Badge tone={ledger.tone}>{ledger.label}</Badge>}
                              <Badge tone={notice.tone}>{notice.label}</Badge>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              ))}
          </>
        )}
      </div>

      {target && (
        <RefundDialog
          payment={target}
          onClose={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            setTab('history');
            void load();
          }}
        />
      )}
    </DashboardLayout>
  );
}
