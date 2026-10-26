/**
 * Acquisition Integration Toolkit — portfolio view at /dashboard/acquisitions.
 *
 * One consolidated screen for operators and PE roll-ups: every acquired business with its integration health, margin,
 * utilization, retention risk and synergy delivery next to the parent business. Pure logic: lib/acquisitions.ts.
 * Persistence + permissions: lib/acquisitionsApi.ts and supabase/migrations/20271115000000_acquisition_integration_toolkit.sql.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, Lock, Plus } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { InlineError, Pill, ProgressBar, Stat, panelCls, useAcquisitionsScope, type Tone } from '@/components/acquisitions/acquisitionUi';
import { NewAcquisitionDialog } from '@/components/acquisitions/NewAcquisitionDialog';
import { describeAcquisitionError, fetchLinkOptions, fetchPortfolio, type LinkOptions } from '@/lib/acquisitionsApi';
import {
  SCOPE_LABELS, STATUS_LABELS, currentPhase, dayNumber, formatCents, formatPct, integrationHealth, portfolioTotals, retentionRisk, todayIso,
  type Health, type Portfolio, type Risk,
} from '@/lib/acquisitions';

const HEALTH: Record<Health, { tone: Tone; label: string }> = {
  on_track: { tone: 'good', label: 'On track' }, watch: { tone: 'warn', label: 'Watch' }, at_risk: { tone: 'bad', label: 'At risk' }, not_started: { tone: 'neutral', label: 'No plan' },
};
const RISK: Record<Risk, { tone: Tone; label: string }> = {
  high: { tone: 'bad', label: 'High retention risk' }, medium: { tone: 'warn', label: 'Medium retention risk' }, low: { tone: 'good', label: 'Low retention risk' }, unknown: { tone: 'neutral', label: 'Retention n/a' },
};
const PHASE_NOW: Record<string, string> = { pre: 'Pre-close', day_30: 'Days 0–30', day_60: 'Days 31–60', day_90: 'Days 61–90', post: 'Post-90' };

export function AcquisitionsPage() {
  const { loading: authLoading, profileLoading } = useAuth();
  const { accountOwnerId, canManage } = useAcquisitionsScope();
  const { toast } = useToast();
  const navigate = useNavigate();
  const today = useMemo(() => todayIso(), []);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [options, setOptions] = useState<LinkOptions | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!accountOwnerId || !canManage) return;
    setStatus('loading'); setError(null);
    try {
      const [p, o] = await Promise.all([fetchPortfolio(), fetchLinkOptions(accountOwnerId).catch(() => null)]);
      if (!alive.current) return;
      setPortfolio(p); setOptions(o); setStatus('ready');
    } catch (e) {
      if (!alive.current) return;
      setError(describeAcquisitionError(e)); setStatus('error');
    }
  }, [accountOwnerId, canManage]);

  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);

  if (authLoading || profileLoading) {
    return <DashboardLayout activeLabel="Acquisitions"><div className="mx-auto max-w-6xl" aria-busy="true"><SkeletonCardList count={3} /></div></DashboardLayout>;
  }
  if (!canManage || !accountOwnerId) {
    return (
      <DashboardLayout activeLabel="Acquisitions">
        <div className="mx-auto max-w-3xl">
          <EmptyState icon={Lock} title="You don't have access to Acquisitions" description="Acquisition plans include purchase prices and margins. Ask your account owner for the “edit business profile” permission." />
        </div>
      </DashboardLayout>
    );
  }

  const rows = portfolio?.companies ?? [];
  const totals = portfolioTotals(rows);
  const currency = rows.length > 0 && rows.every((r) => r.currency === rows[0].currency) ? rows[0].currency : 'USD';
  const planned = totals.costPlan + totals.revPlan;
  const delivered = totals.costActual + totals.revActual;
  const parent = portfolio?.parent ?? null;

  return (
    <DashboardLayout activeLabel="Acquisitions">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Building2 size={22} className="text-accent" aria-hidden="true" /> Acquisitions</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Integrate every business you buy: a 30/60/90-day plan, a day-one baseline, automated reconciliation against the seller’s numbers, and synergies tracked against plan.
            </p>
          </div>
          <Button onClick={() => setDialog(true)}><Plus size={16} aria-hidden="true" /> New acquisition</Button>
        </header>

        {status === 'error' && <InlineError message={error ?? 'Could not load acquisitions.'} onRetry={() => void load()} />}
        {status === 'loading' && <div aria-busy="true"><SkeletonCardList count={3} rows={3} /></div>}

        {status === 'ready' && rows.length === 0 && (
          <EmptyState icon={Building2} title="No acquisitions yet" description="Add your first acquired business to get a ready-made integration plan with owners, dependencies and due dates."
            action={{ label: 'New acquisition', onClick: () => setDialog(true) }} />
        )}

        {status === 'ready' && rows.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="Companies" value={String(totals.companies)} sub={`${totals.active} integrating`} />
              <Stat label="Revenue, 90 days" value={formatCents(totals.revenue, currency)} sub="Acquired companies" />
              <Stat label="Gross margin" value={formatPct(totals.margin)} sub={parent?.gross_margin_pct != null ? `Your business ${parent.gross_margin_pct}%` : 'Revenue-weighted'} />
              <Stat label="Utilization" value={formatPct(totals.utilization)} sub={parent?.utilization_pct != null ? `Your business ${parent.utilization_pct}%` : 'Average'} />
              <Stat label="Retention at risk" value={totals.retentionAtRisk.toLocaleString('en-US')} sub="customers" tone={totals.retentionAtRisk > 0 ? 'bad' : undefined} />
            </div>
            <div className={panelCls}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-text-primary">Synergies delivered vs plan to date</p>
                <p className="text-sm tabular-nums text-text-secondary">{formatCents(delivered, currency)} of {formatCents(planned, currency)}</p>
              </div>
              <div className="mt-2"><ProgressBar pct={planned > 0 ? (delivered / planned) * 100 : 0} label="Synergies delivered" /></div>
            </div>

            <ul className="space-y-3">
              {rows.map((r) => {
                const day = dayNumber(r.close_date, today);
                const health = HEALTH[integrationHealth(r)];
                const risk = RISK[retentionRisk(r.kpis?.retention_pct, parent?.retention_pct)];
                const pct = r.ws_total > 0 ? Math.round((r.ws_done / r.ws_total) * 100) : 0;
                const syPlan = r.cost_plan_cents + r.rev_plan_cents;
                const syAct = r.cost_actual_cents + r.rev_actual_cents;
                return (
                  <li key={r.id} className={panelCls}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link to={`/dashboard/acquisitions/${r.id}`} className="focus-ring rounded text-lg font-semibold text-text-primary hover:text-accent">{r.name}</Link>
                        <p className="text-xs text-text-secondary">
                          {day >= 0 ? `Day ${day}` : `Closes in ${-day} days`} · {PHASE_NOW[currentPhase(day)]} · {SCOPE_LABELS[r.scope_kind]}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Pill>{STATUS_LABELS[r.status]}</Pill>
                        <Pill tone={health.tone}>{health.label}</Pill>
                        {r.ws_overdue > 0 && <Pill tone="bad">{r.ws_overdue} overdue</Pill>}
                        {r.ws_blocked > 0 && <Pill tone="warn">{r.ws_blocked} blocked</Pill>}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-4 md:grid-cols-[1.2fr_2fr]">
                      <div>
                        <p className="mb-1 text-xs text-text-secondary">{r.ws_done} of {r.ws_total} workstreams done</p>
                        <ProgressBar pct={pct} label={`${r.name} integration progress`} />
                      </div>
                      {r.has_live_data && r.kpis && (r.kpis.jobs_count ?? 0) > 0 ? (
                        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                          <div><dt className="text-xs text-text-secondary">Revenue</dt><dd className="font-semibold tabular-nums text-text-primary">{formatCents(r.kpis.revenue_cents, r.currency)}</dd></div>
                          <div><dt className="text-xs text-text-secondary">Margin</dt><dd className="font-semibold tabular-nums text-text-primary">{formatPct(r.kpis.gross_margin_pct)}</dd></div>
                          <div><dt className="text-xs text-text-secondary">Utilization</dt><dd className="font-semibold tabular-nums text-text-primary">{formatPct(r.kpis.utilization_pct)}</dd></div>
                          <div><dt className="text-xs text-text-secondary">Retention</dt><dd className="font-semibold tabular-nums text-text-primary">{formatPct(r.kpis.retention_pct)}</dd></div>
                        </dl>
                      ) : (
                        <p className="text-sm text-text-secondary">No live numbers yet — link an import run or a franchise account on the acquisition page.</p>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                      <Pill tone={risk.tone}>{risk.label}</Pill>
                      {(r.kpis?.retention_at_risk ?? 0) > 0 && <span>{r.kpis?.retention_at_risk} customers not seen in 90 days</span>}
                      {syPlan > 0 && <span>· Synergies {formatCents(syAct, r.currency)} of {formatCents(syPlan, r.currency)}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <NewAcquisitionDialog
        open={dialog}
        options={options}
        onClose={() => setDialog(false)}
        onCreated={(id) => { setDialog(false); toast('Integration plan created.', 'success'); navigate(`/dashboard/acquisitions/${id}`); }}
      />
    </DashboardLayout>
  );
}
