// Staff-only "Realised COGS" tab of /staff/margins: measured cost per call-minute and per AI action by plan and tenant,
// and realised gross margin by plan. Read-only. Source: cost_ledger via the cogs_* views (20290305000100). Revenue is the
// list subscription price (see docs/finance/cogs-assumptions.md), so every figure is labelled with its basis.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert as AlertTriangle } from 'lucide-react';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Field, INPUT, Kpi, Section, TableWrap, TD, TDR, TH, THR } from '@/components/staff/margins/shared';
import { CogsError, fetchCogsAiActions, fetchCogsByPlan, fetchCogsTenants } from '@/lib/cogsApi';
import {
  COGS_MARGIN_FLOOR_PCT, COGS_MIN_COVERAGE_PCT, formatCents, formatMicroUsd, formatPct1, planStatus, recentMonths,
  type CogsAiActionRow, type CogsPlanRow, type CogsPlanStatus, type CogsTenantRow,
} from '@/lib/cogs';

const STATUS: Record<CogsPlanStatus, { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'bg-success/10 text-success' },
  below_floor: { label: `Below ${COGS_MARGIN_FLOOR_PCT}%`, cls: 'bg-danger/10 text-danger' },
  no_price: { label: 'No fixed price', cls: 'bg-bg-tertiary text-text-secondary' },
  no_revenue: { label: 'No billed tenants', cls: 'bg-bg-tertiary text-text-secondary' },
  low_coverage: { label: `Cost coverage < ${COGS_MIN_COVERAGE_PCT}%`, cls: 'bg-warning/10 text-warning' },
};

type State = 'loading' | 'ready' | 'error' | 'forbidden';

const shortId = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

export function CogsPanel() {
  const months = useMemo(() => recentMonths(new Date(), 12), []);
  const [month, setMonth] = useState(months[0]);
  const [state, setState] = useState<State>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [plans, setPlans] = useState<CogsPlanRow[]>([]);
  const [tenants, setTenants] = useState<CogsTenantRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [actions, setActions] = useState<CogsAiActionRow[]>([]);
  const loadId = useRef(0);

  const load = useCallback(async () => {
    const id = ++loadId.current;
    setState('loading');
    try {
      const [p, t, a] = await Promise.all([fetchCogsByPlan(month), fetchCogsTenants(month, 200), fetchCogsAiActions(month)]);
      if (id !== loadId.current) return;
      setPlans(p); setTenants(t.rows); setTruncated(t.truncated); setActions(a); setState('ready');
    } catch (err) {
      if (id !== loadId.current) return;
      if (err instanceof CogsError && err.forbidden) { setState('forbidden'); return; }
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setState('error');
    }
  }, [month]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => {
    const cost = plans.reduce((s, r) => s + r.totalCostMicro, 0);
    const minutes = plans.reduce((s, r) => s + r.minutesCosted, 0);
    const voice = plans.reduce((s, r) => s + r.voiceCostMicro, 0);
    const aiCost = plans.reduce((s, r) => s + r.aiCostMicro, 0);
    const aiActions = plans.reduce((s, r) => s + r.aiActions, 0);
    const callsTotal = plans.reduce((s, r) => s + r.callsTotal, 0);
    const callsCosted = plans.reduce((s, r) => s + r.callsCosted, 0);
    return {
      cost,
      perMin: minutes > 0 ? voice / minutes : null,
      perAction: aiActions > 0 ? aiCost / aiActions : null,
      coverage: callsTotal > 0 ? (100 * callsCosted) / callsTotal : null,
    };
  }, [plans]);
  const flagged = plans.filter((r) => planStatus(r) === 'below_floor');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-3xl text-sm text-text-secondary">
          Realised cost from the append-only cost ledger. Revenue is the <strong>list subscription price</strong> of each tenant&apos;s current plan
          (no discounts, overage, annual proration or history); cost is variable usage only (no phone numbers, platform hosting, support or payment fees).
        </p>
        <Field label="Month">
          <select value={month} onChange={(e) => setMonth(e.target.value)} className={`${INPUT} w-40`} aria-label="Month">
            {months.map((m) => <option key={m} value={m}>{m.slice(0, 7)}</option>)}
          </select>
        </Field>
      </div>

      {state === 'loading' && (
        <div className="space-y-4" role="status" aria-label="Loading COGS data">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      )}
      {state === 'forbidden' && <EmptyState icon={AlertTriangle} title="Staff access required" description="Your account is not marked as Vireek staff, so COGS data is not available." />}
      {state === 'error' && <EmptyStateError icon={AlertTriangle} title="Couldn't load COGS" description={errorMsg || "We couldn't load this data. Please try again."} onRetry={() => void load()} />}

      {state === 'ready' && plans.length === 0 && (
        <EmptyState icon={AlertTriangle} title="No cost data for this month" description="The ledger has no calls or metered usage for the selected month yet." />
      )}

      {state === 'ready' && plans.length > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Total variable cost" value={formatMicroUsd(totals.cost, { digits: 2 })} sub="ledger: voice + AI + other usage" />
            <Kpi label="Cost per call-minute" value={formatMicroUsd(totals.perMin)} sub="costed calls only" />
            <Kpi label="Cost per AI action" value={formatMicroUsd(totals.perAction)} sub="metered LLM invocations" />
            <Kpi label="Call cost coverage" value={formatPct1(totals.coverage)} sub={`target ≥ ${COGS_MIN_COVERAGE_PCT}% of calls with a ledger cost`} tone={totals.coverage !== null && totals.coverage < COGS_MIN_COVERAGE_PCT ? 'bad' : undefined} />
          </div>

          {flagged.length > 0 && (
            <p role="status" className="rounded-xl border border-danger bg-danger/10 p-3 text-sm text-text-primary">
              Below the {COGS_MARGIN_FLOOR_PCT}% gross-margin floor: {flagged.map((r) => `${r.planTier} (${formatPct1(r.grossMarginPct)})`).join(', ')}.
            </p>
          )}

          <Section title="Gross margin by plan" aside={<span className="text-xs text-text-secondary">list-price revenue · ledger cost</span>}>
            <TableWrap caption="Realised gross margin by plan">
              <thead><tr>
                <th scope="col" className={TH}>Plan</th><th scope="col" className={THR}>Billed / total</th><th scope="col" className={THR}>List price</th>
                <th scope="col" className={THR}>Revenue</th><th scope="col" className={THR}>Cost</th><th scope="col" className={THR}>Gross margin</th>
                <th scope="col" className={THR}>$/call-min</th><th scope="col" className={THR}>$/AI action</th><th scope="col" className={TH}>Status</th>
              </tr></thead>
              <tbody>{plans.map((r) => {
                const s = planStatus(r);
                return (
                  <tr key={r.planTier} className="border-t border-border">
                    <th scope="row" className={`${TD} font-medium capitalize`}>{r.planTier}</th>
                    <td className={TDR}>{r.tenantsBilled} / {r.tenantsTotal}</td>
                    <td className={TDR}>{r.priceIsQuoted ? 'quoted' : formatCents(r.listPriceCents)}</td>
                    <td className={TDR}>{formatCents(r.subscriptionRevenueCents)}</td>
                    <td className={TDR}>{formatMicroUsd(r.totalCostMicro, { digits: 2 })}</td>
                    <td className={TDR}>{formatCents(r.grossMarginCents)} · {formatPct1(r.grossMarginPct)}</td>
                    <td className={TDR}>{formatMicroUsd(r.voiceCostPerMinMicro)}</td>
                    <td className={TDR}>{formatMicroUsd(r.aiCostPerActionMicro)}</td>
                    <td className={TD}><span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${STATUS[s].cls}`}>{STATUS[s].label}</span></td>
                  </tr>
                );
              })}</tbody>
            </TableWrap>
          </Section>

          <Section title="AI actions by plan and task">
            {actions.length === 0 ? (
              <p className="text-sm text-text-secondary">No metered AI actions in this month.</p>
            ) : (
              <TableWrap caption="AI cost per action by plan and task">
                <thead><tr>
                  <th scope="col" className={TH}>Plan</th><th scope="col" className={TH}>Task</th><th scope="col" className={THR}>Actions</th>
                  <th scope="col" className={THR}>Tenants</th><th scope="col" className={THR}>Cost</th><th scope="col" className={THR}>$/action</th>
                </tr></thead>
                <tbody>{actions.map((a) => (
                  <tr key={`${a.planTier}|${a.taskType}`} className="border-t border-border">
                    <th scope="row" className={`${TD} font-medium capitalize`}>{a.planTier}</th>
                    <td className={TD}>{a.taskType}</td>
                    <td className={TDR}>{a.aiActions.toLocaleString('en-US')}</td>
                    <td className={TDR}>{a.tenants}</td>
                    <td className={TDR}>{formatMicroUsd(a.costMicro, { digits: 2 })}</td>
                    <td className={TDR}>{formatMicroUsd(a.costPerActionMicro)}</td>
                  </tr>
                ))}</tbody>
              </TableWrap>
            )}
          </Section>

          <Section title="Tenants by cost" aside={truncated ? <span className="text-xs text-warning">Top 200 shown</span> : undefined}>
            <TableWrap caption="Cost per call-minute and per AI action by tenant">
              <thead><tr>
                <th scope="col" className={TH}>Tenant</th><th scope="col" className={TH}>Plan</th><th scope="col" className={THR}>Costed calls</th>
                <th scope="col" className={THR}>$/call-min</th><th scope="col" className={THR}>AI actions</th><th scope="col" className={THR}>$/AI action</th>
                <th scope="col" className={THR}>Total cost</th><th scope="col" className={THR}>Coverage</th>
              </tr></thead>
              <tbody>{tenants.map((t) => (
                <tr key={t.accountId} className="border-t border-border">
                  <th scope="row" className={`${TD} font-mono text-xs`} title={t.accountId}>{shortId(t.accountId)}</th>
                  <td className={`${TD} capitalize`}>{t.planTier}{t.isBilled ? '' : ' · unbilled'}</td>
                  <td className={TDR}>{t.callsCosted} / {t.callsTotal}</td>
                  <td className={TDR}>{formatMicroUsd(t.voiceCostPerMinMicro)}</td>
                  <td className={TDR}>{t.aiActions.toLocaleString('en-US')}</td>
                  <td className={TDR}>{formatMicroUsd(t.aiCostPerActionMicro)}</td>
                  <td className={TDR}>{formatMicroUsd(t.totalCostMicro, { digits: 2 })}</td>
                  <td className={TDR}>{formatPct1(t.callCostCoveragePct)}</td>
                </tr>
              ))}</tbody>
            </TableWrap>
          </Section>

          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => void load()} aria-label="Reload COGS data">Reload</Button>
          </div>
        </>
      )}
    </div>
  );
}
