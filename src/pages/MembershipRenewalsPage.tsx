import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CreditCard, Link2, RotateCcw } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import {
  PIPELINE_STAGES,
  autoChargeCoverage,
  daysLeftLabel,
  fetchOpenRenewalCycles,
  fetchRenewalKpis,
  formatRate,
  formatUsd,
  groupPipeline,
  renewalLink,
  renewalRisk,
  type RenewalCycle,
  type RenewalKpis,
} from '@/lib/membershipRenewal';

const RISK_STYLES = { ok: 'text-success-500', watch: 'text-warning-500', risk: 'text-danger' } as const;

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

function CycleCard({ cycle, onCopy, onStop }: { cycle: RenewalCycle; onCopy: (c: RenewalCycle) => void; onStop: (c: RenewalCycle) => void }) {
  const m = cycle.memberships;
  const risk = renewalRisk(cycle);
  const priceUp = cycle.amount_cents > cycle.previous_amount_cents;
  return (
    <li className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{m?.customer_name ?? 'Member'}</p>
          <p className="truncate text-xs text-text-secondary">{cycle.membership_plans?.name ?? 'Plan'}</p>
        </div>
        <p className="shrink-0 text-sm font-semibold text-text-primary">{formatUsd(cycle.amount_cents)}</p>
      </div>
      {priceUp && <p className="mt-1 text-xs text-warning-500">Price up from {formatUsd(cycle.previous_amount_cents)}</p>}
      <p className="mt-1 text-xs text-text-secondary">
        Renews {daysLeftLabel(cycle.period_end)} · {new Date(cycle.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </p>
      <p className={`mt-1 flex items-center gap-1 text-xs font-medium ${RISK_STYLES[risk.level]}`}>
        {risk.level === 'ok' ? <CreditCard size={12} /> : <AlertTriangle size={12} />}
        <span className="truncate">{risk.reason}</span>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => onCopy(cycle)} className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary">
          <Link2 size={12} /> Copy renewal link
        </button>
        {m?.auto_renew !== false && cycle.stage !== 'past_due' && (
          <button type="button" onClick={() => onStop(cycle)} className="focus-ring rounded-lg px-2 py-1 text-xs text-text-secondary hover:text-danger">
            Turn off auto-renew
          </button>
        )}
      </div>
    </li>
  );
}

export function MembershipRenewalsPage() {
  const { toast } = useToast();
  const [cycles, setCycles] = useState<RenewalCycle[]>([]);
  const [kpis, setKpis] = useState<RenewalKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<RenewalCycle | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, k] = await Promise.all([fetchOpenRenewalCycles(), fetchRenewalKpis(90)]);
      setCycles(c);
      setKpis(k);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load renewals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = 'Renewals · Vireek';
    void load();
  }, [load]);

  const grouped = useMemo(() => groupPipeline(cycles), [cycles]);
  const coverage = kpis ? autoChargeCoverage(kpis) : null;

  const copyLink = async (c: RenewalCycle) => {
    try {
      await navigator.clipboard.writeText(renewalLink(window.location.origin, c.quote_token));
      toast('Renewal link copied', 'success');
    } catch {
      toast('Could not copy the link', 'error');
    }
  };

  const stopAutoRenew = async () => {
    if (!stopping) return;
    const target = stopping;
    setStopping(null);
    const { error: updateError } = await supabase.from('memberships').update({ auto_renew: false }).eq('id', target.membership_id);
    if (updateError) {
      toast('Could not update the membership', 'error');
      return;
    }
    toast('Auto-renew turned off — the membership ends at the end of its paid period', 'success');
    void load();
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <Link to="/dashboard/memberships" className="focus-ring mb-4 inline-flex items-center gap-1 rounded-lg text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft size={14} /> Memberships
        </Link>
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <RotateCcw size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Agreement renewals</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Every agreement is quoted 60 days out, reminded at 30 and 7, and charged to the card on file on the renewal date. Anyone who doesn’t renew enters the win-back sequence.
            </p>
          </div>
        </div>

        {error ? (
          <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 p-6 text-center">
            <p className="text-sm text-text-primary">{error}</p>
            <button type="button" onClick={() => void load()} className="focus-ring mt-3 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white">
              Try again
            </button>
          </div>
        ) : loading ? (
          <div className="space-y-4" aria-busy="true">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
            <div className="h-64 animate-pulse rounded-2xl bg-bg-tertiary" />
          </div>
        ) : (
          <>
            {kpis && (
              <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Kpi label="Renewal rate" value={formatRate(kpis.renewal_rate)} sub={`${kpis.renewed} renewed · ${kpis.lapsed + kpis.cancelled} lost · ${kpis.window_days}d`} />
                <Kpi label="In the pipeline" value={formatUsd(kpis.open_cycles_cents)} sub={`${kpis.open_cycles} upcoming renewals`} />
                <Kpi label="Revenue at risk" value={formatUsd(kpis.at_risk_cents)} sub="Failed, declined or needs an invoice" />
                <Kpi label="Auto-charge ready" value={coverage === null ? '—' : `${coverage}%`} sub={`Win-back recovered ${formatUsd(kpis.winback_recovered_cents)}`} />
              </div>
            )}

            {cycles.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-12 text-center">
                <h2 className="text-base font-semibold text-text-primary">No renewals in the pipeline yet</h2>
                <p className="mx-auto mt-1.5 max-w-md text-sm text-text-secondary">
                  Active yearly memberships appear here 60 days before they renew (monthly plans, 7 days before). Nothing needs to be set up.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                {PIPELINE_STAGES.map((stage) => (
                  <section key={stage.id} aria-label={stage.label} className="rounded-2xl border border-border bg-bg-secondary p-3">
                    <header className="mb-3 flex items-baseline justify-between px-1">
                      <div>
                        <h2 className="text-sm font-semibold text-text-primary">{stage.label}</h2>
                        <p className="text-xs text-text-secondary">{stage.hint}</p>
                      </div>
                      <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{grouped[stage.id].length}</span>
                    </header>
                    {grouped[stage.id].length === 0 ? (
                      <p className="px-1 py-4 text-center text-xs text-text-secondary">Nothing here</p>
                    ) : (
                      <ul className="space-y-2">
                        {grouped[stage.id].map((c) => <CycleCard key={c.id} cycle={c} onCopy={copyLink} onStop={setStopping} />)}
                      </ul>
                    )}
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!stopping}
        title="Turn off auto-renew?"
        description={`${stopping?.memberships?.customer_name ?? 'This member'} keeps their benefits until the end of the paid period, won’t be charged again, and then enters the win-back sequence.`}
        confirmLabel="Turn off"
        onConfirm={stopAutoRenew}
        onCancel={() => setStopping(null)}
      />
    </DashboardLayout>
  );
}
