/**
 * Parts Intelligence — /dashboard/parts-intelligence
 *
 * Extends AI Parts Market. One place to answer, for any part:
 *   fits what? · what can replace it? · does it fail? · is the price fair? · is it in stock? ·
 *   where do we buy it? · how much will we need? · is there a recall?
 *
 * Owns no data. Reads Inventory, Parts Market, OEM Intelligence, Failure Genome and Supply Chain
 * Outcomes through the existing modules. All maths lives in src/lib/partsIntelligence.ts (pure,
 * unit-tested); this file is presentation + orchestration only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  ExternalLink,
  PackageSearch,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { formatCents } from '@/lib/priceBook';
import {
  evaluateMarket,
  executeOption,
  fetchMarketParts,
  formatAge,
  formatEta,
  recordDecision,
  resolveDecision,
  subscribeToMarket,
} from '@/lib/partsMarket';
import type { MarketInput, MarketPart } from '@/lib/partsMarket';
import {
  TIER_ORDER,
  analyzePricing,
  buildFailureIndex,
  forecastDemand,
  patternsForPart,
  rankSubstitutes,
  recallSignal,
  scoreOverviewRow,
  scoreRisk,
  summarizeFailureHistory,
  summarizeSuppliers,
} from '@/lib/partsIntelligence';
import type {
  DemandForecast,
  DemandPattern,
  InstallOutcomeRow,
  PartFailureEvent,
  PiDetail,
  PiOverviewRow,
  PriceSignal,
  RiskScore,
  RiskTier,
  Severity,
  StockRisk,
} from '@/lib/partsIntelligence';
import {
  fetchInstallOutcomes,
  fetchPartDetail,
  fetchPartsOverview,
  fetchPopulationPatterns,
  fetchRecentPartFailureEvents,
  fetchSourcingInput,
} from '@/lib/partsIntelligenceApi';
import type { ExposureRow } from '@/lib/failureGenome';

// ============================================================
// STATIC UI MAPS
// ============================================================

type TabKey = 'summary' | 'fit' | 'failures' | 'price' | 'stock' | 'demand' | 'recalls';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'fit', label: 'Fit & substitutes' },
  { key: 'failures', label: 'Failure history' },
  { key: 'price', label: 'Pricing' },
  { key: 'stock', label: 'Stock & sourcing' },
  { key: 'demand', label: 'Demand forecast' },
  { key: 'recalls', label: 'Recalls' },
];

const TIER_STYLE: Record<RiskTier, string> = {
  critical: 'bg-rose-100 text-rose-800 dark:bg-rose-500/10 dark:text-rose-400',
  high: 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-400',
  watch: 'bg-sky-100 text-sky-800 dark:bg-sky-500/10 dark:text-sky-400',
  healthy: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400',
};
const TIER_LABEL: Record<RiskTier, string> = { critical: 'Critical', high: 'High', watch: 'Watch', healthy: 'Healthy' };
const SEV_STYLE: Record<Severity, string> = {
  critical: TIER_STYLE.critical,
  high: TIER_STYLE.high,
  medium: TIER_STYLE.watch,
  low: 'bg-bg-tertiary text-text-secondary',
};
const PRICE_LABEL: Record<PriceSignal, string> = {
  no_data: 'No fresh quotes',
  buy_window: 'Buy window',
  fair: 'Fair price',
  elevated: 'Elevated',
  spiking: 'Spiking',
};
const PRICE_STYLE: Record<PriceSignal, string> = {
  no_data: 'bg-bg-tertiary text-text-secondary',
  buy_window: TIER_STYLE.healthy,
  fair: TIER_STYLE.watch,
  elevated: TIER_STYLE.high,
  spiking: TIER_STYLE.critical,
};
const PATTERN_LABEL: Record<DemandPattern, string> = {
  none: 'No usage',
  insufficient: 'Too little data',
  smooth: 'Steady',
  erratic: 'Erratic',
  intermittent: 'Intermittent',
  lumpy: 'Lumpy',
};
const STOCK_LABEL: Record<StockRisk, string> = { critical: 'Stock-out risk', high: 'Low stock', watch: 'Watch', ok: 'OK' };

const chip = 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold';
const panel = 'rounded-2xl border border-border bg-bg-secondary p-4';
const subtle = 'text-xs text-text-secondary';

interface ScoredRow {
  row: PiOverviewRow;
  forecast: DemandForecast;
  risk: RiskScore;
  failures12m: number;
}

// ============================================================
// SMALL PRESENTATION HELPERS
// ============================================================

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-lg font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function Block({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className={panel}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Weekly bars: history (muted) followed by forecast (accent). Pure CSS, no chart dependency. */
function Bars({ history, forecast }: { history: number[]; forecast: number[] }) {
  const all = [...history, ...forecast];
  const max = Math.max(1, ...all);
  return (
    <div className="flex h-28 items-end gap-1" role="img" aria-label="Weekly usage and forecast">
      {all.map((v, i) => {
        const isForecast = i >= history.length;
        return (
          <div key={i} className="flex h-full flex-1 flex-col justify-end" title={`${isForecast ? 'Forecast' : 'Actual'}: ${v}`}>
            <div
              className={`w-full rounded-t ${isForecast ? 'bg-accent/60' : 'bg-text-secondary/40'}`}
              style={{ height: `${Math.max(v > 0 ? 6 : 2, (v / max) * 100)}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <p className={subtle}>Not enough price observations to draw a trend.</p>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label="Price history">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="text-accent" />
    </svg>
  );
}

const pctText = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v}%`);

// ============================================================
// PAGE
// ============================================================

export function PartsIntelligencePage() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('part');

  const [overview, setOverview] = useState<PiOverviewRow[]>([]);
  const [marketParts, setMarketParts] = useState<MarketPart[]>([]);
  const [events, setEvents] = useState<PartFailureEvent[]>([]);
  const [patterns, setPatterns] = useState<ExposureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);

  const [query, setQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<'all' | RiskTier>('all');
  const [recallOnly, setRecallOnly] = useState(false);
  const [limit, setLimit] = useState(100);

  const [tab, setTab] = useState<TabKey>('summary');
  const [detail, setDetail] = useState<PiDetail | null>(null);
  const [installs, setInstalls] = useState<InstallOutcomeRow[]>([]);
  const [marketInput, setMarketInput] = useState<MarketInput | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [qty, setQty] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  // ---------- portfolio load (also re-runs on realtime ticks) ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rows, parts, ev, pat] = await Promise.all([
          fetchPartsOverview(),
          fetchMarketParts(),
          fetchRecentPartFailureEvents().catch(() => [] as PartFailureEvent[]),
          fetchPopulationPatterns(),
        ]);
        if (cancelled) return;
        setOverview(rows);
        setMarketParts(parts);
        setEvents(ev);
        setPatterns(pat);
        setLoadError(null);
        setUpdatedAt(new Date());
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load Parts Intelligence');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => subscribeToMarket(() => setTick((t) => t + 1)), []);

  // ---------- scored portfolio ----------
  const failureIndex = useMemo(() => buildFailureIndex(events), [events]);
  const scored = useMemo<ScoredRow[]>(() => {
    const now = new Date();
    const cutoff = now.getTime() - 365 * 86_400_000;
    return overview
      .map((row) => {
        const { forecast, risk } = scoreOverviewRow(row, now);
        const failures12m = failureIndex(row).filter((e) => new Date(e.occurred_on).getTime() >= cutoff).length;
        return { row, forecast, risk, failures12m };
      })
      .sort(
        (a, b) =>
          TIER_ORDER[a.risk.tier] - TIER_ORDER[b.risk.tier] || b.risk.score - a.risk.score || a.row.name.localeCompare(b.row.name),
      );
  }, [overview, failureIndex]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scored.filter(
      (s) =>
        (tierFilter === 'all' || s.risk.tier === tierFilter) &&
        (!recallOnly || s.row.recall_count > 0) &&
        (!q || s.row.name.toLowerCase().includes(q) || (s.row.part_number ?? '').toLowerCase().includes(q) || (s.row.category ?? '').toLowerCase().includes(q)),
    );
  }, [scored, query, tierFilter, recallOnly]);

  const kpis = useMemo(() => {
    const withPn = overview.filter((r) => r.part_number).length;
    return {
      atRisk: scored.filter((s) => s.risk.tier === 'critical' || s.risk.tier === 'high').length,
      recalls: overview.filter((r) => r.recall_count > 0).length,
      lowCover: scored.filter((s) => s.forecast.daysOfCover !== null && s.forecast.daysOfCover < 14).length,
      oemCoverage: withPn ? Math.round((overview.filter((r) => r.oem_matched).length / withPn) * 100) : null,
    };
  }, [scored, overview]);

  const selected = useMemo(() => scored.find((s) => s.row.part_id === selectedId) ?? null, [scored, selectedId]);

  // ---------- detail load ----------
  const selectedPart = selected?.row.part_id ?? null;
  useEffect(() => {
    if (!selectedPart) {
      setDetail(null);
      setInstalls([]);
      setMarketInput(null);
      return;
    }
    const part = marketParts.find((p) => p.id === selectedPart);
    const myRequest = ++requestRef.current;
    setDetailLoading(true);
    setDetailError(null);
    (async () => {
      try {
        const [d, inst, input] = await Promise.all([
          fetchPartDetail(selectedPart),
          fetchInstallOutcomes(selectedPart).catch(() => [] as InstallOutcomeRow[]),
          part ? fetchSourcingInput(part, marketParts) : Promise.resolve(null),
        ]);
        if (requestRef.current !== myRequest) return; // a newer selection superseded this one
        setDetail(d);
        setInstalls(inst);
        setMarketInput(input);
      } catch (e) {
        if (requestRef.current === myRequest) setDetailError(e instanceof Error ? e.message : 'Could not load this part');
      } finally {
        if (requestRef.current === myRequest) setDetailLoading(false);
      }
    })();
  }, [selectedPart, marketParts, tick]);

  useEffect(() => setQty(null), [selectedPart]);

  const choose = useCallback(
    (id: string) => {
      setParams({ part: id }, { replace: true });
      setTab('summary');
      if (typeof window !== 'undefined' && window.innerWidth < 1280) {
        requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    },
    [setParams],
  );

  // ---------- derived intelligence for the selected part ----------
  const intel = useMemo(() => {
    if (!selected) return null;
    const { row } = selected;
    const partRef = { name: row.name, part_number: row.part_number };
    const partOffers = marketInput?.offers.filter((o) => o.part_id === row.part_id) ?? [];
    const partHistory = marketInput?.priceHistory.filter((h) => h.part_id === row.part_id) ?? [];
    const oemPrices = (detail?.oem_parts ?? []).map((o) => o.avg_price_cents).filter((v): v is number => v !== null);
    const oemAvg = oemPrices.length ? Math.round(oemPrices.reduce((a, b) => a + b, 0) / oemPrices.length) : null;
    const pricing = analyzePricing({ offers: partOffers, history: partHistory, ownUnitCostCents: row.unit_cost_cents, oemAvgPriceCents: oemAvg });

    // Lead time = the fastest external source we could actually buy from, else 5 days.
    const fastest = marketInput
      ? Math.min(...partOffers.filter((o) => o.source_active && !o.is_expired && o.eta_minutes !== null).map((o) => o.eta_minutes as number), Infinity)
      : Infinity;
    const leadTimeDays = Number.isFinite(fastest) ? Math.min(30, Math.max(1, Math.ceil(fastest / 1440))) : 5;
    const forecast = forecastDemand({
      weekly: row.weekly_usage,
      scheduled30d: row.scheduled_30d,
      available: row.available,
      reorderPoint: row.reorder_point,
      reorderQuantity: row.reorder_quantity,
      leadTimeDays,
    });

    const decision =
      marketInput && partOffers.length + marketInput.availability.length > 0
        ? evaluateMarket(marketInput, {
            quantity: Math.max(1, Math.round(qty ?? (forecast.suggestedOrderQty || 1))),
            deadline: null,
            technicianId: null,
            allowSubstitutes: true,
          })
        : null;

    const recall = recallSignal(detail);
    const failureEvents = failureIndex(partRef);
    const failureSummary = summarizeFailureHistory(failureEvents);
    const matchedPatterns = patternsForPart(partRef, patterns.map((p) => ({ ...p.pattern, my_units: p.my_units })));
    const suppliers = summarizeSuppliers(installs);
    const referenceCents = pricing.bestCents ?? (row.unit_cost_cents || null);
    const substitutes = rankSubstitutes(detail?.substitutes ?? [], referenceCents);
    const worst = suppliers.filter((s) => s.successes + s.failures >= 3).sort((a, b) => (a.confidentRatePct ?? 100) - (b.confidentRatePct ?? 100))[0];

    const risk = scoreRisk({
      maxRecallSeverity: recall.level === 'none' ? (detail?.issues.length ? 'low' : null) : recall.level,
      hasRecall: recall.partLinkedRecalls > 0,
      stockRisk: forecast.stockRisk,
      daysOfCover: forecast.daysOfCover,
      hasInStockSubstitute: substitutes.some((s) => s.inStock),
      hasSubstitutes: substitutes.length > 0,
      emergingPatterns: matchedPatterns.filter((p) => p.status === 'emerging').length,
      elevatedPatterns: matchedPatterns.filter((p) => p.status === 'elevated').length,
      failureTrend: failureSummary.total >= 3 ? failureSummary.trend : null,
      priceSignal: pricing.signal,
      worstSupplierConfidentPct: worst?.confidentRatePct ?? null,
      supplierSampleSize: worst ? worst.successes + worst.failures : 0,
    });

    return { pricing, forecast, decision, recall, failureEvents, failureSummary, matchedPatterns, suppliers, substitutes, risk, oemAvg, partOffers, partHistory };
  }, [selected, marketInput, detail, installs, patterns, failureIndex, qty]);

  // ---------- action: turn the recommendation into a purchase request (existing flow) ----------
  const orderRecommended = async () => {
    const option = intel?.decision?.recommended;
    if (!selected || !intel?.decision || !option) return;
    setWorking(true);
    try {
      const logged = await recordDecision({ partId: selected.row.part_id, jobId: null, decision: intel.decision });
      const msg = await executeOption({ option, quantity: intel.decision.quantity, jobId: null, neededBy: null, destinationLocationId: null });
      if (logged) await resolveDecision(logged.id, 'accepted', { action: option.action, label: option.label });
      toast(msg, 'success');
      setTick((t) => t + 1);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the purchase request', 'error');
    } finally {
      setWorking(false);
    }
  };

  // ============================================================
  // RENDER
  // ============================================================

  return (
    <DashboardLayout activeLabel="Parts Intelligence">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <PackageSearch size={22} /> Parts Intelligence
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Fit, substitutes, failure history, pricing, stock, sourcing, demand and recall signals for every part — built from your
              Inventory, Parts Market, OEM, Failure Genome and Supply Chain data.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary">
              <Radio size={12} className="text-emerald-500" />
              Live{updatedAt ? ` · ${updatedAt.toLocaleTimeString()}` : ''}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setTick((t) => t + 1)} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
            </Button>
            <Link to="/dashboard/parts-market" className="focus-ring inline-flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-semibold text-accent hover:underline">
              Parts Market <ArrowRight size={14} />
            </Link>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonTable rows={8} columns={6} />
          </div>
        ) : loadError ? (
          <EmptyState
            icon={AlertTriangle}
            title="Parts Intelligence is not available yet"
            description={`${loadError}. If this is a new install, apply the 20270601000000_parts_intelligence migration, then refresh.`}
            action={{ label: 'Try again', onClick: () => setTick((t) => t + 1) }}
          />
        ) : overview.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title="Add parts to see intelligence"
            description="Create parts in Inventory (with part numbers for OEM matching) and this page lights up automatically."
          />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="High-risk parts" value={kpis.atRisk} hint="Critical or high tier" />
              <Stat label="Recall-linked parts" value={kpis.recalls} hint="OEM issue with a recall" />
              <Stat label="Under 14 days of cover" value={kpis.lowCover} hint="At forecast demand" />
              <Stat label="OEM-matched" value={kpis.oemCoverage === null ? '—' : `${kpis.oemCoverage}%`} hint="Of parts that have a part number" />
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
              {/* ================= LEFT: portfolio ================= */}
              <div className="min-w-0">
                <div className="mb-3 flex flex-wrap items-end gap-2">
                  <div className="min-w-[180px] flex-1">
                    <Input
                      aria-label="Search parts"
                      placeholder="Search name, part number, category"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setLimit(100);
                      }}
                    />
                  </div>
                  <select
                    aria-label="Risk tier"
                    value={tierFilter}
                    onChange={(e) => setTierFilter(e.target.value as 'all' | RiskTier)}
                    className="focus-ring min-h-[48px] rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary"
                  >
                    <option value="all">All tiers</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="watch">Watch</option>
                    <option value="healthy">Healthy</option>
                  </select>
                  <label className="flex min-h-[48px] items-center gap-2 text-sm text-text-secondary">
                    <input type="checkbox" checked={recallOnly} onChange={(e) => setRecallOnly(e.target.checked)} className="h-4 w-4 accent-[var(--accent,#2563eb)]" />
                    Recalls only
                  </label>
                </div>

                {filtered.length === 0 ? (
                  <EmptyState icon={Search} title="Nothing matches these filters" description="Clear the search or tier filter to see all parts." />
                ) : (
                  <div className="overflow-x-auto rounded-2xl border border-border">
                    <table className="w-full min-w-[640px] text-left text-xs">
                      <thead className="bg-bg-tertiary text-[11px] uppercase tracking-wide text-text-secondary">
                        <tr>
                          <th className="px-3 py-2">Part</th>
                          <th className="px-2 py-2">Risk</th>
                          <th className="px-2 py-2 text-right">Avail.</th>
                          <th className="px-2 py-2 text-right">Cover</th>
                          <th className="px-2 py-2 text-right">30d need</th>
                          <th className="px-2 py-2 text-center">Recall</th>
                          <th className="px-2 py-2 text-right">Fits</th>
                          <th className="px-2 py-2 text-right">Fails 12m</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.slice(0, limit).map((s) => {
                          const active = s.row.part_id === selectedId;
                          return (
                            <tr
                              key={s.row.part_id}
                              onClick={() => choose(s.row.part_id)}
                              className={`cursor-pointer border-t border-border ${active ? 'bg-accent/10' : 'hover:bg-bg-tertiary'}`}
                            >
                              <td className="max-w-[220px] px-3 py-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    choose(s.row.part_id);
                                  }}
                                  aria-current={active}
                                  className="focus-ring block w-full truncate text-left font-semibold text-text-primary"
                                >
                                  {s.row.name}
                                </button>
                                <span className="block truncate text-[11px] text-text-secondary">{s.row.part_number ?? 'No part number'}</span>
                              </td>
                              <td className="px-2 py-2">
                                <span className={`${chip} ${TIER_STYLE[s.risk.tier]}`}>{TIER_LABEL[s.risk.tier]}</span>
                              </td>
                              <td className="px-2 py-2 text-right tabular-nums">{s.row.available}</td>
                              <td className="px-2 py-2 text-right tabular-nums">{s.forecast.daysOfCover === null ? '—' : `${Math.round(s.forecast.daysOfCover)}d`}</td>
                              <td className="px-2 py-2 text-right tabular-nums">{Math.round(s.forecast.expected30d)}</td>
                              <td className="px-2 py-2 text-center">
                                {s.row.recall_count > 0 ? <ShieldAlert size={14} className="mx-auto text-rose-500" aria-label="Recall linked" /> : '—'}
                              </td>
                              <td className="px-2 py-2 text-right tabular-nums">{s.row.compatible_units || '—'}</td>
                              <td className="px-2 py-2 text-right tabular-nums">{s.failures12m || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {filtered.length > limit && (
                  <div className="mt-3 flex justify-center">
                    <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + 100)}>
                      Show more ({filtered.length - limit} left)
                    </Button>
                  </div>
                )}
              </div>

              {/* ================= RIGHT: detail ================= */}
              <div ref={detailRef} className="min-w-0 scroll-mt-4">
                {!selected ? (
                  <EmptyState icon={PackageSearch} title="Pick a part" description="Select any part on the left to see its full intelligence." />
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="truncate text-lg font-bold text-text-primary">{selected.row.name}</h2>
                        <p className={subtle}>
                          {selected.row.part_number ?? 'No part number'}
                          {selected.row.category ? ` · ${selected.row.category}` : ''} · own cost {formatCents(selected.row.unit_cost_cents)}
                        </p>
                      </div>
                      {intel && (
                        <span className={`${chip} ${TIER_STYLE[intel.risk.tier]}`} title="Explainable risk score">
                          {TIER_LABEL[intel.risk.tier]} · {intel.risk.score}/100
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-1.5" role="tablist">
                      {TABS.map((t) => (
                        <button
                          key={t.key}
                          type="button"
                          role="tab"
                          aria-selected={tab === t.key}
                          onClick={() => setTab(t.key)}
                          className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium ${
                            tab === t.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>

                    {detailError ? (
                      <EmptyState icon={AlertTriangle} title="Could not load this part" description={detailError} action={{ label: 'Retry', onClick: () => setTick((t) => t + 1) }} />
                    ) : detailLoading && !detail ? (
                      <div className="space-y-3">
                        <SkeletonStatGrid count={3} />
                        <SkeletonTable rows={4} columns={3} />
                      </div>
                    ) : !intel ? null : (
                      <DetailTabs
                        tab={tab}
                        selected={selected}
                        detail={detail}
                        intel={intel}
                        marketInput={marketInput}
                        qty={qty}
                        setQty={setQty}
                        working={working}
                        onOrder={orderRecommended}
                        patternsCount={patterns.length}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// DETAIL TABS
// ============================================================

type Intel = NonNullable<ReturnType<typeof useIntelType>>;
// Type-only helper so DetailTabs can reuse the exact memo shape without duplicating it.
declare function useIntelType(): ReturnType<typeof buildIntelShape> | null;
declare function buildIntelShape(): {
  pricing: ReturnType<typeof analyzePricing>;
  forecast: DemandForecast;
  decision: ReturnType<typeof evaluateMarket> | null;
  recall: ReturnType<typeof recallSignal>;
  failureEvents: PartFailureEvent[];
  failureSummary: ReturnType<typeof summarizeFailureHistory>;
  matchedPatterns: (ExposureRow['pattern'] & { my_units: number })[];
  suppliers: ReturnType<typeof summarizeSuppliers>;
  substitutes: ReturnType<typeof rankSubstitutes>;
  risk: RiskScore;
  oemAvg: number | null;
  partOffers: MarketInput['offers'];
  partHistory: MarketInput['priceHistory'];
};

interface DetailTabsProps {
  tab: TabKey;
  selected: ScoredRow;
  detail: PiDetail | null;
  intel: Intel;
  marketInput: MarketInput | null;
  qty: number | null;
  setQty: (n: number | null) => void;
  working: boolean;
  onOrder: () => void;
  patternsCount: number;
}

function DetailTabs({ tab, selected, detail, intel, marketInput, qty, setQty, working, onOrder, patternsCount }: DetailTabsProps) {
  const { row } = selected;
  const f = intel.forecast;
  const rec = intel.decision?.recommended ?? null;
  const canOrder = !!rec && (rec.action === 'buy_vendor' || rec.action === 'buy_distributor');
  const orderQty = Math.max(1, Math.round(qty ?? (f.suggestedOrderQty || 1)));

  // ---------------- SUMMARY ----------------
  if (tab === 'summary') {
    const actions: string[] = [];
    if (intel.recall.partLinkedRecalls > 0 && intel.recall.affectedUnits > 0)
      actions.push(`Check the ${intel.recall.affectedUnits} unit(s) this part fits against the linked recall before the next install.`);
    if (f.stockRisk === 'critical' || f.stockRisk === 'high')
      actions.push(f.suggestedOrderQty > 0 ? `Order about ${f.suggestedOrderQty} unit(s) — ${f.daysOfCover === null ? 'stock is below the reorder point' : `only ${Math.round(f.daysOfCover)} day(s) of cover`}.` : 'Stock is low — review reorder settings.');
    if (intel.pricing.signal === 'buy_window' && f.stockRisk !== 'ok') actions.push('Prices are below their 30-day median — a good moment to buy.');
    if (intel.pricing.signal === 'spiking') actions.push('Best quote is spiking. Check substitutes or wait for a fresh quote if you can.');
    if (intel.matchedPatterns.some((p) => p.status === 'emerging')) actions.push('An emerging failure pattern in the network involves this part — consider stocking extra.');
    if (!row.part_number) actions.push('Add a part number in Inventory to unlock OEM compatibility and recall matching.');
    return (
      <div className="space-y-4">
        <Block title="Recommended actions">
          {actions.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing needs attention right now.</p>
          ) : (
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-text-primary">{actions.map((a) => <li key={a}>{a}</li>)}</ul>
          )}
          {canOrder && rec && f.suggestedOrderQty > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={onOrder} disabled={working}>
                Create purchase request · {rec.label}
              </Button>
              <span className={subtle}>{formatCents(rec.unitPriceCents)}/unit · ETA {formatEta(rec.etaMinutes)} · logged in the Parts Market decision log</span>
            </div>
          )}
        </Block>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat label="Available" value={row.available} hint={`${row.on_hand} on hand`} />
          <Stat label="Cover" value={f.daysOfCover === null ? '—' : `${Math.round(f.daysOfCover)} d`} hint={STOCK_LABEL[f.stockRisk]} />
          <Stat label="30-day need" value={Math.round(f.expected30d)} hint={`${Math.round(f.low30d)}–${Math.round(f.high30d)} likely`} />
          <Stat label="Best price" value={intel.pricing.bestCents === null ? '—' : formatCents(intel.pricing.bestCents)} hint={PRICE_LABEL[intel.pricing.signal]} />
          <Stat label="Fits your units" value={row.compatible_units || '—'} hint={row.oem_matched ? 'OEM-matched' : 'No OEM match'} />
          <Stat label="Recall signal" value={intel.recall.level === 'none' ? 'None' : intel.recall.level} hint={intel.recall.headline} />
        </div>
        <Block title="Why this risk score">
          {intel.risk.factors.length === 0 ? (
            <p className="text-sm text-text-secondary">No risk factors detected.</p>
          ) : (
            <ul className="space-y-2">
              {intel.risk.factors.map((x, i) => (
                <li key={`${x.key}-${i}`} className="flex items-start justify-between gap-3 text-sm">
                  <span>
                    <span className="font-medium text-text-primary">{x.label}</span>
                    <span className="block text-xs text-text-secondary">{x.detail}</span>
                  </span>
                  <span className={`${chip} ${x.points > 0 ? TIER_STYLE.high : TIER_STYLE.healthy}`}>{x.points > 0 ? `+${x.points}` : x.points}</span>
                </li>
              ))}
            </ul>
          )}
        </Block>
      </div>
    );
  }

  // ---------------- FIT & SUBSTITUTES ----------------
  if (tab === 'fit') {
    const d = detail;
    return (
      <div className="space-y-4">
        <Block title="OEM compatibility">
          {!d?.has_part_number ? (
            <p className="text-sm text-text-secondary">This part has no part number, so it cannot be matched to OEM data. Add one in Inventory.</p>
          ) : d.oem_parts.length === 0 ? (
            <p className="text-sm text-text-secondary">No OEM catalogue entry has this part number yet. Matching is exact (ignoring case, spaces and dashes) — nothing is guessed.</p>
          ) : (
            <>
              <ul className="mb-3 space-y-1.5 text-sm">
                {d.oem_parts.slice(0, 8).map((o) => (
                  <li key={o.oem_part_id} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-text-primary">
                      {o.manufacturer} · {o.model_number ?? 'All models'} <span className="text-text-secondary">— {o.part_name}</span>
                    </span>
                    {o.avg_price_cents !== null && <span className={subtle}>OEM avg {formatCents(o.avg_price_cents)}</span>}
                  </li>
                ))}
              </ul>
              {d.models.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Models in your fleet</p>
                  <ul className="space-y-1 text-sm">
                    {d.models.slice(0, 10).map((m) => (
                      <li key={m.model_id} className="flex justify-between gap-2">
                        <span>{m.manufacturer} {m.model_number}</span>
                        <span className="tabular-nums text-text-secondary">{m.my_units} unit{m.my_units === 1 ? '' : 's'}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </Block>
        <Block title={`Your units this part fits (${d?.units.length ?? 0})`}>
          {!d || d.units.length === 0 ? (
            <p className="text-sm text-text-secondary">No active unit in your fleet is linked to a matching OEM model.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.units.slice(0, 10).map((u) => (
                <li key={u.equipment_id} className="flex flex-wrap justify-between gap-2">
                  <span>{[u.make, u.model].filter(Boolean).join(' ') || u.equipment_type || 'Unit'}</span>
                  <span className={subtle}>{u.customer_name ?? ''}{u.install_date ? ` · installed ${u.install_date.slice(0, 4)}` : ''}</span>
                </li>
              ))}
              {d.units.length > 10 && <li className={subtle}>+ {d.units.length - 10} more</li>}
            </ul>
          )}
        </Block>
        <Block title="Approved substitutes">
          {intel.substitutes.length === 0 ? (
            <p className="text-sm text-text-secondary">No substitute is approved for this part. Add one in Inventory to reduce stock-out risk.</p>
          ) : (
            <ul className="space-y-2">
              {intel.substitutes.map((s) => (
                <li key={s.part_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    <span className="font-medium text-text-primary">{s.name}</span>
                    <span className="block text-xs text-text-secondary">{s.part_number ?? 'No part number'}{s.note ? ` · ${s.note}` : ''}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`${chip} ${s.inStock ? TIER_STYLE.healthy : 'bg-bg-tertiary text-text-secondary'}`}>{s.inStock ? `${s.available} in stock` : 'Out of stock'}</span>
                    <span className="tabular-nums">{formatCents(s.effectiveCents)}</span>
                    {s.savingsCents !== null && s.savingsCents !== 0 && (
                      <span className={`text-xs ${s.savingsCents > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{s.savingsCents > 0 ? 'saves' : 'costs'} {formatCents(Math.abs(s.savingsCents))}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {d && d.substitute_for.length > 0 && (
            <p className="mt-3 text-xs text-text-secondary">This part can also stand in for: {d.substitute_for.map((s) => s.name).join(', ')}.</p>
          )}
        </Block>
      </div>
    );
  }

  // ---------------- FAILURE HISTORY ----------------
  if (tab === 'failures') {
    const s = intel.failureSummary;
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Failures logged" value={s.total} hint="Your account, all time" />
          <Stat label="Last 12 months" value={s.last12m} hint={`${s.prior12m} the year before · ${s.trend === 'up' ? 'rising' : s.trend === 'down' ? 'falling' : 'flat'}`} />
          <Stat label="Repeat rate" value={s.repeatRatePct === null ? '—' : `${s.repeatRatePct}%`} hint="Recurred or callback" />
          <Stat label="Typical age" value={s.avgAgeMonths === null ? '—' : `${s.avgAgeMonths} mo`} hint={s.avgRepairCost === null ? undefined : `avg repair ${s.avgRepairCost}`} />
        </div>
        <Block title="Where it fails" aside={<span className={subtle}>matched by part name / number</span>}>
          {s.total === 0 ? (
            <p className="text-sm text-text-secondary">No failure event names this part yet. Log failures in Failure Genome to build history.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <ul className="space-y-1 text-sm">
                {s.topComponents.map((c) => (
                  <li key={c.component} className="flex justify-between"><span>{c.component.replace(/_/g, ' ')}</span><span className="tabular-nums text-text-secondary">{c.count}</span></li>
                ))}
              </ul>
              <ul className="space-y-1 text-sm">
                {s.topModels.map((m) => (
                  <li key={m.model} className="flex justify-between"><span>{m.model}</span><span className="tabular-nums text-text-secondary">{m.count}</span></li>
                ))}
              </ul>
            </div>
          )}
        </Block>
        <Block title="Network patterns involving this part">
          {patternsCount === 0 ? (
            <p className="text-sm text-text-secondary">Network patterns appear once your business shares failure data with Failure Genome.</p>
          ) : intel.matchedPatterns.length === 0 ? (
            <p className="text-sm text-text-secondary">No network pattern on your models lists this part.</p>
          ) : (
            <ul className="space-y-2">
              {intel.matchedPatterns.slice(0, 6).map((p) => (
                <li key={`${p.model_key}-${p.failure_component}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    <span className="font-medium text-text-primary">{p.failure_component.replace(/_/g, ' ')}</span>
                    <span className="block text-xs text-text-secondary">{p.model_key.replace(/_/g, ' ')} · {p.my_units} of your unit(s) · {p.contributor_count} businesses</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {p.lift !== null && <span className={subtle}>{p.lift.toFixed(1)}× baseline</span>}
                    <span className={`${chip} ${p.status === 'emerging' ? TIER_STYLE.critical : p.status === 'elevated' ? TIER_STYLE.high : TIER_STYLE.watch}`}>{p.status}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Block>
        {intel.failureEvents.length > 0 && (
          <Block title="Recent events">
            <ul className="space-y-1.5 text-sm">
              {intel.failureEvents.slice(0, 6).map((e) => (
                <li key={e.id} className="flex flex-wrap justify-between gap-2">
                  <span>{e.occurred_on} · {e.failure_component.replace(/_/g, ' ')}</span>
                  <span className={subtle}>{[e.make, e.model].filter(Boolean).join(' ')} · {e.outcome.replace(/_/g, ' ')}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}
      </div>
    );
  }

  // ---------------- PRICING ----------------
  if (tab === 'price') {
    const p = intel.pricing;
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`${chip} ${PRICE_STYLE[p.signal]}`}>{PRICE_LABEL[p.signal]}</span>
          <span className={subtle}>{p.freshOffers} fresh quote{p.freshOffers === 1 ? '' : 's'}{p.staleOffers ? ` · ${p.staleOffers} stale` : ''}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Best quote" value={p.bestCents === null ? '—' : formatCents(p.bestCents)} hint={`vs 30-day median ${pctText(p.vs30dPct)}`} />
          <Stat label="Median / high" value={p.medianCents === null ? '—' : `${formatCents(p.medianCents)} / ${p.highCents === null ? '—' : formatCents(p.highCents)}`} hint={p.spreadPct === null ? undefined : `${p.spreadPct}% spread`} />
          <Stat label="vs OEM average" value={pctText(p.vsOemPct)} hint={intel.oemAvg === null ? 'No OEM price' : `OEM ${formatCents(intel.oemAvg)}`} />
          <Stat label="vs your cost" value={pctText(p.vsOwnCostPct)} hint={`cost ${formatCents(row.unit_cost_cents)}`} />
        </div>
        <Block title="30-day price history" aside={<span className={subtle}>{p.volatilityPct === null ? '' : `volatility ${p.volatilityPct}%`}{p.driftPct === null ? '' : ` · drift ${pctText(p.driftPct)}`}</span>}>
          <Spark values={[...intel.partHistory].sort((a, b) => a.observed_at.localeCompare(b.observed_at)).map((h) => h.unit_price_cents)} />
        </Block>
        {p.notes.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">{p.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        )}
        <Block title="Live quotes">
          {intel.partOffers.length === 0 ? (
            <p className="text-sm text-text-secondary">No quotes yet. Add quotes in Parts Market → Sources & quotes.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {[...intel.partOffers].sort((a, b) => a.unit_price_cents - b.unit_price_cents).map((o) => (
                <li key={o.offer_id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{o.source_name} <span className={subtle}>· {o.quantity_available} avail · {o.eta_minutes === null ? 'ETA ?' : formatEta(o.eta_minutes)}</span></span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{formatCents(o.unit_price_cents)}</span>
                    <span className={`${chip} ${o.is_expired ? TIER_STYLE.critical : o.age_minutes > 240 ? TIER_STYLE.high : 'bg-bg-tertiary text-text-secondary'}`}>{o.is_expired ? 'Expired' : formatAge(o.age_minutes)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Block>
      </div>
    );
  }

  // ---------------- STOCK & SOURCING ----------------
  if (tab === 'stock') {
    const availability = (marketInput?.availability ?? []).filter((a) => a.part_id === row.part_id);
    const dec = intel.decision;
    return (
      <div className="space-y-4">
        <Block title="Availability by location">
          {availability.length === 0 ? (
            <p className="text-sm text-text-secondary">This part is not stocked at any active location.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {availability.map((a) => (
                <li key={a.stock_level_id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{a.location_name} <span className={subtle}>· {a.location_type}</span></span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{a.quantity_available} avail</span>
                    <span className={subtle}>{a.estimated_days_of_stock === null ? '' : `${Math.round(a.estimated_days_of_stock)}d`}</span>
                    <span className={`${chip} ${a.stockout_risk === 'critical' ? TIER_STYLE.critical : a.stockout_risk === 'low' ? TIER_STYLE.high : TIER_STYLE.healthy}`}>{a.stockout_risk}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Block>
        <Block
          title="Best way to source it"
          aside={
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              Quantity
              <input
                type="number"
                min={1}
                value={orderQty}
                onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                className="focus-ring w-20 rounded-lg border border-border bg-bg-primary px-2 py-1 text-sm text-text-primary"
              />
            </label>
          }
        >
          {!dec || !dec.recommended ? (
            <p className="text-sm text-text-secondary">No viable source yet. Add vendors and quotes in Parts Market.</p>
          ) : (
            <>
              <p className="text-sm font-semibold text-text-primary">{dec.buyVsBorrow.headline}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-text-secondary">{dec.rationale.slice(0, 4).map((r) => <li key={r}>{r}</li>)}</ul>
              <ul className="mt-3 space-y-1.5 text-sm">
                {dec.options.slice(0, 5).map((o) => (
                  <li key={o.key} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 ${o.key === dec.recommended?.key ? 'bg-accent/10' : ''}`}>
                    <span>{o.label}{o.isSubstitute ? <span className={subtle}> · substitute</span> : null}</span>
                    <span className="flex items-center gap-3 tabular-nums">
                      <span>{formatCents(o.unitPriceCents)}</span>
                      <span className={subtle}>{formatEta(o.etaMinutes)}</span>
                      <span className="font-semibold">{formatCents(o.expectedTotalCostCents)} all-in</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {canOrder && (
                  <Button size="sm" onClick={onOrder} disabled={working}>
                    Create purchase request
                  </Button>
                )}
                <Link to="/dashboard/parts-market" className="text-sm font-semibold text-accent hover:underline">Open full comparison in Parts Market</Link>
              </div>
            </>
          )}
        </Block>
        <Block title="Supplier record for this part" aside={<span className={subtle}>from real installs &amp; job outcomes</span>}>
          {intel.suppliers.length === 0 ? (
            <p className="text-sm text-text-secondary">No installs are traced to a supplier yet. Trace lots in Supply Chain Outcomes.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {intel.suppliers.map((s) => (
                <li key={s.supplier} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium text-text-primary">{s.supplier}</span>
                    <span className="block text-xs text-text-secondary">{s.installs} installs · {s.failures} failed{s.defectAttributed ? ` · ${s.defectAttributed} defect-attributed` : ''}</span>
                  </span>
                  <span className="text-right">
                    <span className="tabular-nums">{s.successRatePct === null ? '—' : `${s.successRatePct}%`}</span>
                    <span className="block text-[11px] text-text-secondary">{s.confidentRatePct === null ? '' : `≥ ${Math.round(s.confidentRatePct)}% confident`}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Block>
      </div>
    );
  }

  // ---------------- DEMAND ----------------
  if (tab === 'demand') {
    return (
      <div className="space-y-4">
        <Block title="Weekly usage and next 4 weeks" aside={<span className={subtle}>grey = actual · blue = forecast</span>}>
          <Bars history={row.weekly_usage} forecast={f.next4Weeks} />
        </Block>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Pattern" value={PATTERN_LABEL[f.pattern]} hint={`${Math.round(f.confidence * 100)}% confidence`} />
          <Stat label="Next 30 days" value={Math.round(f.expected30d)} hint={`${Math.round(f.low30d)}–${Math.round(f.high30d)} (80% range)`} />
          <Stat label="Out of stock" value={f.stockoutDate ?? 'Not soon'} hint={f.daysOfCover === null ? 'No demand' : `${Math.round(f.daysOfCover)} days of cover`} />
          <Stat label="Scheduled jobs" value={f.scheduled30d} hint="Units already required" />
          <Stat label="Safety stock" value={f.safetyStock} hint="95% service level" />
          <Stat label="Reorder point" value={f.dynamicReorderPoint} hint={`yours: ${row.reorder_point}`} />
          <Stat label="Suggested order" value={f.suggestedOrderQty || '—'} hint={row.reorder_quantity ? `lots of ${row.reorder_quantity}` : undefined} />
          <Stat label="Trend" value={f.trendPerWeek === 0 ? 'Flat' : `${f.trendPerWeek > 0 ? '+' : ''}${f.trendPerWeek}/wk`} />
        </div>
        {f.notes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">{f.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        <p className={subtle}>
          Forecast = recency-weighted weekly usage with a damped trend, never below the units already required by scheduled jobs.
          Open purchase orders are not subtracted, so check pending orders before ordering.
        </p>
      </div>
    );
  }

  // ---------------- RECALLS ----------------
  const d = detail;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${chip} ${intel.recall.level === 'none' ? TIER_STYLE.healthy : SEV_STYLE[intel.recall.level]}`}>{intel.recall.level === 'none' ? 'No part-linked recall' : `${intel.recall.level} severity`}</span>
        <span className="text-sm text-text-primary">{intel.recall.headline}</span>
      </div>
      <Block title="OEM issues that require this part">
        {!d || d.issues.length === 0 ? (
          <p className="text-sm text-text-secondary">No OEM known issue lists this part.</p>
        ) : (
          <ul className="space-y-3">
            {d.issues.map((i) => (
              <li key={i.issue_id} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`${chip} ${SEV_STYLE[i.severity]}`}>{i.severity}</span>
                  <span className="font-medium text-text-primary">{i.title}</span>
                  <span className={subtle}>{i.manufacturer}</span>
                </div>
                {i.recall && (
                  <p className="mt-1 text-xs text-text-secondary">
                    Recall {i.recall.recall_number}: {i.recall.title}
                    {i.recall.remedy ? ` — remedy: ${i.recall.remedy}` : ''}
                    {i.recall.source_url && (
                      <a href={i.recall.source_url} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-accent hover:underline">source <ExternalLink size={11} /></a>
                    )}
                  </p>
                )}
                {i.bulletin && <p className="mt-0.5 text-xs text-text-secondary">Bulletin {i.bulletin.bulletin_number}: {i.bulletin.title}</p>}
                {i.recommended_repair && <p className="mt-0.5 text-xs text-text-secondary">Repair: {i.recommended_repair}</p>}
              </li>
            ))}
          </ul>
        )}
      </Block>
      {d && (d.model_recalls.length > 0 || d.model_bulletins.length > 0) && (
        <Block title="Model-level context" aside={<span className={subtle}>not specific to this part</span>}>
          <ul className="space-y-1.5 text-sm">
            {d.model_recalls.slice(0, 5).map((r) => (
              <li key={`r-${r.recall_number}-${r.model_number}`}>
                <span className={`${chip} ${SEV_STYLE[r.severity]} mr-2`}>{r.severity}</span>
                {r.model_number}: recall {r.recall_number} — {r.title}
              </li>
            ))}
            {d.model_bulletins.slice(0, 5).map((b) => (
              <li key={`b-${b.bulletin_number}-${b.model_number}`} className="text-text-secondary">
                {b.model_number}: bulletin {b.bulletin_number} — {b.title}
              </li>
            ))}
          </ul>
        </Block>
      )}
    </div>
  );
}
