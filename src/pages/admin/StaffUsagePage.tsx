// /staff/usage — per-tenant AI + voice cost and margin (Vireek employees only).
// Data: staff_usage_report() RPC (20270412000000_staff_usage_report.sql), which re-checks profiles.is_staff
// server-side; this page sits behind <StaffRoute> as well.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, BarChart3, Download, Loader2, RefreshCw, Search, TriangleAlert as AlertTriangle } from 'lucide-react';
import { Header } from '@/components/Header';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { UsageCostChart } from '@/components/staff/UsageCostChart';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import { StaffUsageError, fetchUsageReport } from '@/lib/staffUsageApi';
import {
  DEFAULT_VOICE_COST_PER_MIN,
  PERIODS,
  buildDailyCosts,
  computeTenantEconomics,
  computeTotals,
  filterAndSort,
  formatMinutes,
  formatPct,
  formatUsd,
  paginate,
  periodWindow,
  tenantsToCsv,
  type Health,
  type HealthFilter,
  type PeriodKey,
  type SortDir,
  type SortKey,
  type TenantEconomics,
  type UsageReport,
} from '@/lib/staffUsage';

const PAGE_SIZE = 25;
const RATE_KEY = 'vireek-staff-voice-cost-per-min';

function SEO() {
  useSEO({
    title: 'Usage & Margin — Staff',
    description: 'Internal: per-tenant AI and voice cost and margin.',
    canonical: 'https://vireek.com/staff/usage',
  });
  return null;
}

const HEALTH_STYLE: Record<Health, string> = {
  healthy: 'bg-success-500/10 text-success-500',
  thin: 'bg-warning-500/10 text-warning-500',
  loss: 'bg-danger/10 text-danger',
  unpriced: 'bg-bg-tertiary text-text-secondary',
};
const HEALTH_LABEL: Record<Health, string> = { healthy: 'Healthy', thin: 'Thin', loss: 'Loss', unpriced: 'Unpriced' };

function readRate(): number {
  try {
    const v = Number(localStorage.getItem(RATE_KEY));
    return Number.isFinite(v) && v > 0 && v <= 5 ? v : DEFAULT_VOICE_COST_PER_MIN;
  } catch {
    return DEFAULT_VOICE_COST_PER_MIN;
  }
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' | 'good' }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums sm:text-3xl ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success-500' : 'text-text-primary'}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

function SortHeader({ label, k, sortKey, sortDir, onSort, align = 'right' }: { label: string; k: SortKey; sortKey: SortKey; sortDir: SortDir; onSort: (k: SortKey) => void; align?: 'left' | 'right' }) {
  const active = sortKey === k;
  return (
    <th scope="col" className={`px-4 py-3 ${align === 'right' ? 'text-right' : 'text-left'}`} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(k)} className={`focus-ring inline-flex items-center gap-1 rounded uppercase tracking-wide ${active ? 'text-text-primary' : ''}`}>
        {label}
        {active && (sortDir === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
      </button>
    </th>
  );
}

export function StaffUsagePage() {
  const { toast } = useToast();
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [rate, setRate] = useState<number>(() => readRate());
  const [rateInput, setRateInput] = useState<string>(() => String(readRate()));
  const [report, setReport] = useState<UsageReport | null>(null);
  const [win, setWin] = useState(() => periodWindow('30d'));
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const [query, setQuery] = useState('');
  const [health, setHealth] = useState<HealthFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('cost');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);

  // Noindex: internal page.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  const loadId = useRef(0);
  const load = useCallback(
    async (silent = false) => {
      const id = ++loadId.current;
      const w = periodWindow(period);
      if (silent) setRefreshing(true);
      else setState('loading');
      try {
        const r = await fetchUsageReport(w.start, w.end);
        if (id !== loadId.current) return;
        setReport(r);
        setWin(w);
        setPage(1);
        setState('ready');
      } catch (e) {
        if (id !== loadId.current) return;
        if (e instanceof StaffUsageError && e.forbidden) setState('forbidden');
        else if (silent && report) toast('Could not refresh usage data.', 'error');
        else {
          setErrorMsg(e instanceof Error ? e.message : 'Unknown error');
          setState('error');
        }
      } finally {
        if (id === loadId.current) setRefreshing(false);
      }
    },
    // `report` intentionally omitted: only used to decide the error style of a silent refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [period, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const commitRate = () => {
    const v = Number(rateInput);
    if (!Number.isFinite(v) || v <= 0 || v > 5) {
      toast('Voice cost must be between $0.01 and $5.00 per minute.', 'error');
      setRateInput(String(rate));
      return;
    }
    setRate(v);
    try {
      localStorage.setItem(RATE_KEY, String(v));
    } catch {
      /* storage unavailable: assumption still applies for this session */
    }
  };

  const economics = useMemo(() => (report ? report.tenants.map((t) => computeTenantEconomics(t, rate, win.days)) : []), [report, rate, win.days]);
  const totals = useMemo(() => computeTotals(economics, report?.unattributed_cost_usd ?? 0), [economics, report]);
  const daily = useMemo(() => (report ? buildDailyCosts(report.daily, win.start, win.end, rate) : []), [report, win, rate]);
  const filtered = useMemo(() => filterAndSort(economics, { query, health, sortKey, sortDir }), [economics, query, health, sortKey, sortDir]);
  const paged = useMemo(() => paginate(filtered, page, PAGE_SIZE), [filtered, page]);

  const onSort = (k: SortKey) => {
    setPage(1);
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir(k === 'name' || k === 'plan' ? 'asc' : 'desc');
    }
  };

  const exportCsv = () => {
    const blob = new Blob([tenantsToCsv(filtered)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vireek-usage-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 className="text-accent" size={22} aria-hidden="true" />
                <h1 className="text-2xl font-bold tracking-tight text-text-primary">Usage &amp; margin</h1>
              </div>
              <p className="mt-1 text-sm text-text-secondary">AI and voice cost versus plan revenue for every tenant. All figures are estimates.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div role="radiogroup" aria-label="Period" className="inline-flex rounded-xl border border-border bg-bg-secondary p-1">
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    role="radio"
                    aria-checked={period === p.key}
                    onClick={() => setPeriod(p.key)}
                    className={`focus-ring min-h-[36px] rounded-lg px-3 text-sm font-medium transition-colors ${period === p.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={refreshing || state === 'loading'} aria-label="Refresh data">
                <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
              </Button>
            </div>
          </div>

          {state === 'loading' && (
            <div className="mt-8 space-y-6" role="status" aria-label="Loading usage data">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-28 rounded-2xl" />
                ))}
              </div>
              <Skeleton className="h-64 rounded-2xl" />
              <Skeleton className="h-80 rounded-2xl" />
            </div>
          )}

          {state === 'forbidden' && (
            <div className="mt-8">
              <EmptyState icon={AlertTriangle} title="Staff access required" description="Your account is not marked as Vireek staff, so the usage report is not available." />
            </div>
          )}

          {state === 'error' && (
            <div className="mt-8">
              <EmptyStateError icon={BarChart3} title="Couldn't load usage" description={errorMsg || "We couldn't load this data. Please try again."} onRetry={() => void load()} />
            </div>
          )}

          {state === 'ready' && report && (
            <div className="mt-8 space-y-6">
              {economics.length === 0 ? (
                <EmptyState icon={BarChart3} title="No tenants yet" description="Once tenant accounts exist, their AI and voice costs appear here." />
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <Kpi label="Est. revenue" value={formatUsd(totals.revenueUsd, { compact: true })} sub={`${totals.tenants} tenants · ${totals.unpricedTenants} unpriced (custom/unknown plan)`} />
                    <Kpi label="AI cost" value={formatUsd(totals.aiCostUsd, { compact: true })} sub={`${totals.aiCalls.toLocaleString()} calls · ${totals.aiCalls ? formatPct((totals.aiFailed / totals.aiCalls) * 100) : '0%'} failed`} />
                    <Kpi label="Voice cost" value={formatUsd(totals.voiceCostUsd, { compact: true })} sub={`${formatMinutes(totals.voiceMinutes)} at $${rate.toFixed(2)}/min`} />
                    <Kpi
                      label="Gross margin (priced tenants)"
                      value={formatPct(totals.marginPct)}
                      tone={totals.marginPct === null ? undefined : totals.marginPct < 0 ? 'bad' : 'good'}
                      sub={`${formatUsd(totals.marginUsd, { compact: true })} · ${totals.lossMakers} loss-making, ${totals.thin} thin`}
                    />
                  </div>

                  <div className="flex flex-wrap items-end gap-4 rounded-2xl border border-border bg-bg-secondary p-4">
                    <label className="block">
                      <span className="mb-1.5 block text-sm font-medium text-text-primary">Voice cost per minute (assumption)</span>
                      <span className="flex items-center gap-2">
                        <span className="text-text-secondary" aria-hidden="true">$</span>
                        <input
                          inputMode="decimal"
                          value={rateInput}
                          onChange={(e) => setRateInput(e.target.value)}
                          onBlur={commitRate}
                          onKeyDown={(e) => e.key === 'Enter' && commitRate()}
                          className="focus-ring w-28 rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-base text-text-primary focus-visible:border-accent"
                        />
                      </span>
                    </label>
                    <p className="min-w-[220px] flex-1 text-xs text-text-secondary">
                      Voice cost isn't stored per call, so it's call minutes × this blended telephony + STT/TTS rate. AI cost is list-price math from ai_usage_logs. Revenue is the plan's list price (prorated) plus metered overage.
                    </p>
                  </div>

                  {report.truncated && (
                    <p className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-warning-500" role="alert">
                      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> More than 5,000 tenants matched; showing the 5,000 with the highest AI cost. Totals cover only those.
                    </p>
                  )}
                  {report.unattributed_cost_usd > 0 && (
                    <p className="text-xs text-text-secondary">
                      Plus {formatUsd(report.unattributed_cost_usd)} of AI cost not attributed to any tenant (platform-internal or deleted accounts) — excluded from tenant margins.
                    </p>
                  )}

                  <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Daily cost">
                    <h2 className="mb-3 text-base font-semibold text-text-primary">Daily cost</h2>
                    <UsageCostChart points={daily} />
                  </section>

                  <section aria-label="Tenants">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                      <h2 className="text-base font-semibold text-text-primary">Tenants ({filtered.length})</h2>
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="relative block">
                          <span className="sr-only">Search tenants</span>
                          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
                          <input
                            type="search"
                            value={query}
                            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                            placeholder="Search name, email or ID"
                            className="focus-ring w-56 rounded-xl border border-border bg-bg-primary py-2.5 pl-9 pr-3 text-sm text-text-primary focus-visible:border-accent"
                          />
                        </label>
                        <label>
                          <span className="sr-only">Filter by health</span>
                          <select
                            value={health}
                            onChange={(e) => { setHealth(e.target.value as HealthFilter); setPage(1); }}
                            className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus-visible:border-accent"
                          >
                            <option value="all">All health</option>
                            <option value="loss">Loss-making</option>
                            <option value="thin">Thin margin</option>
                            <option value="healthy">Healthy</option>
                            <option value="unpriced">Unpriced</option>
                          </select>
                        </label>
                        <Button variant="secondary" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
                          <Download size={15} aria-hidden="true" /> CSV
                        </Button>
                      </div>
                    </div>

                    {filtered.length === 0 ? (
                      <EmptyState icon={Search} title="No tenants match" description="Try a different search or health filter." action={{ label: 'Clear filters', onClick: () => { setQuery(''); setHealth('all'); } }} />
                    ) : (
                      <>
                        {/* Desktop table */}
                        <div className="hidden overflow-x-auto rounded-2xl border border-border md:block">
                          <table className="w-full text-left text-sm">
                            <thead className="border-b border-border bg-bg-tertiary/50 text-xs font-semibold text-text-secondary">
                              <tr>
                                <SortHeader label="Tenant" k="name" align="left" {...{ sortKey, sortDir, onSort }} />
                                <SortHeader label="Plan" k="plan" align="left" {...{ sortKey, sortDir, onSort }} />
                                <SortHeader label="Revenue" k="revenue" {...{ sortKey, sortDir, onSort }} />
                                <SortHeader label="AI" k="ai" {...{ sortKey, sortDir, onSort }} />
                                <SortHeader label="Voice" k="voice" {...{ sortKey, sortDir, onSort }} />
                                <SortHeader label="Cost" k="cost" {...{ sortKey, sortDir, onSort }} />
                                <SortHeader label="Margin" k="margin" {...{ sortKey, sortDir, onSort }} />
                                <SortHeader label="%" k="marginPct" {...{ sortKey, sortDir, onSort }} />
                                <th scope="col" className="px-4 py-3 text-left">Health</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border tabular-nums">
                              {paged.items.map((t) => (
                                <tr key={t.account_id}>
                                  <td className="max-w-[220px] px-4 py-3">
                                    <p className="truncate font-medium text-text-primary">{t.company_name?.trim() || t.email || t.account_id.slice(0, 8)}</p>
                                    {t.company_name && t.email && <p className="truncate text-xs text-text-secondary">{t.email}</p>}
                                  </td>
                                  <td className="px-4 py-3 text-text-secondary">{t.planName}</td>
                                  <td className="px-4 py-3 text-right">{formatUsd(t.revenueUsd)}</td>
                                  <td className="px-4 py-3 text-right" title={`${t.ai_calls} calls, ${t.ai_failed} failed`}>{formatUsd(t.ai_cost_usd)}</td>
                                  <td className="px-4 py-3 text-right" title={formatMinutes(t.voiceMinutes)}>{formatUsd(t.voiceCostUsd)}</td>
                                  <td className="px-4 py-3 text-right font-medium text-text-primary">{formatUsd(t.totalCostUsd)}</td>
                                  <td className={`px-4 py-3 text-right ${t.marginUsd !== null && t.marginUsd < 0 ? 'text-danger' : ''}`}>{formatUsd(t.marginUsd)}</td>
                                  <td className="px-4 py-3 text-right">{formatPct(t.marginPct)}</td>
                                  <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${HEALTH_STYLE[t.health]}`}>{HEALTH_LABEL[t.health]}</span></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Mobile cards */}
                        <ul className="space-y-3 md:hidden">
                          {paged.items.map((t: TenantEconomics) => (
                            <li key={t.account_id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate font-medium text-text-primary">{t.company_name?.trim() || t.email || t.account_id.slice(0, 8)}</p>
                                  <p className="text-xs text-text-secondary">{t.planName}</p>
                                </div>
                                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${HEALTH_STYLE[t.health]}`}>{HEALTH_LABEL[t.health]}</span>
                              </div>
                              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
                                <dt className="text-text-secondary">Revenue</dt><dd className="text-right">{formatUsd(t.revenueUsd)}</dd>
                                <dt className="text-text-secondary">AI</dt><dd className="text-right">{formatUsd(t.ai_cost_usd)}</dd>
                                <dt className="text-text-secondary">Voice</dt><dd className="text-right">{formatUsd(t.voiceCostUsd)}</dd>
                                <dt className="text-text-secondary">Margin</dt><dd className={`text-right font-medium ${t.marginUsd !== null && t.marginUsd < 0 ? 'text-danger' : ''}`}>{formatUsd(t.marginUsd)} ({formatPct(t.marginPct)})</dd>
                              </dl>
                            </li>
                          ))}
                        </ul>

                        {paged.pages > 1 && (
                          <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Pagination">
                            <Button variant="secondary" size="sm" disabled={paged.page <= 1} onClick={() => setPage(paged.page - 1)}>Previous</Button>
                            <span className="text-sm text-text-secondary">Page {paged.page} of {paged.pages}</span>
                            <Button variant="secondary" size="sm" disabled={paged.page >= paged.pages} onClick={() => setPage(paged.page + 1)}>Next</Button>
                          </nav>
                        )}
                      </>
                    )}
                  </section>

                  <div className="grid gap-6 lg:grid-cols-2">
                    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Cost by provider and model">
                      <h2 className="mb-3 text-base font-semibold text-text-primary">By provider &amp; model</h2>
                      {report.providers.length === 0 ? (
                        <p className="text-sm text-text-secondary">No AI calls in this period.</p>
                      ) : (
                        <ul className="divide-y divide-border text-sm">
                          {report.providers.slice(0, 10).map((p) => (
                            <li key={`${p.provider}/${p.model}`} className="flex items-center justify-between gap-3 py-2.5">
                              <span className="min-w-0">
                                <span className="block truncate text-text-primary">{p.provider} · {p.model}</span>
                                <span className="block text-xs text-text-secondary">
                                  {p.calls.toLocaleString()} calls · {((p.input_tokens + p.output_tokens) / 1000).toFixed(0)}k tokens · {p.calls ? formatPct((p.failed / p.calls) * 100) : '0%'} failed · {p.calls ? formatPct((p.fallbacks / p.calls) * 100) : '0%'} fallback
                                </span>
                              </span>
                              <strong className="shrink-0 tabular-nums text-text-primary">{formatUsd(p.cost_usd)}</strong>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Cost by task">
                      <h2 className="mb-3 text-base font-semibold text-text-primary">By task</h2>
                      {report.tasks.length === 0 ? (
                        <p className="text-sm text-text-secondary">No AI calls in this period.</p>
                      ) : (
                        <ul className="space-y-2.5 text-sm">
                          {report.tasks.slice(0, 10).map((t) => {
                            const top = report.tasks[0].cost_usd || 1;
                            return (
                              <li key={t.task}>
                                <div className="flex justify-between gap-3">
                                  <span className="truncate text-text-primary">{t.task}</span>
                                  <span className="shrink-0 tabular-nums text-text-secondary">{formatUsd(t.cost_usd)} · {t.calls.toLocaleString()}</span>
                                </div>
                                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden="true">
                                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, (t.cost_usd / top) * 100)}%` }} />
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  </div>
                </>
              )}
            </div>
          )}

          {refreshing && state === 'ready' && (
            <span className="sr-only" role="status">
              <Loader2 aria-hidden="true" /> Refreshing
            </span>
          )}
        </div>
      </main>
    </>
  );
}
