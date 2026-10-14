/**
 * Energy Intelligence - /dashboard/energy-intelligence
 *
 * Utility bills + Property Intelligence (climate, size, rates) + Equipment Health (telemetry,
 * failure predictions) + Weather alerts + Rebate Intelligence, in one decision page:
 * usage, anomalies, efficiency, equipment impact, upgrade opportunities with real incentives
 * and payback, and a 12-month demand forecast. All maths is deterministic and server-side
 * (supabase/functions/energy-intelligence); every assumption is shown on the page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Gauge, Zap } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { ForecastChart, UsageChart } from '@/components/energy/EnergyCharts';
import { UsageDataPanel } from '@/components/energy/UsageDataPanel';
import { fetchPickerCustomers, type PickerCustomer } from '@/lib/rebateIntelligence';
import {
  ANOMALY_LABELS,
  CATEGORY_LABELS,
  CONFIDENCE_TONE,
  DEFAULT_ESCALATION_PCT,
  GRADE_TONE,
  PLANNING_COST_CENTS,
  SEVERITY_TONE,
  STAGE_TONE,
  fetchCustomerSites,
  fmtMoney,
  fmtNum,
  runEnergyAnalysis,
  runEnergyPortfolio,
  runOpportunityRebateCheck,
  type EnergyAnalysisResult,
  type Opportunity,
  type OpportunityFinance,
  type PortfolioRow,
  type SiteOption,
} from '@/lib/energyIntelligence';

const FIELD =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/70';

type Tab = 'overview' | 'anomalies' | 'equipment' | 'upgrades' | 'forecast' | 'portfolio' | 'bills';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'anomalies', label: 'Anomalies' },
  { id: 'equipment', label: 'Equipment impact' },
  { id: 'upgrades', label: 'Upgrades & savings' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'portfolio', label: 'All customers' },
  { id: 'bills', label: 'Bills' },
];

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone ?? 'text-text-primary'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}
    >
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-text-secondary">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Upgrade card (opportunity -> Rebate Intelligence -> payback)
// ---------------------------------------------------------------------------

interface OppState {
  cost: string;
  loading: boolean;
  error: string | null;
  finance: OpportunityFinance | null;
}

function OpportunityCard({
  o,
  state,
  onCost,
  onRun,
}: {
  o: Opportunity;
  state: OppState;
  onCost: (v: string) => void;
  onRun: () => void;
}) {
  const f = state.finance;
  return (
    <article className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">{o.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">{o.rationale}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-success-500">
            {o.savings_cents ? `${fmtMoney(o.savings_cents.expected)}/yr` : 'Needs bill costs'}
          </p>
          {o.savings_cents && (
            <p className="text-[11px] text-text-secondary">
              range {fmtMoney(o.savings_cents.low)} to {fmtMoney(o.savings_cents.high)}
            </p>
          )}
        </div>
      </div>
      <p className="mt-2 text-[11px] text-text-secondary">
        {o.kwh_saved !== 0 && (
          <>
            {o.kwh_saved > 0 ? 'Saves' : 'Adds'} {fmtNum(Math.abs(o.kwh_saved))} kWh/yr.{' '}
          </>
        )}
        {o.therms_saved !== 0 && <>Saves {fmtNum(o.therms_saved)} therms/yr. </>}
        Basis: {o.basis.join('; ')}.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
        <label className="text-xs text-text-secondary">
          Installed cost ($){' '}
          <span className="text-text-secondary/70">
            (planning estimate, replace with your quote)
          </span>
          <input
            inputMode="decimal"
            value={state.cost}
            onChange={(e) => onCost(e.target.value)}
            className={`${FIELD} mt-1 w-40`}
          />
        </label>
        <Button size="sm" variant="secondary" onClick={onRun} disabled={state.loading}>
          {state.loading ? 'Checking incentives...' : 'Check rebates & payback'}
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="mt-2 text-xs text-danger-500">
          {state.error}
        </p>
      )}
      {f && (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-text-secondary">Installed cost</dt>
            <dd className="font-semibold text-text-primary">{fmtMoney(f.gross_cost_cents)}</dd>
          </div>
          <div>
            <dt className="text-text-secondary">Expected incentives</dt>
            <dd className="font-semibold text-success-500">
              {fmtMoney(f.incentives_expected_cents)}
            </dd>
          </div>
          <div>
            <dt className="text-text-secondary">Net cost</dt>
            <dd className="font-semibold text-text-primary">{fmtMoney(f.net_cost_cents)}</dd>
          </div>
          <div>
            <dt className="text-text-secondary">Payback</dt>
            <dd className="font-semibold text-text-primary">
              {f.payback_years === null
                ? 'Over 30 years'
                : f.payback_years === 0
                  ? 'Immediate'
                  : `${f.payback_years} yrs`}
            </dd>
          </div>
          <div className="col-span-2 sm:col-span-4 text-text-secondary">
            {f.ten_year_net_cents !== null && (
              <>
                10-year position after cost:{' '}
                <strong
                  className={f.ten_year_net_cents >= 0 ? 'text-success-500' : 'text-danger-500'}
                >
                  {fmtMoney(f.ten_year_net_cents)}
                </strong>
                .{' '}
              </>
            )}
            {f.best_program && <>Best match: {f.best_program}. </>}
            {f.deadline && <strong className="text-warning-500">{f.deadline}. </strong>}
            <Link
              to="/dashboard/rebate-intelligence"
              className="focus-ring inline-flex items-center gap-1 rounded text-accent"
            >
              Full rebate analysis <ArrowRight size={12} aria-hidden="true" />
            </Link>
          </div>
        </dl>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function EnergyIntelligencePage() {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<PickerCustomer[] | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [escalation, setEscalation] = useState(String(DEFAULT_ESCALATION_PCT));
  const [result, setResult] = useState<EnergyAnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [portfolio, setPortfolio] = useState<PortfolioRow[] | null>(null);
  const [opp, setOpp] = useState<Record<string, OppState>>({});
  const seq = useRef(0);

  const escalationPct = useMemo(() => {
    const n = Number(escalation);
    return Number.isFinite(n) ? Math.min(15, Math.max(0, n)) : DEFAULT_ESCALATION_PCT;
  }, [escalation]);

  useEffect(() => {
    fetchPickerCustomers()
      .then(setCustomers)
      .catch(() => {
        setCustomers([]);
        toast('Could not load customers.', 'error');
      });
  }, [toast]);

  const run = useCallback(async (cid: string, sid: string | null, esc: number) => {
    if (!cid) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await runEnergyAnalysis({ customerId: cid, siteId: sid, escalationPct: esc });
      if (mine !== seq.current) return;
      setResult(r);
      setOpp({});
    } catch (e) {
      if (mine !== seq.current) return;
      setResult(null);
      setError(e instanceof Error ? e.message : 'Could not run the analysis.');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  const pickCustomer = (id: string) => {
    setCustomerId(id);
    setSiteId(null);
    setSites([]);
    setResult(null);
    if (!id) return;
    fetchCustomerSites(id)
      .then(setSites)
      .catch(() => setSites([]));
    void run(id, null, escalationPct);
  };

  const pickSite = (id: string) => {
    const next = id || null;
    setSiteId(next);
    void run(customerId, next, escalationPct);
  };

  const loadPortfolio = useCallback(async () => {
    setPortfolio(null);
    try {
      setPortfolio(await runEnergyPortfolio());
    } catch (e) {
      setPortfolio([]);
      toast(e instanceof Error ? e.message : 'Could not load the portfolio.', 'error');
    }
  }, [toast]);

  useEffect(() => {
    if (tab === 'portfolio' && portfolio === null) void loadPortfolio();
  }, [tab, portfolio, loadPortfolio]);

  const report = result?.report ?? null;
  const resolvedSite = siteId ?? result?.siteId ?? null;

  const oppState = (o: Opportunity): OppState =>
    opp[o.id] ?? {
      cost: String(Math.round(PLANNING_COST_CENTS[o.measure] / 100)),
      loading: false,
      error: null,
      finance: null,
    };

  const runOpportunity = async (o: Opportunity) => {
    const cur = oppState(o);
    const dollars = Number(cur.cost.replace(/[$,]/g, ''));
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setOpp((s) => ({ ...s, [o.id]: { ...cur, error: 'Enter the installed cost first.' } }));
      return;
    }
    setOpp((s) => ({ ...s, [o.id]: { ...cur, loading: true, error: null } }));
    try {
      const { finance } = await runOpportunityRebateCheck({
        customerId,
        siteId: resolvedSite,
        opportunity: o,
        installedCostCents: Math.round(dollars * 100),
        escalationPct,
      });
      setOpp((s) => ({ ...s, [o.id]: { ...cur, loading: false, error: null, finance } }));
    } catch (e) {
      setOpp((s) => ({
        ...s,
        [o.id]: {
          ...cur,
          loading: false,
          error: e instanceof Error ? e.message : 'Rebate check failed.',
        },
      }));
    }
  };

  const totals = report?.totals;
  const fuelsWithData = report?.fuels ?? [];

  return (
    <DashboardLayout activeLabel="Energy Intelligence">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Zap size={22} className="text-accent" aria-hidden="true" /> Energy Intelligence
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
            Where a property's energy goes, what is wrong, what to upgrade, what it will save after
            incentives, and what next year will cost. Built from real utility bills, the property's
            climate, its equipment and your rebate catalog.
          </p>
        </div>

        <div className="mb-4 grid gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:grid-cols-[2fr_1.5fr_1fr_auto] sm:items-end">
          <label className="text-xs font-medium text-text-secondary">
            Customer
            <select
              value={customerId}
              onChange={(e) => pickCustomer(e.target.value)}
              className={`${FIELD} mt-1`}
              disabled={customers === null}
            >
              <option value="">{customers === null ? 'Loading...' : 'Select a customer'}</option>
              {(customers ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-text-secondary">
            Site
            <select
              value={siteId ?? ''}
              onChange={(e) => pickSite(e.target.value)}
              className={`${FIELD} mt-1`}
              disabled={!customerId || sites.length === 0}
            >
              <option value="">{sites.length === 0 ? 'Primary / none' : 'Primary site'}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.city ? `, ${s.city}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-text-secondary">
            Energy price growth (%/yr)
            <input
              inputMode="decimal"
              value={escalation}
              onChange={(e) => setEscalation(e.target.value)}
              onBlur={() => customerId && void run(customerId, siteId, escalationPct)}
              className={`${FIELD} mt-1`}
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={!customerId || loading}
            onClick={() => void run(customerId, siteId, escalationPct)}
          >
            {loading ? 'Analyzing...' : 'Re-run'}
          </Button>
        </div>

        <div
          role="tablist"
          aria-label="Energy Intelligence sections"
          className="mb-4 flex gap-1 overflow-x-auto border-b border-border"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`focus-ring whitespace-nowrap rounded-t-lg px-3 py-2 text-sm font-medium ${tab === t.id ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" aria-live="polite" aria-busy={loading}>
          {tab === 'portfolio' ? (
            portfolio === null ? (
              <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
            ) : portfolio.length === 0 ? (
              <Empty>
                No customers have billing history yet. Add bills on the Bills tab to see your
                upgrade pipeline here.
              </Empty>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-xs text-text-secondary">
                    <tr>
                      <th className="p-3 font-medium">Customer</th>
                      <th className="p-3 font-medium">Annual energy cost</th>
                      <th className="p-3 font-medium">Savings potential</th>
                      <th className="p-3 font-medium">Grade</th>
                      <th className="p-3 font-medium">Alerts</th>
                      <th className="p-3 font-medium">Top opportunity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portfolio.map((r) => (
                      <tr key={r.customer_id} className="border-t border-border">
                        <td className="p-3">
                          <button
                            type="button"
                            className="focus-ring rounded text-left font-medium text-accent"
                            onClick={() => {
                              pickCustomer(r.customer_id);
                              setTab('overview');
                            }}
                          >
                            {r.name}
                          </button>
                          <p className="text-[11px] text-text-secondary">
                            {fmtNum(r.months_covered, 0)} months of bills
                          </p>
                        </td>
                        <td className="p-3 text-text-primary">{fmtMoney(r.annual_cost_cents)}</td>
                        <td className="p-3 font-semibold text-success-500">
                          {fmtMoney(r.expected_savings_cents)}
                        </td>
                        <td
                          className={`p-3 font-bold ${r.grade ? GRADE_TONE[r.grade] : 'text-text-secondary'}`}
                        >
                          {r.grade ?? '-'}
                        </td>
                        <td className="p-3">
                          {r.high_anomalies > 0 ? (
                            <Chip tone={SEVERITY_TONE.high}>{r.high_anomalies} high</Chip>
                          ) : (
                            <span className="text-text-secondary">None</span>
                          )}
                        </td>
                        <td className="p-3 text-xs text-text-secondary">
                          {r.top_opportunity ?? '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : tab === 'bills' ? (
            customerId ? (
              <UsageDataPanel
                customerId={customerId}
                sites={sites}
                siteId={siteId}
                onChanged={() => void run(customerId, siteId, escalationPct)}
              />
            ) : (
              <Empty>Select a customer to enter or import their utility bills.</Empty>
            )
          ) : !customerId ? (
            <Empty>Select a customer to analyze their energy use.</Empty>
          ) : loading && !report ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-28 animate-pulse rounded-2xl bg-bg-tertiary" />
              ))}
            </div>
          ) : error ? (
            <p
              role="alert"
              className="rounded-2xl border border-danger-500/30 bg-danger-500/5 p-5 text-sm text-danger-500"
            >
              {error}
            </p>
          ) : !report ? null : (
            <>
              {tab === 'overview' && (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Tile
                      label="Annual energy cost"
                      value={fmtMoney(totals?.annual_cost_cents)}
                      sub={
                        totals?.cost_per_sqft_cents != null
                          ? `${fmtMoney(totals.cost_per_sqft_cents)} per sq ft`
                          : 'Add bill amounts for dollar figures'
                      }
                    />
                    <Tile
                      label="Efficiency grade"
                      value={
                        totals?.grade ? `${totals.grade}  ${totals.efficiency_score}/100` : '-'
                      }
                      tone={totals?.grade ? GRADE_TONE[totals.grade] : undefined}
                      sub={
                        totals?.eui_kbtu_sqft != null
                          ? `${totals.eui_kbtu_sqft} kBtu/sq ft vs ${totals.reference_eui_kbtu_sqft} planning reference`
                          : 'Needs square footage (Property Intelligence)'
                      }
                    />
                    <Tile
                      label="Savings potential"
                      value={
                        report.portfolio.savings_cents
                          ? `${fmtMoney(report.portfolio.savings_cents.expected)}/yr`
                          : '-'
                      }
                      sub={
                        report.portfolio.pct_of_annual_cost != null
                          ? `${report.portfolio.pct_of_annual_cost}% of the bill, all upgrades combined`
                          : undefined
                      }
                      tone="text-success-500"
                    />
                    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                        Confidence
                      </p>
                      <div className="mt-2">
                        <Chip tone={CONFIDENCE_TONE[report.confidence]}>
                          {report.confidence.toUpperCase()}
                        </Chip>
                      </div>
                      <p className="mt-1.5 text-xs text-text-secondary">
                        {fmtNum(report.data_quality.months_covered, 0)} months of bills
                        {report.data_quality.r2_electric != null &&
                          `, weather explains ${Math.round(report.data_quality.r2_electric * 100)}% of electric use`}
                      </p>
                    </div>
                  </div>

                  {report.actions.length > 0 && (
                    <section
                      className="rounded-2xl border border-accent/25 bg-accent/5 p-5"
                      aria-labelledby="ei-actions"
                    >
                      <h2 id="ei-actions" className="text-sm font-semibold text-text-primary">
                        What to do next
                      </h2>
                      <ul className="mt-2 space-y-1.5 text-sm text-text-primary">
                        {report.actions.map((a) => (
                          <li key={a} className="flex gap-2">
                            <ArrowRight
                              size={14}
                              className="mt-1 shrink-0 text-accent"
                              aria-hidden="true"
                            />
                            {a}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {fuelsWithData.length === 0 ? (
                    <Empty>
                      No bills yet. Open the Bills tab and add 12+ months of electric and gas bills
                      to unlock the analysis.
                    </Empty>
                  ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                      {fuelsWithData.map((f) => (
                        <section
                          key={f.fuel}
                          className="rounded-2xl border border-border bg-bg-secondary p-5"
                        >
                          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                            <h2 className="text-sm font-semibold text-text-primary">
                              {f.fuel === 'electric' ? 'Electricity' : 'Natural gas'}
                            </h2>
                            <p className="text-xs text-text-secondary">
                              {fmtNum(f.normalized_annual_usage)} {f.unit}/yr normalized
                              {f.rate_per_unit_cents !== null &&
                                ` at ${f.rate_per_unit_cents.toFixed(1)} cents${f.rate_source === 'eia' ? ' (state average)' : ''}`}
                            </p>
                          </div>
                          <UsageChart fuel={f} />
                          {f.components && f.model.mode === 'weather_regression' && (
                            <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                              {(
                                [
                                  ['Always-on', f.components.base],
                                  ['Cooling', f.components.cooling],
                                  ['Heating', f.components.heating],
                                ] as const
                              ).map(([k, v]) => (
                                <div key={k} className="rounded-xl bg-bg-primary p-2">
                                  <dt className="text-text-secondary">{k}</dt>
                                  <dd className="font-semibold text-text-primary">
                                    {fmtNum(v)} {f.unit}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </section>
                      ))}
                    </div>
                  )}

                  {(report.weather.notes.length > 0 ||
                    report.weather.heat_events +
                      report.weather.cold_events +
                      report.weather.storm_events >
                      0) && (
                    <section
                      className="rounded-2xl border border-border bg-bg-secondary p-5"
                      aria-labelledby="ei-wx"
                    >
                      <h2
                        id="ei-wx"
                        className="flex items-center justify-between text-sm font-semibold text-text-primary"
                      >
                        Weather exposure
                        <Link
                          to="/dashboard/weather-surge"
                          className="focus-ring rounded text-xs font-medium text-accent"
                        >
                          Weather Intelligence
                        </Link>
                      </h2>
                      <p className="mt-1 text-xs text-text-secondary">
                        Last 12 months of alerts for your watched ZIP: {report.weather.heat_events}{' '}
                        heat, {report.weather.cold_events} cold, {report.weather.storm_events}{' '}
                        storm.
                      </p>
                      <ul className="mt-2 space-y-1 text-sm text-text-primary">
                        {report.weather.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {report.data_quality.warnings.length > 0 && (
                    <section
                      className="rounded-2xl border border-warning-500/30 bg-warning-500/5 p-5"
                      aria-labelledby="ei-dq"
                    >
                      <h2
                        id="ei-dq"
                        className="flex items-center gap-2 text-sm font-semibold text-text-primary"
                      >
                        <AlertTriangle size={14} className="text-warning-500" aria-hidden="true" />{' '}
                        Data quality
                      </h2>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-text-secondary">
                        {report.data_quality.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                      <p className="mt-2 text-xs">
                        <Link
                          to="/dashboard/property-intelligence"
                          className="focus-ring rounded text-accent"
                        >
                          Property Intelligence
                        </Link>{' '}
                        supplies climate, size and local rates ·{' '}
                        <Link
                          to="/dashboard/building-telemetry"
                          className="focus-ring rounded text-accent"
                        >
                          Building Telemetry
                        </Link>{' '}
                        adds measured equipment data
                      </p>
                    </section>
                  )}

                  <details className="rounded-2xl border border-border bg-bg-secondary p-5">
                    <summary className="focus-ring cursor-pointer rounded text-sm font-semibold text-text-primary">
                      Assumptions behind these numbers
                    </summary>
                    <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                      {report.assumptions.map((a) => (
                        <div key={a.id}>
                          <dt className="font-medium text-text-primary">{a.label}</dt>
                          <dd className="text-text-secondary">{a.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </div>
              )}

              {tab === 'anomalies' &&
                (report.anomalies.length === 0 ? (
                  <Empty>
                    No anomalies. Usage follows the property's seasonal pattern and no
                    energy-relevant equipment signals are open.
                  </Empty>
                ) : (
                  <ul className="space-y-3">
                    {report.anomalies.map((a) => (
                      <li
                        key={a.id}
                        className="rounded-2xl border border-border bg-bg-secondary p-5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip tone={SEVERITY_TONE[a.severity]}>{a.severity.toUpperCase()}</Chip>
                          <Chip tone="bg-bg-tertiary text-text-secondary">
                            {ANOMALY_LABELS[a.kind]}
                          </Chip>
                          <h3 className="text-sm font-semibold text-text-primary">{a.title}</h3>
                          {a.est_excess_cost_cents != null && a.est_excess_cost_cents > 0 && (
                            <span className="ml-auto text-xs font-semibold text-danger-500">
                              about {fmtMoney(a.est_excess_cost_cents)} extra
                            </span>
                          )}
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                          {a.explanation}
                        </p>
                      </li>
                    ))}
                  </ul>
                ))}

              {tab === 'equipment' &&
                (report.equipment.length === 0 ? (
                  <Empty>
                    No active equipment on file for this customer. Add equipment to see its energy
                    impact.
                  </Empty>
                ) : (
                  <div className="space-y-3">
                    {report.equipment.map((e) => (
                      <article
                        key={e.id}
                        className="rounded-2xl border border-border bg-bg-secondary p-5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-text-primary">{e.label}</h3>
                          <Chip tone="bg-bg-tertiary text-text-secondary">
                            {CATEGORY_LABELS[e.category]}
                          </Chip>
                          <Chip tone={STAGE_TONE[e.stage].tone}>{STAGE_TONE[e.stage].label}</Chip>
                          {e.signal_count > 0 && (
                            <Chip tone={SEVERITY_TONE.medium}>
                              {e.signal_count} live signal{e.signal_count > 1 ? 's' : ''}
                            </Chip>
                          )}
                          <span className="ml-auto text-xs text-text-secondary">
                            {e.age_years !== null
                              ? `${e.age_years} yrs old`
                              : 'Install date missing'}
                            {e.life_used_pct !== null && `, ${e.life_used_pct}% of life used`}
                          </span>
                        </div>
                        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                          <div>
                            <dt className="text-text-secondary">Est. efficiency</dt>
                            <dd className="font-semibold text-text-primary">
                              {e.efficiency
                                ? `${e.efficiency.effective} ${e.efficiency.metric}`
                                : '-'}
                            </dd>
                            {e.efficiency && (
                              <dd className="text-text-secondary">
                                {e.efficiency.nominal} nominal, {e.efficiency_loss_pct}% lost
                              </dd>
                            )}
                          </div>
                          <div>
                            <dt className="text-text-secondary">Weather-driven load</dt>
                            <dd className="font-semibold text-text-primary">
                              {e.attributed_kwh !== null ? `${fmtNum(e.attributed_kwh)} kWh` : ''}
                              {e.attributed_therms !== null
                                ? ` ${fmtNum(e.attributed_therms)} therms`
                                : ''}
                              {e.attributed_kwh === null && e.attributed_therms === null ? '-' : ''}
                            </dd>
                            <dd className="text-text-secondary">
                              {fmtMoney(e.attributed_cost_cents)}/yr
                            </dd>
                          </div>
                          <div>
                            <dt className="text-text-secondary">Lost to age and service</dt>
                            <dd className="font-semibold text-warning-500">
                              {fmtMoney(e.waste_cost_cents)}/yr
                            </dd>
                            {e.maintenance_overdue_months > 0 && (
                              <dd className="text-text-secondary">
                                service {e.maintenance_overdue_months} mo overdue
                              </dd>
                            )}
                          </div>
                          <div>
                            <dt className="text-text-secondary">Failure risk</dt>
                            <dd className="font-semibold text-text-primary">
                              {e.failure_risk
                                ? `${Math.round(e.failure_risk.probability * 100)}% in ${e.failure_risk.horizon_days}d`
                                : 'None flagged'}
                            </dd>
                            {e.failure_risk && (
                              <dd className="text-text-secondary">{e.failure_risk.label}</dd>
                            )}
                            {e.measured_kwh_30d !== null && (
                              <dd className="text-text-secondary">
                                measured {fmtNum(e.measured_kwh_30d)} kWh / 30d
                              </dd>
                            )}
                          </div>
                        </dl>
                        {e.note && <p className="mt-2 text-[11px] text-text-secondary">{e.note}</p>}
                      </article>
                    ))}
                    <p className="text-[11px] text-text-secondary">
                      Loads are attributed from the weather response of the bills, not metered,
                      unless a measured value is shown. Connect telemetry on{' '}
                      <Link
                        to="/dashboard/equipment-health"
                        className="focus-ring rounded text-accent"
                      >
                        Equipment Health
                      </Link>{' '}
                      for measured impact.
                    </p>
                  </div>
                ))}

              {tab === 'upgrades' &&
                (report.opportunities.length === 0 ? (
                  <Empty>
                    No upgrade opportunities found yet. They appear once bills show a weather-driven
                    load and equipment ages are known.
                  </Empty>
                ) : (
                  <div className="space-y-3">
                    {report.portfolio.savings_cents && (
                      <div className="rounded-2xl border border-success-500/25 bg-success-500/5 p-4 text-sm text-text-primary">
                        All upgrades together: about{' '}
                        <strong>{fmtMoney(report.portfolio.savings_cents.expected)}/yr</strong> (
                        {fmtMoney(report.portfolio.savings_cents.low)} to{' '}
                        {fmtMoney(report.portfolio.savings_cents.high)}), already reduced by{' '}
                        {report.portfolio.overlap_discount_pct}% so overlapping measures are not
                        double counted.
                      </div>
                    )}
                    {report.opportunities.map((o) => (
                      <OpportunityCard
                        key={o.id}
                        o={o}
                        state={oppState(o)}
                        onCost={(v) =>
                          setOpp((s) => ({
                            ...s,
                            [o.id]: { ...oppState(o), ...(s[o.id] ?? {}), cost: v },
                          }))
                        }
                        onRun={() => void runOpportunity(o)}
                      />
                    ))}
                  </div>
                ))}

              {tab === 'forecast' &&
                (report.forecast.scenarios.length === 0 ? (
                  <Empty>Not enough billing history to forecast. Add bills on the Bills tab.</Empty>
                ) : (
                  <div className="space-y-4">
                    <section className="rounded-2xl border border-border bg-bg-secondary p-5">
                      <h2 className="mb-2 text-sm font-semibold text-text-primary">
                        Electric demand, next 12 months
                      </h2>
                      <ForecastChart scenarios={report.forecast.scenarios} />
                    </section>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {report.forecast.scenarios.map((s) => (
                        <Tile
                          key={s.key}
                          label={s.label}
                          value={
                            s.total_cost_cents !== null
                              ? fmtMoney(s.total_cost_cents)
                              : `${fmtNum(s.total_kwh)} kWh`
                          }
                          sub={`${fmtNum(s.total_kwh)} kWh${s.total_therms > 0 ? `, ${fmtNum(s.total_therms)} therms` : ''}`}
                          tone={s.key === 'upgraded' ? 'text-success-500' : undefined}
                        />
                      ))}
                    </div>
                    <p className="text-xs text-text-secondary">
                      Trend applied: {report.forecast.yoy_trend_pct >= 0 ? '+' : ''}
                      {report.forecast.yoy_trend_pct}% year over year. Prices grow {escalationPct}
                      %/yr.
                      {report.forecast.weather_risk_cents != null &&
                        report.forecast.weather_risk_cents > 0 && (
                          <>
                            {' '}
                            A year 1.5 C off normal moves the bill by about{' '}
                            {fmtMoney(report.forecast.weather_risk_cents)}.
                          </>
                        )}
                    </p>
                  </div>
                ))}
            </>
          )}
        </div>

        <p className="mt-6 flex items-center gap-1.5 text-[11px] text-text-secondary">
          <Gauge size={12} aria-hidden="true" />
          Advisory estimates from your bills and published program averages. Verify equipment
          nameplates and incentive terms before quoting.
        </p>
      </div>
    </DashboardLayout>
  );
}
