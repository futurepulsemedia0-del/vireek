// /staff/margins — internal unit economics: margin per org/plan/cohort/feature, guardrail limits, rates, invoices,
// pricing simulator, enterprise quote and the monthly report. Staff only (<StaffRoute> + server-side checks in every RPC/RLS policy).
// Measured (provider-reported) and estimated values are always labelled separately.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, RefreshCw, TriangleAlert as AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { MarginOverview } from '@/components/staff/margins/MarginOverview';
import { PlanningPanel } from '@/components/staff/margins/PlanningPanel';
import { InputsPanel } from '@/components/staff/margins/InputsPanel';
import { ReportPanel } from '@/components/staff/margins/ReportPanel';
import { LedgerPanel } from '@/components/staff/margins/LedgerPanel';
import { INPUT } from '@/components/staff/margins/shared';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import { fetchUsageReport } from '@/lib/staffUsageApi';
import { DEFAULT_VOICE_COST_PER_MIN, PERIODS, buildDailyCosts, periodWindow, type PeriodKey, type UsageReport } from '@/lib/staffUsage';
import {
  buildPlanStats, buildTenantMargins, cohortStats, defaultAssumptions, freeTierSummary, measuredCostPerMinute, negativeMarginOrgs,
  priceUsageEvents, summarizeMargins, topCostDrivers, type MarginExtras, type UeReport, type UsageEventTotal,
} from '@/lib/marginDashboard';
import { UnitEconomicsError, fetchAiUsage, fetchMarginExtras, fetchUnitEconomics, fetchUsageEvents, listRates, type RateRow } from '@/lib/unitEconomicsApi';
import { aiCostByAccount, aiCoverageByModel, aiPricingSummary, applyAiRepricing, priceAiRows, type AiUsageBreakdown } from '@/lib/aiRepricing';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'planning', label: 'Simulator & quotes' },
  { id: 'ledger', label: 'Ledger & unit costs' },
  { id: 'inputs', label: 'Inputs' },
  { id: 'report', label: 'Report' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const CPM_KEY = 'vireek-staff-margin-fallback-cpm';

function SEO() {
  useSEO({ title: 'Margins — Staff', description: 'Internal: unit economics and margin guardrails.', canonical: 'https://vireek.com/staff/margins' });
  return null;
}

function readFallback(): string {
  try { return localStorage.getItem(CPM_KEY) ?? ''; } catch { return ''; }
}

export function StaffMarginsPage() {
  const { toast } = useToast();
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [tab, setTab] = useState<TabId>('overview');
  const [fallbackInput, setFallbackInput] = useState<string>(() => readFallback());
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [win, setWin] = useState(() => periodWindow('30d'));
  const [ue, setUe] = useState<UeReport | null>(null);
  const [extras, setExtras] = useState<MarginExtras>({ signupByAccount: {}, features: [] });
  const [events, setEvents] = useState<UsageEventTotal[]>([]);
  const [rates, setRates] = useState<RateRow[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [aiUsage, setAiUsage] = useState<AiUsageBreakdown>({ rows: [], truncated: false });

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  const loadId = useRef(0);
  const load = useCallback(async (silent = false) => {
    const id = ++loadId.current;
    const w = periodWindow(period);
    if (silent) setRefreshing(true); else setState('loading');
    try {
         const [u, x, e, r, d, ai] = await Promise.all([fetchUnitEconomics(w.start, w.end), fetchMarginExtras(w.start, w.end), fetchUsageEvents(w.start, w.end), listRates(), fetchUsageReport(w.start, w.end), fetchAiUsage(w.start, w.end)]);
      if (id !== loadId.current) return;
      setUe(u); setExtras(x); setEvents(e); setRates(r); setUsage(d); setAiUsage(ai); setWin(w); setState('ready');
    } catch (err) {
      if (id !== loadId.current) return;
      if (err instanceof UnitEconomicsError && err.forbidden) setState('forbidden');
      else if (silent) toast('Could not refresh margin data.', 'error');
      else { setErrorMsg(err instanceof Error ? err.message : 'Unknown error'); setState('error'); }
    } finally {
      if (id === loadId.current) setRefreshing(false);
    }
  }, [period, toast]);

  useEffect(() => { void load(); }, [load]);

  // The fallback prices ONLY voice minutes without a provider-reported cost. Empty = leave them unpriced.
  const fallbackCpm = useMemo(() => {
    const v = Number(fallbackInput);
    return fallbackInput.trim() !== '' && Number.isFinite(v) && v > 0 && v <= 5 ? v : null;
  }, [fallbackInput]);
  const commitFallback = () => { try { localStorage.setItem(CPM_KEY, fallbackInput); } catch { /* session-only */ } };

  // AI cost: re-priced from your provider rate table where rates exist; otherwise the logged list price (see AI pricing coverage).
  const pricedAi = useMemo(() => priceAiRows(aiUsage.rows, rates, new Date().toISOString().slice(0, 10)), [aiUsage, rates]);
  const aiSummary = useMemo(() => aiPricingSummary(pricedAi), [pricedAi]);
  const aiCoverage = useMemo(() => aiCoverageByModel(pricedAi), [pricedAi]);
  const margins = useMemo(
    () => (ue ? buildTenantMargins(applyAiRepricing(ue.tenants, aiCostByAccount(pricedAi), aiUsage.truncated), { fallbackVoiceCpm: fallbackCpm, days: win.days }) : []),
    [ue, pricedAi, aiUsage.truncated, fallbackCpm, win.days],
  );
  
  const summary = useMemo(() => summarizeMargins(margins), [margins]);
  const plans = useMemo(() => buildPlanStats(margins), [margins]);
  const measuredCpm = useMemo(() => measuredCostPerMinute(margins), [margins]);
  const drivers = useMemo(() => (ue ? topCostDrivers(ue, summary) : []), [ue, summary]);
  const priced = useMemo(() => priceUsageEvents(events, rates, new Date().toISOString().slice(0, 10)), [events, rates]);
  const daily = useMemo(() => (usage ? buildDailyCosts(usage.daily, win.start, win.end, measuredCpm ?? fallbackCpm ?? DEFAULT_VOICE_COST_PER_MIN) : []), [usage, win, measuredCpm, fallbackCpm]);
  const coverage = useMemo(() => ({ callsTotal: ue?.calls_total ?? 0, callsWithCost: ue?.calls_with_cost ?? 0 }), [ue]);
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? period;

  const reportModel = useMemo(() => ({
    title: 'Vireek unit economics', periodLabel: `${periodLabel} ending ${win.end.toISOString().slice(0, 10)}`, generatedAtIso: new Date().toISOString(), coverage,
    totals: summary, planStats: plans, negative: negativeMarginOrgs(margins, 10), drivers, freeTier: freeTierSummary(margins), reconciliation: null,
    assumptions: defaultAssumptions({ fallbackVoiceCpm: fallbackCpm, days: win.days, callsTotal: coverage.callsTotal, callsWithCost: coverage.callsWithCost }),
  }), [periodLabel, win, coverage, summary, plans, margins, drivers, fallbackCpm]);

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    document.getElementById(`margins-tab-${TABS[next].id}`)?.focus();
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 className="text-accent" size={22} aria-hidden="true" />
                <h1 className="text-2xl font-bold tracking-tight text-text-primary">Margins &amp; unit economics</h1>
              </div>
              <p className="mt-1 text-sm text-text-secondary">Provider-reported voice cost is shown as measured; everything else is labelled as an estimate. <Link to="/staff/usage" className="focus-ring text-accent underline">Per-tenant usage</Link></p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-text-secondary">Fallback $/min (uncovered minutes)</span>
                <input inputMode="decimal" value={fallbackInput} onChange={(e) => setFallbackInput(e.target.value)} onBlur={commitFallback} placeholder="empty = unpriced" className={`${INPUT} w-44`} />
              </label>
              <div role="radiogroup" aria-label="Period" className="inline-flex rounded-xl border border-border bg-bg-secondary p-1">
                {PERIODS.map((p) => (
                  <button key={p.key} type="button" role="radio" aria-checked={period === p.key} onClick={() => setPeriod(p.key)}
                    className={`focus-ring min-h-[36px] rounded-lg px-3 text-sm font-medium transition-colors ${period === p.key ? 'bg-accent text-on-accent' : 'text-text-secondary hover:text-text-primary'}`}>{p.label}</button>
                ))}
              </div>
              <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={refreshing || state === 'loading'} aria-label="Refresh data">
                <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
              </Button>
            </div>
          </div>

          {state === 'loading' && (
            <div className="mt-8 space-y-6" role="status" aria-label="Loading margin data">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
              <Skeleton className="h-64 rounded-2xl" />
            </div>
          )}
          {state === 'forbidden' && <div className="mt-8"><EmptyState icon={AlertTriangle} title="Staff access required" description="Your account is not marked as Vireek staff, so margin data is not available." /></div>}
          {state === 'error' && <div className="mt-8"><EmptyStateError icon={BarChart3} title="Couldn't load margins" description={errorMsg || "We couldn't load this data. Please try again."} onRetry={() => void load()} /></div>}

          {state === 'ready' && ue && (
            <div className="mt-8">
              <div role="tablist" aria-label="Margin sections" className="mb-6 flex flex-wrap gap-1 border-b border-border">
                {TABS.map((t, i) => (
                  <button key={t.id} id={`margins-tab-${t.id}`} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`margins-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
                    onClick={() => setTab(t.id)} onKeyDown={(e) => onTabKey(e, i)}
                    className={`focus-ring min-h-[44px] rounded-t-lg px-4 text-sm font-medium ${tab === t.id ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}>{t.label}</button>
                ))}
              </div>
              <div id={`margins-panel-${tab}`} role="tabpanel" aria-labelledby={`margins-tab-${tab}`} tabIndex={0} className="focus-ring rounded-xl">
                {tab === 'overview' && <MarginOverview summary={summary} plans={plans} negative={negativeMarginOrgs(margins)} drivers={drivers} cohorts={cohortStats(margins, extras.signupByAccount)} features={extras.features} freeTier={freeTierSummary(margins)} daily={daily} coverage={coverage} measuredCpm={measuredCpm} usage={priced} truncated={ue.truncated} />}
                {tab === 'planning' && <PlanningPanel margins={margins} plans={plans} days={win.days} defaultCpm={measuredCpm ?? fallbackCpm} />}
                {tab === 'ledger' && <LedgerPanel start={win.start} end={win.end} />}
                {tab === 'inputs' && <InputsPanel onChanged={() => void load(true)} />}
                {tab === 'report' && <ReportPanel model={reportModel} />}
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
