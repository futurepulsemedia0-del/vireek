/**
 * Payment Plans — /dashboard/payment-plans
 * Deposits + installments with automated reminders, late fees and Stripe auto-charge.
 * Charging/reminders run server-side (payment-plan-runner); this page is the control room.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarClock, Landmark, Lock, Plus, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { CreatePlanDialog } from '@/components/paymentPlans/CreatePlanDialog';
import { PlanDetailPanel } from '@/components/paymentPlans/PlanDetailPanel';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { fetchConnectStatus, type StripeConnectStatus } from '@/lib/payments';
import {
  FREQUENCY_LABEL, PLAN_STATUS_META, TONE_CLASS, dueLabel, filterPlans, formatMoney, matchesPlanTab, planHasOverdue, planProgress,
  type PlanRow, type PlanStats, type PlanTab,
} from '@/lib/paymentPlans';
import { fetchPlanStats, fetchPlans } from '@/lib/paymentPlansApi';

const TABS: { key: PlanTab; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'approval', label: 'Awaiting approval' }, { key: 'active', label: 'Active' },
  { key: 'overdue', label: 'Overdue' }, { key: 'completed', label: 'Completed' }, { key: 'canceled', label: 'Canceled' },
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

function PlanStatus({ plan }: { plan: PlanRow }) {
  const overdue = (plan.status === 'active') && planHasOverdue(plan.payment_plan_installments ?? []);
  const m = overdue ? { label: 'Overdue', tone: 'danger' as const } : PLAN_STATUS_META[plan.status];
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[m.tone]}`}>{m.label}</span>;
}

function Progress({ plan }: { plan: PlanRow }) {
  const p = planProgress(plan.payment_plan_installments ?? []);
  return (
    <div className="min-w-[110px]">
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-label="Paid" aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-success" style={{ width: `${p.pct}%` }} /></div>
      <p className="mt-1 text-[11px] text-text-secondary">{formatMoney(p.paidCents, plan.currency)} / {formatMoney(p.totalCents, plan.currency)}</p>
    </div>
  );
}

function NextDue({ plan }: { plan: PlanRow }) {
  const next = planProgress(plan.payment_plan_installments ?? []).next;
  if (!next || plan.status === 'canceled' || plan.status === 'completed') return <span className="text-text-secondary">—</span>;
  const d = dueLabel(next);
  return <span className={`text-xs font-semibold ${d.tone === 'danger' ? 'text-danger' : d.tone === 'warning' ? 'text-warning-500' : 'text-text-secondary'}`}>{d.label}</span>;
}

export function PaymentPlansPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, isOwner, teamMember, permissions } = useAuth();
  const [params, setParams] = useSearchParams();

  const canAccess = isOwner || permissions.can_view_billing;
  const ownerId = isOwner ? user?.id : teamMember?.account_owner_id; // accountOwnerId scoping

  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [stats, setStats] = useState<PlanStats | null>(null);
  const [connect, setConnect] = useState<StripeConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<PlanTab>('all');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (background = false) => {
    if (!ownerId || !canAccess) return;
    if (background) setRefreshing(true); else { setLoading(true); setFailed(false); }
    try {
      const [p, s, c] = await Promise.all([fetchPlans(ownerId), fetchPlanStats(), fetchConnectStatus().catch(() => null)]);
      setPlans(p); setStats(s); setConnect(c);
    } catch {
      if (background) toast('Could not refresh payment plans.', 'error'); else setFailed(true);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [ownerId, canAccess, toast]);

  useEffect(() => { void load(); }, [load]);

  // Payments land off-page (webhooks, cron) — refresh quietly when the tab regains focus.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void load(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const selectedId = params.get('p');
  const selected = useMemo(() => plans.find((p) => p.id === selectedId) ?? null, [plans, selectedId]);
  const visible = useMemo(() => filterPlans(plans, tab, query), [plans, tab, query]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, plans.filter((p) => matchesPlanTab(p, t.key)).length])) as Record<PlanTab, number>, [plans]);

  const open = (id: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('p', id); return n; });
  const close = () => setParams((p) => { const n = new URLSearchParams(p); n.delete('p'); return n; }, { replace: true });
  const stripeReady = !!connect?.stripe_account_id && connect.charges_enabled;

  return (
    <DashboardLayout activeLabel="Payment Plans">
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-text-primary"><CalendarClock className="h-6 w-6 text-accent" /> Payment plans</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">Let customers pay big jobs in installments. We collect the deposit, remind them, add late fees you define, and auto-charge their card on each due date.</p>
          </div>
          {canAccess && !loading && !failed && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh payment plans"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /></Button>
              <Button size="sm" onClick={() => setCreating(true)} disabled={!stripeReady}><Plus className="h-4 w-4" /> New plan</Button>
            </div>
          )}
        </header>

        {!canAccess ? (
          <EmptyState icon={Lock} title="You don't have access to payment plans" description="Payment plans contain billing information. Ask the account owner to grant you billing access." />
        ) : !ownerId || loading ? (
          <div className="space-y-4" aria-busy="true" aria-label="Loading payment plans"><SkeletonStatGrid count={4} /><SkeletonCardList count={3} rows={2} /></div>
        ) : failed ? (
          <EmptyStateError title="Could not load payment plans" onRetry={() => void load()} />
        ) : !stripeReady && plans.length === 0 ? (
          <EmptyState icon={Landmark} title="Connect Stripe to offer payment plans" description="Plans are collected through your Stripe account. Connect and verify it first." action={{ label: 'Go to Payments', onClick: () => navigate('/dashboard/payments') }} />
        ) : plans.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No payment plans yet" description="Offer a deposit plus installments on your next big job — customers approve once and we handle the rest." action={{ label: 'Create your first plan', onClick: () => setCreating(true) }} />
        ) : (
          <>
            {!stripeReady && <p role="status" className="rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-warning-500">Your Stripe account isn't fully verified, so new plans can't be sent and existing charges will fail. <button type="button" onClick={() => navigate('/dashboard/payments')} className="focus-ring rounded font-semibold underline">Finish setup</button></p>}
            {stats && (stats.failed_charges > 0 || stats.overdue_count > 0) && (
              <div role="alert" className="flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
                <p>{stats.overdue_count > 0 && <><strong>{stats.overdue_count} installment{stats.overdue_count === 1 ? '' : 's'}</strong> overdue ({formatMoney(stats.overdue_cents)}). </>}{stats.failed_charges > 0 && <><strong>{stats.failed_charges}</strong> failed all auto-charge attempts — contact the customer or record an offline payment. </>}Open the “Overdue” tab.</p>
              </div>
            )}
            {stats && (
              <section aria-label="Payment plan statistics" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Kpi label="Outstanding" value={formatMoney(stats.outstanding_cents)} hint={`${stats.active_plans} active plan${stats.active_plans === 1 ? '' : 's'}`} />
                <Kpi label="Due next 7 days" value={formatMoney(stats.due_7d_cents)} tone={stats.due_7d_cents > 0 ? 'warning' : undefined} />
                <Kpi label="Collected (30d)" value={formatMoney(stats.collected_30d_cents)} tone="success" />
                <Kpi label="Overdue" value={formatMoney(stats.overdue_cents)} hint={stats.late_fees_assessed_cents > 0 ? `${formatMoney(stats.late_fees_assessed_cents)} in late fees` : `${stats.awaiting_approval} awaiting approval`} tone={stats.overdue_cents > 0 ? 'danger' : undefined} />
              </section>
            )}

            <section aria-label="Plans" className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div role="tablist" aria-label="Filter plans" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
                  {TABS.map((t) => (
                    <button key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)}
                      className={`focus-ring whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${tab === t.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:bg-bg-tertiary'}`}>
                      {t.label} <span className="opacity-60">{counts[t.key]}</span>
                    </button>
                  ))}
                </div>
                <label className="relative block sm:w-64">
                  <span className="sr-only">Search plans</span>
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                  <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customer"
                    className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary/60 focus-visible:border-accent" />
                </label>
              </div>

              {visible.length === 0 ? (
                <EmptyState icon={Search} title="No plans match" description="Try a different tab or clear the search." action={{ label: 'Clear filters', onClick: () => { setTab('all'); setQuery(''); } }} />
              ) : (
                <>
                  <div className="hidden overflow-hidden rounded-2xl border border-border md:block">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-bg-secondary text-[11px] uppercase text-text-secondary">
                        <tr><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Progress</th><th className="px-4 py-3">Next payment</th><th className="px-4 py-3">Status</th></tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {visible.map((p) => (
                          <tr key={p.id} className="cursor-pointer bg-bg-primary transition-colors hover:bg-bg-secondary" onClick={() => open(p.id)}>
                            <td className="px-4 py-3"><button type="button" onClick={(e) => { e.stopPropagation(); open(p.id); }} className="focus-ring rounded text-left font-medium text-text-primary hover:underline">{p.customer_name}</button></td>
                            <td className="px-4 py-3 text-text-secondary">{formatMoney(p.total_cents, p.currency)} · {p.installment_count}× {FREQUENCY_LABEL[p.frequency].toLowerCase()}</td>
                            <td className="px-4 py-3"><Progress plan={p} /></td>
                            <td className="px-4 py-3"><NextDue plan={p} /></td>
                            <td className="px-4 py-3"><PlanStatus plan={p} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <ul className="space-y-2 md:hidden">
                    {visible.map((p) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => open(p.id)} className="focus-ring w-full rounded-2xl border border-border bg-bg-secondary p-4 text-left">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0"><p className="truncate font-medium text-text-primary">{p.customer_name}</p><p className="text-xs text-text-secondary">{formatMoney(p.total_cents, p.currency)} · {p.installment_count}× {FREQUENCY_LABEL[p.frequency].toLowerCase()}</p></div>
                            <PlanStatus plan={p} />
                          </div>
                          <div className="mt-3 flex items-end justify-between gap-3"><Progress plan={p} /><NextDue plan={p} /></div>
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

      {canAccess && ownerId && creating && (
        <CreatePlanDialog ownerId={ownerId} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); void load(true).then(() => open(id)); }} />
      )}
      {canAccess && ownerId && selectedId && (
        selected ? (
          <PlanDetailPanel key={selected.id} plan={selected} ownerId={ownerId} onClose={close} onChanged={() => void load(true)} />
        ) : !loading ? (
          <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary shadow-xl" role="status">
            That plan could not be found. <button type="button" onClick={close} className="focus-ring ml-1 rounded font-semibold text-accent">Dismiss</button>
          </div>
        ) : null
      )}
    </DashboardLayout>
  );
}
