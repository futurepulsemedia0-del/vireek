/**
 * Supplier Intelligence — /dashboard/supplier-intelligence
 *
 * Not a supplier directory: an analysis and decision layer on top of
 * Vendor & Procurement, Parts & Inventory and the AI Parts Market. It scores
 * every supplier on reliability, quality, price, lead time and
 * responsiveness, rates risk, compares suppliers part by part, projects
 * future supply conditions from demand, and turns all of it into ranked,
 * explainable recommendations that can be acted on in one click.
 *
 * All logic lives in src/lib/supplierIntelligence.ts (pure engine, unit
 * tested) and src/lib/supplierIntelligenceApi.ts (data access); this file is
 * presentation + orchestration only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  DollarSign,
  Handshake,
  PackageSearch,
  Radio,
  RefreshCw,
  ShieldAlert,
  Truck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable } from '@/components/Skeleton';
import { formatCents } from '@/lib/procurement';
import {
  PRIORITY_LABELS,
  analyzeSuppliers,
  buildSupplierContext,
  comparePartSuppliers,
} from '@/lib/supplierIntelligence';
import type {
  Confidence,
  OutlookStatus,
  RecommendationAction,
  RecommendationSeverity,
  RiskLevel,
  ScoredSupplier,
  SourcingPriority,
  SupplierRecommendation,
  SupplyOutlookRow,
} from '@/lib/supplierIntelligence';
import {
  createRequestFromRecommendation,
  gatherSupplierIntelligenceInput,
  subscribeToSupplierData,
} from '@/lib/supplierIntelligenceApi';
import type { SupplierDataResult } from '@/lib/supplierIntelligenceApi';

// ============================================================
// STYLE + FORMAT HELPERS
// ============================================================

const fieldClass =
  'w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring';
const secondaryBtn =
  'focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40';

const RISK_TONE: Record<RiskLevel, string> = {
  low: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400',
  moderate: 'bg-sky-100 text-sky-800 dark:bg-sky-500/10 dark:text-sky-400',
  high: 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-400',
  critical: 'bg-rose-100 text-rose-800 dark:bg-rose-500/10 dark:text-rose-400',
};

const SEVERITY_TONE: Record<RecommendationSeverity, string> = {
  critical: RISK_TONE.critical,
  high: RISK_TONE.high,
  medium: RISK_TONE.moderate,
  low: 'bg-slate-100 text-slate-700 dark:bg-slate-500/10 dark:text-slate-400',
};

const STATUS_META: Record<OutlookStatus, { label: string; tone: string }> = {
  order_now: { label: 'Order now', tone: RISK_TONE.critical },
  watch: { label: 'Watch', tone: RISK_TONE.high },
  request_open: { label: 'Request open', tone: RISK_TONE.moderate },
  ok: { label: 'Covered', tone: RISK_TONE.low },
  no_demand: { label: 'No demand', tone: SEVERITY_TONE.low },
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  none: 'No data',
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

const ORIGIN_LABEL = { procurement: 'Vendor', inventory: 'Inventory vendor', market: 'Market source' } as const;

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pctFmt = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const daysFmt = (v: number | null) => (v === null ? '—' : v < 1 ? '<1d' : `${Math.round(v * 10) / 10}d`);
const fmtDate = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';

function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {children}
    </span>
  );
}

function RiskChip({ level, score }: { level: RiskLevel; score?: number }) {
  return (
    <Chip tone={RISK_TONE[level]}>
      {level[0].toUpperCase() + level.slice(1)}
      {score !== undefined ? ` · ${Math.round(score)}` : ''}
    </Chip>
  );
}

function Panel({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function ScoreBar({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return <span className="text-xs text-text-secondary">—</span>;
  const good = invert ? 100 - value : value;
  const color = good >= 70 ? 'bg-emerald-500' : good >= 45 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="flex items-center gap-2" role="img" aria-label={`${Math.round(value)} out of 100`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-tertiary">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="w-7 text-xs tabular-nums text-text-primary">{Math.round(value)}</span>
    </div>
  );
}

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${tone ?? 'text-text-primary'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-text-secondary">{sub}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

const TABS = [
  { key: 'overview', label: 'Recommendations' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'compare', label: 'Compare sourcing' },
  { key: 'outlook', label: 'Supply outlook' },
  { key: 'risk', label: 'Risk & concentration' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

type RequestAction = Extract<RecommendationAction, { type: 'create_purchase_request' }>;

// ============================================================
// PAGE
// ============================================================

export function SupplierIntelligencePage() {
  const { toast } = useToast();
  const navigate = useNavigate();

  const [data, setData] = useState<SupplierDataResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const [priority, setPriority] = useState<SourcingPriority>('balanced');
  const [tab, setTab] = useState<TabKey>('overview');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [outlookFilter, setOutlookFilter] = useState<'action' | 'all'>('action');
  const [partId, setPartId] = useState('');
  const [qty, setQty] = useState('10');
  const [working, setWorking] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        setData(await gatherSupplierIntelligenceInput());
        setLoadFailed(false);
        setUpdatedAt(new Date());
      } catch {
        setLoadFailed(true);
        if (!silent) toast('Could not load Supplier Intelligence.', 'error');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => subscribeToSupplierData(() => void load(true)), [load]);

  const ctx = useMemo(() => (data ? buildSupplierContext(data.input) : null), [data]);
  const result = useMemo(() => (ctx ? analyzeSuppliers(ctx, priority) : null), [ctx, priority]);

  const partOptions = useMemo(
    () => (data ? [...data.input.parts].sort((a, b) => a.name.localeCompare(b.name)) : []),
    [data],
  );

  // Default the comparison to the most urgent part once data arrives.
  useEffect(() => {
    if (partId || !result) return;
    const first = result.outlook.find((r) => r.status === 'order_now') ?? result.outlook[0];
    if (first) setPartId(first.partId);
    else if (partOptions[0]) setPartId(partOptions[0].id);
  }, [partId, result, partOptions]);

  const qtyNum = Math.max(1, Math.round(Number.parseFloat(qty) || 1));
  const sourcing = useMemo(
    () => (ctx && partId ? comparePartSuppliers(ctx, partId, qtyNum, priority) : null),
    [ctx, partId, qtyNum, priority],
  );

  const submitRequest = async (id: string, action: RequestAction) => {
    setWorking(id);
    try {
      await createRequestFromRecommendation(action);
      setDone((prev) => new Set(prev).add(id));
      toast('Draft purchase request created in Procurement.', 'success');
      void load(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the purchase request.', 'error');
    } finally {
      setWorking(null);
    }
  };

  const selected = result?.profiles.find((p) => p.key === selectedKey) ?? null;
  const hasAnyData =
    !!data &&
    (data.input.vendors.length > 0 || data.input.purchaseOrders.length > 0 || data.input.inventoryVendors.length > 0);
  const partName = (id: string) => ctx?.parts.get(id)?.name ?? ctx?.forecast.get(id)?.partName ?? 'Part';
  const openSupplier = (key: string) => {
    setSelectedKey(key);
    setTab('suppliers');
  };

  // ---------- render ----------

  return (
    <DashboardLayout activeLabel="Supplier Intelligence">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Handshake size={22} /> Supplier Intelligence
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Who should we buy from, what is about to run short, and where are we exposed? Pricing, lead times,
              reliability, quality and risk across Procurement, Inventory and the Parts Market — turned into
              decisions.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-text-secondary">Sourcing priority</span>
              <select
                className={`${fieldClass} !w-auto !py-1.5 text-xs`}
                value={priority}
                onChange={(e) => setPriority(e.target.value as SourcingPriority)}
              >
                {(Object.keys(PRIORITY_LABELS) as SourcingPriority[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            <span className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1.5 text-[11px] text-text-secondary">
              <Radio size={12} className="text-emerald-500" />
              Live{updatedAt ? ` · ${updatedAt.toLocaleTimeString()}` : ''}
            </span>
            <button type="button" className={secondaryBtn} onClick={() => void load(true)} disabled={loading || refreshing}>
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={6} />
            <SkeletonTable rows={6} columns={6} />
          </div>
        ) : loadFailed && !data ? (
          <EmptyState
            icon={AlertTriangle}
            title="Supplier data could not be loaded"
            description="Check your connection and try again."
            action={{ label: 'Try again', onClick: () => void load() }}
          />
        ) : !result || !data || !hasAnyData ? (
          <EmptyState
            icon={Truck}
            title="No supplier data to analyze yet"
            description="Add vendors and place purchase orders in Vendor & Procurement. Supplier Intelligence starts scoring as soon as there is purchasing history."
            action={{ label: 'Open Vendor & Procurement', onClick: () => navigate('/dashboard/procurement') }}
          />
        ) : (
          <>
            {data.warnings.length > 0 && (
              <div
                role="status"
                className="mb-4 flex items-start gap-2 rounded-2xl border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  Some data sources could not be loaded: <strong>{data.warnings.join(', ')}</strong>. Scores that depend
                  on them are hidden or less certain until they load.
                </span>
              </div>
            )}

            <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <StatTile label="Active suppliers" value={String(result.summary.activeSuppliers)} sub={`${Math.round(result.summary.dataCoverage * 100)}% well-evidenced`} />
              <StatTile label="12-month spend" value={money(result.summary.totalSpend12mCents)} sub={`Top supplier ${pctFmt(result.summary.topSupplierShare)}`} />
              <StatTile
                label="On-time delivery"
                value={pctFmt(result.summary.weightedOnTimeRate)}
                sub={result.summary.overdueOpenOrders > 0 ? `${result.summary.overdueOpenOrders} open order(s) overdue` : 'No overdue orders'}
                tone={result.summary.overdueOpenOrders > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}
              />
              <StatTile
                label="At-risk suppliers"
                value={String(result.summary.atRiskSuppliers)}
                sub={`Concentration: ${result.summary.concentrationLevel}`}
                tone={result.summary.atRiskSuppliers > 0 ? 'text-rose-600 dark:text-rose-400' : undefined}
              />
              <StatTile
                label="Sole-source parts"
                value={String(result.summary.singleSourceParts)}
                sub={`${result.summary.partsToOrderNow} to order now`}
                tone={result.summary.partsToOrderNow > 0 ? 'text-rose-600 dark:text-rose-400' : undefined}
              />
              <StatTile label="Savings opportunity" value={money(result.summary.savingsOpportunityCents)} sub="Estimated per year" tone="text-emerald-600 dark:text-emerald-400" />
            </div>

            <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Supplier Intelligence sections">
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
                  {t.key === 'overview' && result.recommendations.length > 0 ? ` (${result.recommendations.length})` : ''}
                </button>
              ))}
            </div>

            {tab === 'overview' && (
              <OverviewTab
                recs={result.recommendations}
                top={result.profiles.filter((p) => p.rank !== null).slice(0, 5)}
                watch={result.outlook.filter((r) => r.status === 'order_now' || r.status === 'watch').slice(0, 5)}
                working={working}
                done={done}
                onRequest={submitRequest}
                onOpenSupplier={openSupplier}
              />
            )}

            {tab === 'suppliers' && (
              <SuppliersTab
                suppliers={result.profiles}
                selected={selected}
                onSelect={setSelectedKey}
                search={search}
                onSearch={setSearch}
                showInactive={showInactive}
                onShowInactive={setShowInactive}
                partName={partName}
              />
            )}

            {tab === 'compare' && (
              <Panel title="Compare sourcing for a part">
                <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_140px]">
                  <Field label="Part">
                    <select className={fieldClass} value={partId} onChange={(e) => setPartId(e.target.value)}>
                      <option value="">Select a part…</option>
                      {partOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.part_number ? ` (${p.part_number})` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Quantity">
                    <input className={fieldClass} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
                  </Field>
                </div>
                <CompareView sourcing={sourcing} priority={priority} working={working} done={done} onRequest={submitRequest} />
              </Panel>
            )}

            {tab === 'outlook' && (
              <OutlookTab
                rows={result.outlook}
                filter={outlookFilter}
                onFilter={setOutlookFilter}
                working={working}
                done={done}
                onRequest={submitRequest}
                onCompare={(id, quantity) => {
                  setPartId(id);
                  if (quantity > 0) setQty(String(quantity));
                  setTab('compare');
                }}
              />
            )}

            {tab === 'risk' && (
              <RiskTab
                suppliers={result.profiles.filter((p) => p.active)}
                hhi={result.summary.hhi}
                level={result.summary.concentrationLevel}
                partName={partName}
                onOpenSupplier={openSupplier}
              />
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// OVERVIEW
// ============================================================

interface RequestProps {
  working: string | null;
  done: Set<string>;
  onRequest: (id: string, action: RequestAction) => Promise<void>;
}

function ActionButton({ id, action, working, done, onRequest }: { id: string; action: RecommendationAction } & RequestProps) {
  if (action.type === 'navigate') {
    return (
      <Link to={action.href} className={secondaryBtn}>
        {action.label} <ArrowRight size={12} />
      </Link>
    );
  }
  if (done.has(id)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <Check size={13} /> Request created
      </span>
    );
  }
  return (
    <Button size="sm" variant="primary" disabled={working !== null} onClick={() => void onRequest(id, action)}>
      {working === id ? 'Creating…' : `Create purchase request (${action.quantity})`}
    </Button>
  );
}

function OverviewTab({
  recs, top, watch, working, done, onRequest, onOpenSupplier,
}: {
  recs: SupplierRecommendation[];
  top: ScoredSupplier[];
  watch: SupplyOutlookRow[];
  onOpenSupplier: (key: string) => void;
} & RequestProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3">
        {recs.length === 0 ? (
          <EmptyState
            icon={Check}
            title="Nothing needs your attention"
            description="Stock is covered, no supplier is underperforming and no savings opportunities stand out right now."
          />
        ) : (
          recs.map((r) => (
            <article key={r.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <Chip tone={SEVERITY_TONE[r.severity]}>{r.severity[0].toUpperCase() + r.severity.slice(1)}</Chip>
                <span className="text-[11px] text-text-secondary">{CONFIDENCE_LABEL[r.confidence]}</span>
                {r.impactCents !== null && r.impactCents > 0 && (
                  <span className="ml-auto flex items-center gap-1 text-xs font-semibold text-text-primary">
                    <DollarSign size={12} /> {money(r.impactCents)}
                    <span className="font-normal text-text-secondary">{r.kind === 'reorder_now' ? 'order value' : 'est. / year'}</span>
                  </span>
                )}
              </div>
              <h3 className="text-sm font-semibold text-text-primary">{r.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">{r.detail}</p>
              {r.evidence.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-text-secondary">
                  {r.evidence.slice(0, 5).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <ActionButton id={r.id} action={r.action} working={working} done={done} onRequest={onRequest} />
                {r.supplierKey && (
                  <button type="button" className={secondaryBtn} onClick={() => onOpenSupplier(r.supplierKey as string)}>
                    View supplier
                  </button>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      <div className="space-y-4">
        <Panel title="Top suppliers">
          {top.length === 0 ? (
            <p className="py-2 text-xs text-text-secondary">Scores appear once suppliers have deliveries, ratings or quotes on record.</p>
          ) : (
            <ol className="space-y-2">
              {top.map((p) => (
                <li key={p.key}>
                  <button type="button" onClick={() => onOpenSupplier(p.key)} className="focus-ring flex w-full items-center gap-2 rounded-xl p-1.5 text-left hover:bg-bg-tertiary">
                    <span className="w-5 text-xs font-semibold text-text-secondary">{p.rank}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{p.name}</span>
                    <ScoreBar value={p.composite} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel title="Parts to watch">
          {watch.length === 0 ? (
            <p className="py-2 text-xs text-text-secondary">No part is close to running short.</p>
          ) : (
            <ul className="space-y-2">
              {watch.map((r) => (
                <li key={r.partId} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-text-primary">{r.partName}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-text-secondary">
                    {r.daysOfStock !== null ? `${Math.round(r.daysOfStock)}d left` : '—'}
                    <Chip tone={STATUS_META[r.status].tone}>{STATUS_META[r.status].label}</Chip>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ============================================================
// SUPPLIERS
// ============================================================

function SuppliersTab({
  suppliers, selected, onSelect, search, onSearch, showInactive, onShowInactive, partName,
}: {
  suppliers: ScoredSupplier[];
  selected: ScoredSupplier | null;
  onSelect: (key: string | null) => void;
  search: string;
  onSearch: (v: string) => void;
  showInactive: boolean;
  onShowInactive: (v: boolean) => void;
  partName: (id: string) => string;
}) {
  const q = search.trim().toLowerCase();
  const rows = suppliers.filter((s) => (showInactive || s.active) && (!q || s.name.toLowerCase().includes(q)));

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <Panel
        title={`Suppliers (${rows.length})`}
        action={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-text-secondary">
              <input type="checkbox" checked={showInactive} onChange={(e) => onShowInactive(e.target.checked)} />
              Show inactive
            </label>
            <input
              className={`${fieldClass} !w-44 !py-1.5 text-xs`}
              placeholder="Search suppliers…"
              aria-label="Search suppliers"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />
          </div>
        }
      >
        {rows.length === 0 ? (
          <EmptyState icon={Truck} title="No suppliers match" description="Try a different search or include inactive suppliers." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase tracking-wide text-text-secondary">
                  <th scope="col" className="py-2 pr-2">#</th>
                  <th scope="col" className="py-2 pr-2">Supplier</th>
                  <th scope="col" className="py-2 pr-2">Score</th>
                  <th scope="col" className="py-2 pr-2">On-time</th>
                  <th scope="col" className="py-2 pr-2">Fill</th>
                  <th scope="col" className="py-2 pr-2">Lead (p80)</th>
                  <th scope="col" className="py-2 pr-2">Price idx</th>
                  <th scope="col" className="py-2 pr-2">Spend share</th>
                  <th scope="col" className="py-2">Risk</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr
                    key={s.key}
                    onClick={() => onSelect(s.key)}
                    className={`cursor-pointer border-b border-border/60 hover:bg-bg-tertiary ${selected?.key === s.key ? 'bg-accent/5' : ''}`}
                  >
                    <td className="py-2 pr-2 text-text-secondary">{s.rank ?? '—'}</td>
                    <td className="py-2 pr-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(s.key);
                        }}
                        className="focus-ring rounded text-left font-medium text-text-primary"
                      >
                        {s.name}
                      </button>
                      <span className="block text-[11px] text-text-secondary">
                        {ORIGIN_LABEL[s.origin]}
                        {!s.active ? ' · inactive' : ''} · {CONFIDENCE_LABEL[s.confidence].toLowerCase()}
                      </span>
                    </td>
                    <td className="py-2 pr-2"><ScoreBar value={s.composite} /></td>
                    <td className="py-2 pr-2 tabular-nums">{pctFmt(s.onTimeRate)}</td>
                    <td className="py-2 pr-2 tabular-nums">{pctFmt(s.fillRate)}</td>
                    <td className="py-2 pr-2 tabular-nums">{daysFmt(s.leadTime.p80Days)}</td>
                    <td className="py-2 pr-2 tabular-nums">{s.priceIndex === null ? '—' : s.priceIndex.toFixed(2)}</td>
                    <td className="py-2 pr-2 tabular-nums">{pctFmt(s.spendShare)}</td>
                    <td className="py-2"><RiskChip level={s.risk.level} score={s.risk.score} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <SupplierDetail supplier={selected} partName={partName} />
    </div>
  );
}

function SupplierDetail({ supplier: s, partName }: { supplier: ScoredSupplier | null; partName: (id: string) => string }) {
  if (!s) {
    return (
      <Panel title="Supplier detail">
        <p className="py-6 text-center text-xs text-text-secondary">Select a supplier to see its scorecard, risk factors and exposure.</p>
      </Panel>
    );
  }
  const dims: [string, number | null][] = [
    ['Reliability', s.scores.reliability],
    ['Quality', s.scores.quality],
    ['Price', s.scores.price],
    ['Lead time', s.scores.leadTime],
    ['Responsiveness', s.scores.responsiveness],
  ];
  const facts: [string, string][] = [
    ['Orders (qualifying)', String(s.orders)],
    ['12-month spend', money(s.spend12mCents)],
    ['On-time rate', `${pctFmt(s.onTimeRate)}${s.onTimeSource ? ` · ${s.onTimeSample} ${s.onTimeSource === 'receipts' ? 'deliveries' : 'ratings'}` : ''}`],
    ['Average delay', s.avgDelayDays === null ? '—' : `${s.avgDelayDays}d`],
    ['Fill rate', pctFmt(s.fillRate)],
    ['Damaged lines', pctFmt(s.damageRate)],
    ['Lead time (median / p80)', `${daysFmt(s.leadTime.medianDays)} / ${daysFmt(s.leadTime.p80Days)}${s.leadTime.basis ? ` · ${s.leadTime.basis}` : ''}`],
    ['Price vs market', s.priceIndex === null ? '—' : `${s.priceIndex.toFixed(2)} (${s.pricedParts} parts)`],
    ['30-day price drift', s.priceTrend30dPct === null ? '—' : `${s.priceTrend30dPct > 0 ? '+' : ''}${s.priceTrend30dPct}%`],
    ['RFQ response', s.rfqInvites === 0 ? '—' : `${pctFmt(s.rfqResponseRate)} of ${s.rfqInvites}${s.avgQuoteTurnaroundDays !== null ? ` · ${s.avgQuoteTurnaroundDays}d` : ''}`],
    ['Last order', s.daysSinceLastOrder === null ? '—' : `${s.daysSinceLastOrder}d ago`],
  ];

  return (
    <Panel title="Supplier detail">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-text-primary">{s.name}</h3>
          <p className="text-[11px] text-text-secondary">
            {ORIGIN_LABEL[s.origin]}
            {s.category ? ` · ${s.category}` : ''} · {CONFIDENCE_LABEL[s.confidence].toLowerCase()}
          </p>
        </div>
        <RiskChip level={s.risk.level} score={s.risk.score} />
      </div>

      <div className="mb-4 space-y-1.5">
        {dims.map(([label, v]) => (
          <div key={label} className="flex items-center justify-between text-xs">
            <span className="text-text-secondary">{label}</span>
            <ScoreBar value={v} />
          </div>
        ))}
      </div>

      <dl className="mb-4 divide-y divide-border/60 text-xs">
        {facts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 py-1.5">
            <dt className="text-text-secondary">{k}</dt>
            <dd className="text-right tabular-nums text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>

      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Risk factors</h4>
      <ul className="mb-4 space-y-2">
        {s.risk.factors.map((f) => (
          <li key={f.key} className="text-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-primary">{f.label}</span>
              <ScoreBar value={f.score} invert />
            </div>
            <p className="text-[11px] text-text-secondary">{f.detail}</p>
          </li>
        ))}
      </ul>

      {s.singleSourcePartIds.length > 0 && (
        <>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Sole-sourced parts</h4>
          <p className="mb-4 text-xs text-text-secondary">
            {s.singleSourcePartIds.slice(0, 8).map(partName).join(', ')}
            {s.singleSourcePartIds.length > 8 ? ` +${s.singleSourcePartIds.length - 8} more` : ''}
          </p>
        </>
      )}

      <div className="flex flex-wrap gap-2">
        <Link to="/dashboard/procurement" className={secondaryBtn}>Vendor & Procurement <ArrowRight size={12} /></Link>
        <Link to="/dashboard/parts-market" className={secondaryBtn}>Parts Market <ArrowRight size={12} /></Link>
      </div>
    </Panel>
  );
}

// ============================================================
// COMPARE
// ============================================================

function CompareView({
  sourcing, priority, working, done, onRequest,
}: {
  sourcing: ReturnType<typeof comparePartSuppliers> | null;
  priority: SourcingPriority;
} & RequestProps) {
  const navigate = useNavigate();
  if (!sourcing) {
    return <EmptyState icon={PackageSearch} title="Pick a part to compare" description="Choose a part and quantity to rank every supplier that can provide it." />;
  }
  if (sourcing.candidates.length === 0) {
    return (
      <EmptyState
        icon={PackageSearch}
        title="No supplier prices for this part"
        description="No active supplier has a purchase, catalog entry or live offer for it. Request quotes to start building price history."
        action={{ label: 'Open Vendor & Procurement', onClick: () => navigate('/dashboard/procurement') }}
      />
    );
  }
  const p = sourcing.primary;
  const reqId = `compare:${sourcing.partId}`;
  return (
    <div className="space-y-4">
      {p && (
        <div className="rounded-2xl border border-accent/30 bg-accent/5 p-4">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Chip tone="bg-accent/15 text-accent">Recommended · {PRIORITY_LABELS[priority]}</Chip>
            {sourcing.singleSource && <Chip tone={RISK_TONE.high}>Single source</Chip>}
            {sourcing.priceTrend30dPct !== null && Math.abs(sourcing.priceTrend30dPct) >= 3 && (
              <Chip tone={sourcing.priceTrend30dPct > 0 ? RISK_TONE.high : RISK_TONE.low}>
                {sourcing.priceTrend30dPct > 0 ? <TrendingUp size={11} className="mr-1" /> : <TrendingDown size={11} className="mr-1" />}
                {sourcing.priceTrend30dPct > 0 ? '+' : ''}{Math.round(sourcing.priceTrend30dPct)}% / month
              </Chip>
            )}
          </div>
          <h3 className="text-base font-semibold text-text-primary">
            {sourcing.quantity} × {sourcing.partName} from {p.name}
          </h3>
          <p className="text-xs text-text-secondary">
            {formatCents(p.landedCostCents)} landed
            {p.leadTimeDays !== null ? ` · ~${daysFmt(p.leadTimeDays)} lead time` : ''}
            {sourcing.backup ? ` · backup: ${sourcing.backup.name}` : ''}
          </p>
          <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-text-secondary">
            {sourcing.rationale.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <ActionButton
              id={reqId}
              action={{
                type: 'create_purchase_request',
                partId: sourcing.partId,
                quantity: sourcing.quantity,
                neededBy: null,
                note: `Supplier Intelligence: recommended supplier ${p.name} (${formatCents(p.unitPriceCents)}/unit).`,
              }}
              working={working}
              done={done}
              onRequest={onRequest}
            />
            <Link to="/dashboard/parts-market" className={secondaryBtn}>Live offers in Parts Market <ArrowRight size={12} /></Link>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-xs">
          <thead>
            <tr className="border-b border-border text-[11px] uppercase tracking-wide text-text-secondary">
              <th scope="col" className="py-2 pr-2">#</th>
              <th scope="col" className="py-2 pr-2">Supplier</th>
              <th scope="col" className="py-2 pr-2">Unit price</th>
              <th scope="col" className="py-2 pr-2">Landed (risk-adj.)</th>
              <th scope="col" className="py-2 pr-2">Lead time</th>
              <th scope="col" className="py-2 pr-2">Stock</th>
              <th scope="col" className="py-2 pr-2">Reliability</th>
              <th scope="col" className="py-2 pr-2">Score</th>
              <th scope="col" className="py-2">Risk</th>
            </tr>
          </thead>
          <tbody>
            {sourcing.candidates.map((c) => (
              <tr key={c.key} className="border-b border-border/60">
                <td className="py-2 pr-2 text-text-secondary">{c.rank}</td>
                <td className="py-2 pr-2">
                  <span className="font-medium text-text-primary">{c.name}</span>
                  <span className="block text-[11px] text-text-secondary">
                    {c.priceBasis === 'po' ? 'Last PO' : c.priceBasis === 'offer' ? 'Live offer' : c.priceBasis === 'history' ? 'Price history' : 'Catalog'}
                    {c.priceAgeDays !== null ? ` · ${c.priceAgeDays}d old` : ''}
                    {c.priceStale ? ' · stale' : ''}
                    {c.isPreferred ? ' · preferred' : ''}
                  </span>
                </td>
                <td className="py-2 pr-2 tabular-nums">
                  {formatCents(c.unitPriceCents)}
                  {c.vsBestPct > 0 && <span className="block text-[11px] text-text-secondary">+{c.vsBestPct}% vs best</span>}
                </td>
                <td className="py-2 pr-2 tabular-nums">
                  {formatCents(c.landedCostCents)}
                  <span className="block text-[11px] text-text-secondary">{formatCents(c.riskAdjustedCostCents)}</span>
                </td>
                <td className="py-2 pr-2 tabular-nums">
                  {daysFmt(c.leadTimeDays)}
                  <span className="block text-[11px] text-text-secondary">{c.leadBasis.replace('_', ' ')}</span>
                </td>
                <td className="py-2 pr-2 tabular-nums">
                  {c.availableQty === null ? '—' : c.availableQty}
                  {c.coversQuantity === false && <span className="block text-[11px] text-amber-600 dark:text-amber-400">short</span>}
                </td>
                <td className="py-2 pr-2"><ScoreBar value={c.reliability} /></td>
                <td className="py-2 pr-2"><ScoreBar value={c.partScore} /></td>
                <td className="py-2"><RiskChip level={c.riskLevel} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-text-secondary">
        Risk-adjusted cost adds the expected cost of late and short deliveries based on each supplier&apos;s record. Unknown
        dimensions are scored neutrally, never favourably.
      </p>
    </div>
  );
}

// ============================================================
// OUTLOOK
// ============================================================

const OUTLOOK_RENDER_LIMIT = 200;

function OutlookTab({
  rows, filter, onFilter, working, done, onRequest, onCompare,
}: {
  rows: SupplyOutlookRow[];
  filter: 'action' | 'all';
  onFilter: (v: 'action' | 'all') => void;
  onCompare: (partId: string, quantity: number) => void;
} & RequestProps) {
  const visible =
    filter === 'action'
      ? rows.filter((r) => r.status === 'order_now' || r.status === 'watch' || r.status === 'request_open')
      : rows;
  const shown = visible.slice(0, OUTLOOK_RENDER_LIMIT);

  return (
    <Panel
      title="Future supply conditions"
      action={
        <select className={`${fieldClass} !w-auto !py-1.5 text-xs`} value={filter} onChange={(e) => onFilter(e.target.value as 'action' | 'all')} aria-label="Filter parts">
          <option value="action">Needs attention</option>
          <option value="all">All parts with demand data</option>
        </select>
      }
    >
      {shown.length === 0 ? (
        <EmptyState
          icon={Check}
          title={rows.length === 0 ? 'No demand forecast available' : 'Every part is covered'}
          description={rows.length === 0 ? 'Forecasts appear once parts have stock levels and usage history in Parts & Inventory.' : 'Stock and inbound orders cover lead times plus the safety buffer for every part.'}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-wide text-text-secondary">
                <th scope="col" className="py-2 pr-2">Part</th>
                <th scope="col" className="py-2 pr-2">On hand</th>
                <th scope="col" className="py-2 pr-2">Usage / day</th>
                <th scope="col" className="py-2 pr-2">Runway</th>
                <th scope="col" className="py-2 pr-2">Inbound</th>
                <th scope="col" className="py-2 pr-2">Lead</th>
                <th scope="col" className="py-2 pr-2">Reorder by</th>
                <th scope="col" className="py-2 pr-2">Status</th>
                <th scope="col" className="py-2 pr-2">Recommended</th>
                <th scope="col" className="py-2 pr-2">Price outlook</th>
                <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const id = `outlook:${r.partId}`;
                const canRequest = r.primary && r.recommendedQty > 0 && (r.status === 'order_now' || r.status === 'watch');
                return (
                  <tr key={r.partId} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-2">
                      <span className="font-medium text-text-primary">{r.partName}</span>
                      {r.partNumber && <span className="block text-[11px] text-text-secondary">{r.partNumber}</span>}
                      {r.singleSource && <span className="block text-[11px] text-amber-600 dark:text-amber-400">Single source</span>}
                      {r.noSupplier && <span className="block text-[11px] text-rose-600 dark:text-rose-400">No supplier on record</span>}
                    </td>
                    <td className="py-2 pr-2 tabular-nums">{r.available}</td>
                    <td className="py-2 pr-2 tabular-nums">
                      {r.dailyUsage}
                      {r.demandTrend !== 'flat' && (
                        <span className="ml-1 inline-flex align-middle text-text-secondary" title={`Demand ${r.demandTrend}`}>
                          {r.demandTrend === 'rising' ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-2 tabular-nums">{r.daysOfStock === null ? '—' : daysFmt(r.daysOfStock)}</td>
                    <td className="py-2 pr-2 tabular-nums">
                      {r.inboundQty > 0 ? r.inboundQty : '—'}
                      {r.inboundLate && <span className="block text-[11px] text-amber-600 dark:text-amber-400">arrives late</span>}
                    </td>
                    <td className="py-2 pr-2 tabular-nums">{daysFmt(r.leadTimeDays)}</td>
                    <td className="py-2 pr-2 tabular-nums">{r.status === 'order_now' ? 'Today' : fmtDate(r.reorderByDate)}</td>
                    <td className="py-2 pr-2"><Chip tone={STATUS_META[r.status].tone}>{STATUS_META[r.status].label}</Chip></td>
                    <td className="py-2 pr-2">
                      {r.recommendedQty > 0 && r.primary ? (
                        <>
                          <span className="tabular-nums text-text-primary">{r.recommendedQty} × {r.primary.name}</span>
                          {r.estimatedCostCents !== null && <span className="block text-[11px] text-text-secondary">{money(r.estimatedCostCents)} landed</span>}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 pr-2 tabular-nums">
                      {r.priceOutlookPct30 === null ? '—' : (
                        <span className={r.priceOutlookPct30 >= 3 ? 'text-amber-600 dark:text-amber-400' : r.priceOutlookPct30 <= -3 ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                          {r.priceOutlookPct30 > 0 ? '+' : ''}{Math.round(r.priceOutlookPct30)}%/mo
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-col items-end gap-1.5">
                        {canRequest && r.primary && (
                          <ActionButton
                            id={id}
                            action={{
                              type: 'create_purchase_request',
                              partId: r.partId,
                              quantity: r.recommendedQty,
                              neededBy: r.stockoutDate,
                              note: `Supplier Intelligence: recommended supplier ${r.primary.name}.`,
                            }}
                            working={working}
                            done={done}
                            onRequest={onRequest}
                          />
                        )}
                        <button type="button" className={secondaryBtn} onClick={() => onCompare(r.partId, r.recommendedQty)}>
                          Compare
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {visible.length > OUTLOOK_RENDER_LIMIT && (
        <p className="mt-3 text-[11px] text-text-secondary">
          Showing the {OUTLOOK_RENDER_LIMIT} most urgent of {visible.length} parts.
        </p>
      )}
      <p className="mt-3 text-[11px] text-text-secondary">
        Runway = available stock ÷ projected daily usage (rising demand +15%, falling −10%). Reorder-by = runway minus
        the best supplier&apos;s lead time and a 2-day buffer. Inbound orders count only if they arrive before stock runs out.
      </p>
    </Panel>
  );
}

// ============================================================
// RISK
// ============================================================

const SEGMENT_COLORS = ['bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-violet-500', 'bg-rose-500', 'bg-teal-500'];

function RiskTab({
  suppliers, hhi, level, partName, onOpenSupplier,
}: {
  suppliers: ScoredSupplier[];
  hhi: number;
  level: RiskLevel;
  partName: (id: string) => string;
  onOpenSupplier: (key: string) => void;
}) {
  const bySpend = [...suppliers].filter((s) => s.spendShare > 0).sort((a, b) => b.spendShare - a.spendShare);
  const top = bySpend.slice(0, 6);
  const otherShare = Math.max(0, 1 - top.reduce((a, s) => a + s.spendShare, 0));
  const byRisk = [...suppliers].sort((a, b) => b.risk.score - a.risk.score);
  const sole = suppliers
    .filter((s) => s.singleSourcePartIds.length > 0)
    .sort((a, b) => b.singleSourcePartIds.length - a.singleSourcePartIds.length);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Spend concentration (12 months)" action={<RiskChip level={level} />}>
        {top.length === 0 ? (
          <p className="py-3 text-xs text-text-secondary">No qualifying purchase orders in the last 12 months.</p>
        ) : (
          <>
            <div className="flex h-3 overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label="Share of spend by supplier">
              {top.map((s, i) => (
                <div key={s.key} className={SEGMENT_COLORS[i % SEGMENT_COLORS.length]} style={{ width: `${s.spendShare * 100}%` }} title={`${s.name}: ${pctFmt(s.spendShare)}`} />
              ))}
              {otherShare > 0.001 && <div className="bg-slate-400" style={{ width: `${otherShare * 100}%` }} />}
            </div>
            <ul className="mt-3 space-y-1.5 text-xs">
              {top.map((s, i) => (
                <li key={s.key} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${SEGMENT_COLORS[i % SEGMENT_COLORS.length]}`} />
                    <button type="button" onClick={() => onOpenSupplier(s.key)} className="focus-ring truncate rounded text-left text-text-primary">{s.name}</button>
                  </span>
                  <span className="shrink-0 tabular-nums text-text-secondary">{pctFmt(s.spendShare)} · {money(s.spend12mCents)}</span>
                </li>
              ))}
              {otherShare > 0.001 && (
                <li className="flex justify-between text-text-secondary"><span>Other suppliers</span><span className="tabular-nums">{pctFmt(otherShare)}</span></li>
              )}
            </ul>
            <p className="mt-3 text-[11px] text-text-secondary">
              Herfindahl index {hhi.toLocaleString()} — under 1,500 is diversified, over 2,500 is concentrated, over 4,000 means
              one or two suppliers hold the business.
            </p>
          </>
        )}
      </Panel>

      <Panel title="Sole-source exposure">
        {sole.length === 0 ? (
          <p className="py-3 text-xs text-text-secondary">Every part with a supplier on record has at least one alternative.</p>
        ) : (
          <ul className="space-y-3">
            {sole.slice(0, 8).map((s) => (
              <li key={s.key} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <button type="button" onClick={() => onOpenSupplier(s.key)} className="focus-ring truncate rounded text-left font-medium text-text-primary">{s.name}</button>
                  <span className="shrink-0 text-text-secondary">{s.singleSourcePartIds.length} part(s)</span>
                </div>
                <p className="text-[11px] text-text-secondary">
                  {s.singleSourcePartIds.slice(0, 5).map(partName).join(', ')}
                  {s.singleSourcePartIds.length > 5 ? ` +${s.singleSourcePartIds.length - 5} more` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="lg:col-span-2">
        <Panel title="Supplier risk register">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase tracking-wide text-text-secondary">
                  <th scope="col" className="py-2 pr-2">Supplier</th>
                  <th scope="col" className="py-2 pr-2">Risk</th>
                  <th scope="col" className="py-2 pr-2">Biggest drivers</th>
                  <th scope="col" className="py-2">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {byRisk.map((s) => {
                  const drivers = [...s.risk.factors].sort((a, b) => b.score * b.weight - a.score * a.weight).slice(0, 2);
                  return (
                    <tr key={s.key} className="border-b border-border/60">
                      <td className="py-2 pr-2">
                        <button type="button" onClick={() => onOpenSupplier(s.key)} className="focus-ring flex items-center gap-1.5 rounded text-left font-medium text-text-primary">
                          {s.risk.level === 'critical' || s.risk.level === 'high' ? <ShieldAlert size={13} className="text-rose-500" /> : null}
                          {s.name}
                        </button>
                      </td>
                      <td className="py-2 pr-2"><RiskChip level={s.risk.level} score={s.risk.score} /></td>
                      <td className="py-2 pr-2 text-text-secondary">{drivers.map((d) => d.label).join(' · ')}</td>
                      <td className="py-2 text-text-secondary">{CONFIDENCE_LABEL[s.confidence]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}
