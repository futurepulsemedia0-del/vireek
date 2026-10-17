/**
 * Disputes — /dashboard/disputes
 * Stripe chargebacks for the account: deadlines, evidence builder, win/loss statistics.
 * Data arrives via the stripe-dispute-webhook edge function (charge.dispute.*).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Landmark, Lock, RefreshCw, Search, ShieldAlert, Trophy } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonCardList } from '@/components/Skeleton';
import { DisputeDetailPanel, TONE_CLASS } from '@/components/disputes/DisputeDetailPanel';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { fetchConnectStatus, type StripeConnectStatus } from '@/lib/payments';
import {
  deadlineState,
  filterDisputes,
  formatMoney,
  formatPct,
  isNeedsResponse,
  reasonMeta,
  statusMeta,
  type DisputeStats,
  type DisputeTab,
  type StripeDisputeRow,
} from '@/lib/disputes';
import { fetchDisputeStats, fetchDisputes } from '@/lib/disputesApi';

const TABS: { key: DisputeTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'action', label: 'Needs response' },
  { key: 'review', label: 'Under review' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
];

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'danger' | 'success' | 'warning' }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning-500' : 'text-text-primary';
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function MonthlyBars({ stats }: { stats: DisputeStats }) {
  const max = Math.max(...stats.monthly.map((m) => m.opened), 1);
  return (
    <div role="img" aria-label="Disputes opened per month, last 12 months" className="flex h-24 items-end gap-1.5">
      {stats.monthly.map((m) => (
        <div key={m.month} className="flex flex-1 flex-col items-center gap-1" title={`${m.month}: ${m.opened} opened, ${m.won} won, ${m.lost} lost`}>
          <div className="w-full rounded-t bg-accent/70" style={{ height: `${Math.max((m.opened / max) * 72, m.opened ? 4 : 1)}px`, opacity: m.opened ? 1 : 0.25 }} />
          <span className="text-[9px] text-text-secondary">{m.month.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const m = statusMeta(status);
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[m.tone]}`}>{m.label}</span>;
}

function DeadlineCell({ row }: { row: StripeDisputeRow }) {
  if (!isNeedsResponse(row.status)) return <span className="text-text-secondary">—</span>;
  const d = deadlineState(row.evidence_due_by);
  return <span className={`text-xs font-semibold ${d.tone === 'danger' ? 'text-danger' : d.tone === 'warning' ? 'text-warning-500' : 'text-text-secondary'}`}>{d.label}</span>;
}

export function DisputesPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, isOwner, teamMember, permissions } = useAuth();
  const [params, setParams] = useSearchParams();

  const canAccess = isOwner || permissions.can_view_billing;
  const ownerId = isOwner ? user?.id : teamMember?.account_owner_id; // accountOwnerId scoping

  const [rows, setRows] = useState<StripeDisputeRow[]>([]);
  const [stats, setStats] = useState<DisputeStats | null>(null);
  const [connect, setConnect] = useState<StripeConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<DisputeTab>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async (background = false) => {
    if (!ownerId || !canAccess) return;
    if (background) setRefreshing(true); else { setLoading(true); setFailed(false); }
    try {
      const [r, s, c] = await Promise.all([fetchDisputes(ownerId), fetchDisputeStats(365), fetchConnectStatus().catch(() => null)]);
      setRows(r); setStats(s); setConnect(c);
    } catch {
      if (background) toast('Could not refresh disputes.', 'error'); else setFailed(true);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [ownerId, canAccess, toast]);

  useEffect(() => { void load(); }, [load]);

  // Disputes change off-page (webhooks) — refresh quietly when the tab regains focus.
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') void load(true); };
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [load]);

  const selectedId = params.get('d');
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);
  const visible = useMemo(() => filterDisputes(rows, tab, query), [rows, tab, query]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, filterDisputes(rows, t.key, '').length])) as Record<DisputeTab, number>, [rows]);

  const open = (id: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('d', id); return n; }, { replace: false });
  const close = () => setParams((p) => { const n = new URLSearchParams(p); n.delete('d'); return n; }, { replace: true });

  const urgent = stats ? stats.overdue + stats.due_soon : 0;

  return (
    <DashboardLayout activeLabel="Disputes">
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-text-primary"><ShieldAlert className="h-6 w-6 text-accent" /> Disputes</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">Customer chargebacks from Stripe. Respond before the deadline — an unanswered dispute is lost automatically.</p>
          </div>
          {canAccess && !loading && !failed && (
            <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh disputes">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          )}
        </header>

        {!canAccess ? (
          <EmptyState icon={Lock} title="You don't have access to disputes" description="Disputes contain billing information. Ask the account owner to grant you billing access." />
        ) : !ownerId || loading ? (
          <div className="space-y-4" aria-busy="true" aria-label="Loading disputes"><SkeletonStatGrid count={4} /><SkeletonCardList count={3} rows={2} /></div>
        ) : failed ? (
          <EmptyStateError title="Could not load disputes" onRetry={() => void load()} />
        ) : rows.length === 0 ? (
          connect?.stripe_account_id ? (
            <EmptyState icon={Trophy} title="No disputes — keep it that way" description="When a customer disputes a payment, it appears here within seconds with its deadline and an evidence builder. We'll also notify you." />
          ) : (
            <EmptyState icon={Landmark} title="Connect Stripe to track disputes" description="Disputes are tracked for payments collected through Vireek. Connect your Stripe account to start collecting payments."
              action={{ label: 'Go to Payments', onClick: () => navigate('/dashboard/payments') }} />
          )
        ) : (
          <>
            {stats && urgent > 0 && (
              <div role="alert" className="flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
                <p><strong>{urgent} dispute{urgent === 1 ? '' : 's'}</strong> {stats.overdue > 0 ? `${stats.overdue} past the deadline and ` : ''}{stats.due_soon > 0 ? `${stats.due_soon} due within 72 hours.` : ''} Open {urgent === 1 ? 'it' : 'them'} from the “Needs response” tab.</p>
              </div>
            )}

            {stats && (
              <section aria-label="Dispute statistics" className="space-y-4">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Kpi label="Needs response" value={String(stats.needs_response)} hint={`${formatMoney(stats.at_stake_cents)} at stake`} tone={stats.needs_response > 0 ? 'danger' : undefined} />
                  <Kpi label="Win rate" value={formatPct(stats.win_rate)} hint={stats.won + stats.lost === 0 ? 'No closed disputes yet' : `${stats.won} won · ${stats.lost} lost`} tone={stats.win_rate !== null && stats.win_rate >= 50 ? 'success' : undefined} />
                  <Kpi label="Recovered" value={formatMoney(stats.won_cents)} hint={`${formatMoney(stats.lost_cents)} lost`} tone="success" />
                  <Kpi label="Dispute rate" value={stats.dispute_rate_pct === null ? '—' : `${stats.dispute_rate_pct}%`} hint={`of ${stats.paid_payments} paid payments, last ${stats.window_days}d`} />
                </div>
                {stats.lost_unanswered > 0 && (
                  <p className="rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-xs text-warning-500">
                    {stats.lost_unanswered} dispute{stats.lost_unanswered === 1 ? ' was' : 's were'} lost without any evidence submitted. Responding to every dispute is the single biggest lever on your win rate.
                  </p>
                )}
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-2xl border border-border bg-bg-secondary p-4">
                    <h2 className="mb-3 text-sm font-semibold text-text-primary">Opened per month</h2>
                    <MonthlyBars stats={stats} />
                  </div>
                  <div className="rounded-2xl border border-border bg-bg-secondary p-4">
                    <h2 className="mb-3 text-sm font-semibold text-text-primary">By reason</h2>
                    {stats.by_reason.length === 0 ? <p className="text-xs text-text-secondary">No disputes in this period.</p> : (
                      <ul className="space-y-2">
                        {stats.by_reason.slice(0, 5).map((r) => (
                          <li key={r.reason} className="flex items-center justify-between gap-3 text-xs">
                            <span className="truncate text-text-primary">{reasonMeta(r.reason).label}</span>
                            <span className="shrink-0 text-text-secondary">{r.total} · win rate <strong className="text-text-primary">{formatPct(r.win_rate)}</strong></span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </section>
            )}

            <section aria-label="Disputes" className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div role="tablist" aria-label="Filter disputes" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
                  {TABS.map((t) => (
                    <button key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)}
                      className={`focus-ring whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${tab === t.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:bg-bg-tertiary'}`}>
                      {t.label} <span className="opacity-60">{counts[t.key]}</span>
                    </button>
                  ))}
                </div>
                <label className="relative block sm:w-64">
                  <span className="sr-only">Search disputes</span>
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                  <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customer or ID"
                    className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary/60 focus-visible:border-accent" />
                </label>
              </div>

              {visible.length === 0 ? (
                <EmptyState icon={Search} title="No disputes match" description="Try a different tab or clear the search." action={{ label: 'Clear filters', onClick: () => { setTab('all'); setQuery(''); } }} />
              ) : (
                <>
                  {/* Desktop table */}
                  <div className="hidden overflow-hidden rounded-2xl border border-border md:block">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-bg-secondary text-[11px] uppercase text-text-secondary">
                        <tr><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Reason</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Deadline</th><th className="px-4 py-3">Opened</th></tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {visible.map((r) => (
                          <tr key={r.id} className="cursor-pointer bg-bg-primary transition-colors hover:bg-bg-secondary" onClick={() => open(r.id)}>
                            <td className="px-4 py-3">
                              <button type="button" onClick={(e) => { e.stopPropagation(); open(r.id); }} className="focus-ring rounded text-left font-medium text-text-primary hover:underline">{r.customer_name ?? 'Unknown customer'}</button>
                            </td>
                            <td className="px-4 py-3 text-text-secondary">{reasonMeta(r.reason).label}</td>
                            <td className="px-4 py-3 text-right font-medium text-text-primary">{formatMoney(r.amount_cents, r.currency)}</td>
                            <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                            <td className="px-4 py-3"><DeadlineCell row={r} /></td>
                            <td className="px-4 py-3 text-xs text-text-secondary">{new Date(r.opened_at).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {/* Mobile cards */}
                  <ul className="space-y-2 md:hidden">
                    {visible.map((r) => (
                      <li key={r.id}>
                        <button type="button" onClick={() => open(r.id)} className="focus-ring w-full rounded-2xl border border-border bg-bg-secondary p-4 text-left">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate font-medium text-text-primary">{r.customer_name ?? 'Unknown customer'}</p>
                              <p className="text-xs text-text-secondary">{reasonMeta(r.reason).label} · {new Date(r.opened_at).toLocaleDateString()}</p>
                            </div>
                            <p className="shrink-0 font-semibold text-text-primary">{formatMoney(r.amount_cents, r.currency)}</p>
                          </div>
                          <div className="mt-2 flex items-center justify-between"><StatusPill status={r.status} /><DeadlineCell row={r} /></div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </>
        )}
      </div>

      {canAccess && ownerId && selectedId && (
        selected ? (
          <DisputeDetailPanel key={selected.id} dispute={selected} ownerId={ownerId} onClose={close} onChanged={() => void load(true)} />
        ) : !loading ? (
          <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary shadow-xl" role="status">
            That dispute could not be found. <button type="button" onClick={close} className="focus-ring ml-1 rounded font-semibold text-accent">Dismiss</button>
          </div>
        ) : null
      )}
    </DashboardLayout>
  );
}
