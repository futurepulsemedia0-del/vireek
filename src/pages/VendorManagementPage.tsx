/**
 * Vendor Management — /dashboard/vendors
 *
 * The relationship layer on top of Vendor & Procurement OS: who our vendors are,
 * how they perform, what they cost, whether they're compliant, what we owe them
 * and what needs attention. RFQs, purchase orders and receiving stay in
 * /dashboard/procurement; paying bills stays in /dashboard/accounting — this
 * page links to both instead of duplicating them.
 *
 * Domain logic (scoring, alerts, pricing, filters) lives in
 * src/lib/vendorManagement.ts and is unit-tested; this file is the UI only.
 * Deep-linkable: ?vendor=<id>&tab=<tab>&view=<directory|attention|pricing>.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDownUp, Building2, Download, Plus, Search, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { exportToCsv } from '@/lib/csvExport';
import { formatCents } from '@/lib/procurement';
import {
  DEFAULT_VENDOR_FILTERS,
  PRICE_HISTORY_LIMIT,
  RISK_LABELS,
  TIER_LABELS,
  TIER_OPTIONS,
  VENDOR_CSV_COLUMNS,
  analyzePricing,
  analyzeVendorPortfolio,
  fetchPriceHistory,
  fetchVendorOverview,
  filterAndSortVendors,
  formatDay,
  formatPct,
  isDetailTab,
  summarizePortfolio,
  vendorCategories,
} from '@/lib/vendorManagement';
import type {
  AlertSeverity,
  RiskLevel,
  VendorDetailTab,
  VendorFilters,
  VendorOverviewRow,
  VendorPriceRow,
  VendorSort,
  VendorSortKey,
  VendorTier,
} from '@/lib/vendorManagement';
import { VendorDetailPanel } from '@/components/vendors/VendorDetailPanel';
import { PerformanceBadge, Pill, RiskBadge, TierBadge } from '@/components/vendors/VendorBadges';
import { AddVendorModal } from '@/components/vendors/VendorForms';

type ViewKey = 'directory' | 'attention' | 'pricing';

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'directory', label: 'Vendors' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'pricing', label: 'Pricing' },
];

const SORT_OPTIONS: { key: VendorSortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'spend', label: 'Spend (12 mo)' },
  { key: 'risk', label: 'Risk' },
  { key: 'performance', label: 'Performance' },
  { key: 'payables', label: 'Open payables' },
  { key: 'recent', label: 'Last order' },
];

const SEVERITY_FILTERS: { key: AlertSeverity | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'warning', label: 'Warning' },
  { key: 'info', label: 'Info' },
];

const SEVERITY_CLASS: Record<AlertSeverity, string> = {
  critical: 'bg-danger/10 text-danger',
  warning: 'bg-warning-500/10 text-warning-500',
  info: 'bg-bg-tertiary text-text-secondary',
};

const selectCls =
  'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-3 text-sm text-text-primary';

function isView(value: string | null): value is ViewKey {
  return VIEWS.some((v) => v.key === value);
}

function KpiCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'danger' | 'warning' }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning-500' : 'text-text-primary';
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1.5 text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

export function VendorManagementPage() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();

  const [rows, setRows] = useState<VendorOverviewRow[] | null>(null);
  const [history, setHistory] = useState<VendorPriceRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [priceError, setPriceError] = useState(false);
  const [adding, setAdding] = useState(false);

  const [filters, setFilters] = useState<VendorFilters>(DEFAULT_VENDOR_FILTERS);
  const [sort, setSort] = useState<VendorSort>({ key: 'risk', dir: 'desc' });
  const [severity, setSeverity] = useState<AlertSeverity | 'all'>('all');

  const vendorId = params.get('vendor');
  const tabParam = params.get('tab');
  const viewParam = params.get('view');
  const view: ViewKey = isView(viewParam) ? viewParam : 'directory';
  const detailTab: VendorDetailTab = isDetailTab(tabParam) ? tabParam : 'overview';

  // ---------- data ----------

  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const [overview, prices] = await Promise.allSettled([fetchVendorOverview(), fetchPriceHistory()]);
    if (requestId !== requestRef.current) return; // a newer load superseded this one
    if (overview.status === 'fulfilled') {
      setRows(overview.value);
      setLoadError(false);
    } else {
      setLoadError(true);
    }
    if (prices.status === 'fulfilled') {
      setHistory(prices.value);
      setPriceError(false);
    } else {
      setPriceError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1; // ignore responses after unmount
    };
  }, [load]);

  const priceInsights = useMemo(() => analyzePricing(history), [history]);
  const portfolio = useMemo(() => analyzeVendorPortfolio(rows ?? [], priceInsights), [rows, priceInsights]);
  const summary = useMemo(() => summarizePortfolio(portfolio.insights), [portfolio.insights]);
  const categories = useMemo(() => vendorCategories(rows ?? []), [rows]);
  const visible = useMemo(
    () => filterAndSortVendors(portfolio.insights, filters, sort),
    [portfolio.insights, filters, sort],
  );
  const vendorNames = useMemo(() => new Map((rows ?? []).map((r) => [r.vendor_id, r.name])), [rows]);
  const linkedInventoryIds = useMemo(
    () => (rows ?? []).map((r) => r.inventory_vendor_id).filter((id): id is string => id !== null),
    [rows],
  );

  // ---------- navigation (URL is the source of truth) ----------

  const update = useCallback(
    (patch: Record<string, string | null>, replace = false) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace },
      );
    },
    [setParams],
  );

  const openVendor = (id: string, tab: VendorDetailTab = 'overview') => update({ vendor: id, tab });
  const closeVendor = () => update({ vendor: null, tab: null });
  const setView = (v: ViewKey) => update({ view: v === 'directory' ? null : v });

  const setFilter = <K extends keyof VendorFilters>(key: K, value: VendorFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(DEFAULT_VENDOR_FILTERS);

  // ---------- derived for current view ----------

  const alertsShown = useMemo(
    () => (severity === 'all' ? portfolio.alerts : portfolio.alerts.filter((a) => a.severity === severity)),
    [portfolio.alerts, severity],
  );

  const priceUps = useMemo(
    () =>
      priceInsights
        .filter((p) => p.trend === 'up' && p.changePct !== null && (vendorNames.has(p.vendorId)))
        .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
        .slice(0, 25),
    [priceInsights, vendorNames],
  );
  const savingsOps = useMemo(
    () =>
      priceInsights
        .filter((p) => p.premiumPct !== null && vendorNames.has(p.vendorId))
        .sort((a, b) => b.potentialSavingsCents - a.potentialSavingsCents)
        .slice(0, 25),
    [priceInsights, vendorNames],
  );
  const totalSavings = savingsOps.reduce((s, p) => s + p.potentialSavingsCents, 0);

  const handleExport = () => {
    if (visible.length === 0) {
      toast('There are no vendors to export', 'info');
      return;
    }
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    exportToCsv(visible, VENDOR_CSV_COLUMNS, `vendors-${stamp}.csv`);
  };

  const handleCreated = async (id: string) => {
    await load();
    openVendor(id);
  };

  // ---------- render ----------

  const selected = vendorId && rows ? portfolio.insights.find((i) => i.row.vendor_id === vendorId) ?? null : null;

  let body: ReactNode;
  if (rows === null && !loadError) {
    body = (
      <div className="space-y-4" aria-busy="true">
        <SkeletonStatGrid count={4} />
        <SkeletonCardList count={5} rows={2} />
      </div>
    );
  } else if (rows === null) {
    body = (
      <EmptyState
        icon={TriangleAlert}
        title="Could not load vendors"
        description="Check your connection and try again. If this keeps happening, the latest database migration may not be applied yet."
        action={{ label: 'Try again', onClick: () => void load() }}
      />
    );
  } else if (vendorId) {
    body = selected ? (
      <VendorDetailPanel
        insight={selected}
        alerts={portfolio.alerts.filter((a) => a.vendorId === selected.row.vendor_id)}
        priceInsights={priceInsights.filter((p) => p.vendorId === selected.row.vendor_id)}
        vendorNames={vendorNames}
        linkedInventoryIds={linkedInventoryIds}
        tab={detailTab}
        onTab={(t) => update({ tab: t }, true)}
        onBack={closeVendor}
        onChanged={() => void load()}
      />
    ) : (
      <EmptyState
        icon={Building2}
        title="Vendor not found"
        description="This vendor may have been removed, or the link is out of date."
        action={{ label: 'Back to all vendors', onClick: closeVendor }}
      />
    );
  } else {
    body = (
      <div className="space-y-4">
        {loadError && (
          <p role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            <span>Could not refresh vendor data — showing the last loaded version.</span>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard label="Active vendors" value={String(summary.activeVendors)} sub={`${summary.totalVendors} total`} />
          <KpiCard label="Spend (12 months)" value={formatCents(summary.spend12mCents)} sub={`${formatCents(summary.openPoCents)} on open POs`} />
          <KpiCard
            label="Open payables"
            value={formatCents(summary.openPayablesCents)}
            sub={summary.overduePayablesCents > 0 ? `${formatCents(summary.overduePayablesCents)} overdue` : 'Nothing overdue'}
            tone={summary.overduePayablesCents > 0 ? 'danger' : undefined}
          />
          <KpiCard label="Avg. performance" value={summary.avgPerformance === null ? '—' : `${summary.avgPerformance}/100`} sub="Scored vendors only" />
          <KpiCard
            label="High-risk vendors"
            value={String(summary.highRiskCount)}
            tone={summary.highRiskCount > 0 ? 'warning' : undefined}
          />
          <KpiCard
            label="Compliance gaps"
            value={String(summary.complianceGapCount)}
            sub={`${summary.contractsExpiringCount} contract${summary.contractsExpiringCount === 1 ? '' : 's'} to renew`}
            tone={summary.complianceGapCount > 0 ? 'warning' : undefined}
          />
        </div>

        <div role="tablist" aria-label="Vendor views" className="flex flex-wrap gap-1.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
              className={`focus-ring flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
                view === v.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              {v.label}
              {v.key === 'attention' && portfolio.alerts.length > 0 && (
                <span className="rounded-full bg-danger/10 px-1.5 text-[10px] font-bold text-danger">{portfolio.alerts.length}</span>
              )}
            </button>
          ))}
        </div>

        {view === 'directory' && (
          <>
            <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-3">
              <Input
                icon={Search}
                type="search"
                aria-label="Search vendors"
                placeholder="Search by name, contact, email, category…"
                value={filters.query}
                onChange={(e) => setFilter('query', e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label="Filter by tier" className={selectCls} value={filters.tier} onChange={(e) => setFilter('tier', e.target.value as VendorTier | 'all')}>
                  <option value="all">All tiers</option>
                  {TIER_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {TIER_LABELS[t]}
                    </option>
                  ))}
                </select>
                <select aria-label="Filter by status" className={selectCls} value={filters.status} onChange={(e) => setFilter('status', e.target.value as VendorFilters['status'])}>
                  <option value="all">Active &amp; inactive</option>
                  <option value="active">Active only</option>
                  <option value="inactive">Inactive only</option>
                </select>
                {categories.length > 0 && (
                  <select aria-label="Filter by category" className={selectCls} value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
                    <option value="all">All categories</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
                <select aria-label="Filter by risk" className={selectCls} value={filters.risk} onChange={(e) => setFilter('risk', e.target.value as RiskLevel | 'all')}>
                  <option value="all">Any risk</option>
                  {(Object.keys(RISK_LABELS) as RiskLevel[]).map((r) => (
                    <option key={r} value={r}>
                      {RISK_LABELS[r]}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-text-primary">
                  <input type="checkbox" checked={filters.attention} onChange={(e) => setFilter('attention', e.target.checked)} />
                  Needs attention
                </label>
                <span className="ml-auto flex items-center gap-1.5">
                  <select aria-label="Sort by" className={selectCls} value={sort.key} onChange={(e) => setSort((s) => ({ ...s, key: e.target.value as VendorSortKey }))}>
                    {SORT_OPTIONS.map((o) => (
                      <option key={o.key} value={o.key}>
                        Sort: {o.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Sort direction: ${sort.dir === 'asc' ? 'ascending' : 'descending'}`}
                    onClick={() => setSort((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }))}
                  >
                    <ArrowDownUp size={14} /> {sort.dir === 'asc' ? 'Asc' : 'Desc'}
                  </Button>
                </span>
              </div>
              <p className="text-xs text-text-secondary" aria-live="polite">
                Showing {visible.length} of {portfolio.insights.length} vendors
                {filtersActive && (
                  <button type="button" className="focus-ring ml-2 font-medium text-accent hover:underline" onClick={() => setFilters(DEFAULT_VENDOR_FILTERS)}>
                    Clear filters
                  </button>
                )}
              </p>
            </div>

            {portfolio.insights.length === 0 ? (
              <EmptyState
                icon={Building2}
                title="No vendors yet"
                description="Add your suppliers to track performance, pricing, contracts and compliance in one place."
                action={{ label: 'Add vendor', onClick: () => setAdding(true) }}
              />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No vendors match these filters"
                description="Try a different search, or clear the filters."
                action={{ label: 'Clear filters', onClick: () => setFilters(DEFAULT_VENDOR_FILTERS) }}
              />
            ) : (
              <>
                <div className="hidden grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] gap-3 px-4 text-xs font-medium text-text-secondary md:grid">
                  <span>Vendor</span>
                  <span>Spend (12 mo)</span>
                  <span>Open payables</span>
                  <span>Performance</span>
                  <span>Risk</span>
                </div>
                <ul className="space-y-2">
                  {visible.map((i) => (
                    <li key={i.row.vendor_id}>
                      <button
                        type="button"
                        onClick={() => openVendor(i.row.vendor_id)}
                        className="focus-ring grid w-full gap-2 rounded-xl border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-accent/40 md:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] md:items-center md:gap-3"
                      >
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold text-text-primary">{i.row.name}</span>
                            <TierBadge tier={i.row.tier} />
                            {!i.row.active && <Pill className="bg-bg-tertiary text-text-secondary">Inactive</Pill>}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-text-secondary">
                            {i.row.category ?? 'Uncategorized'}
                            {i.row.last_order_at ? ` · last order ${formatDay(i.row.last_order_at)}` : ' · no orders yet'}
                          </span>
                        </span>
                        <span className="text-sm text-text-primary">
                          <span className="mr-1 text-xs text-text-secondary md:hidden">Spend:</span>
                          {formatCents(i.row.po_spend_12m_cents)}
                        </span>
                        <span className={`text-sm ${i.overduePayablesCents > 0 ? 'font-semibold text-danger' : 'text-text-primary'}`}>
                          <span className="mr-1 text-xs font-normal text-text-secondary md:hidden">Payables:</span>
                          {formatCents(i.openPayablesCents)}
                        </span>
                        <span>
                          <PerformanceBadge performance={i.performance} />
                        </span>
                        <span className="flex items-center gap-2">
                          <RiskBadge level={i.risk.level} score={i.risk.score} />
                          {i.alertCount > 0 && (
                            <span className="text-xs text-warning-500" title={`${i.alertCount} item${i.alertCount === 1 ? '' : 's'} need attention`}>
                              ⚠ {i.alertCount}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {view === 'attention' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter alerts by severity">
              {SEVERITY_FILTERS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={severity === s.key}
                  onClick={() => setSeverity(s.key)}
                  className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${
                    severity === s.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {alertsShown.length === 0 ? (
              <EmptyState
                icon={Building2}
                title={portfolio.alerts.length === 0 ? 'All clear' : 'Nothing at this severity'}
                description={
                  portfolio.alerts.length === 0
                    ? 'No overdue payables, late deliveries, compliance gaps or expiring contracts right now.'
                    : 'Try a different severity filter.'
                }
              />
            ) : (
              <ul className="space-y-2">
                {alertsShown.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => openVendor(a.vendorId, a.tab)}
                      className="focus-ring flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary p-4 text-left hover:border-accent/40"
                    >
                      <span>
                        <span className="block text-sm font-semibold text-text-primary">
                          {a.vendorName} <span className="font-normal text-text-secondary">· {a.title}</span>
                        </span>
                        <span className="block text-xs text-text-secondary">{a.detail}</span>
                      </span>
                      <Pill className={SEVERITY_CLASS[a.severity]}>{a.severity}</Pill>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {view === 'pricing' && (
          <div className="space-y-4">
            {priceError && (
              <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
                Could not load price history, so pricing insights may be incomplete.
              </p>
            )}
            {history.length >= PRICE_HISTORY_LIMIT && (
              <p className="text-xs text-text-secondary">Based on the {PRICE_HISTORY_LIMIT.toLocaleString()} most recent order lines.</p>
            )}
            {priceInsights.length === 0 ? (
              <EmptyState
                icon={Building2}
                title="No price history yet"
                description="Once purchase orders are placed, you will see price increases and cheaper-vendor opportunities here."
              />
            ) : (
              <>
                <div className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <h3 className="text-sm font-semibold text-text-primary">Savings opportunities</h3>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    Items where another vendor recently charged at least 5% less.
                    {totalSavings > 0 ? ` Total potential: ${formatCents(totalSavings)} on the latest orders.` : ''}
                  </p>
                  {savingsOps.length === 0 ? (
                    <p className="mt-3 text-sm text-text-secondary">No cheaper-vendor opportunities found.</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {savingsOps.map((p) => (
                        <li key={`${p.key}:${p.vendorId}`}>
                          <button
                            type="button"
                            onClick={() => openVendor(p.vendorId, 'pricing')}
                            className="focus-ring flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary p-3 text-left hover:border-accent/40"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-text-primary">{p.description}</span>
                              <span className="block text-xs text-text-secondary">
                                {vendorNames.get(p.vendorId)} charged {formatCents(p.latestCents)} — {formatPct(p.premiumPct)} above{' '}
                                {p.bestVendorId ? vendorNames.get(p.bestVendorId) ?? 'another vendor' : 'another vendor'} ({formatCents(p.bestPriceCents)})
                              </span>
                            </span>
                            <Pill className="bg-success-500/10 text-success-500">Save {formatCents(p.potentialSavingsCents)}</Pill>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <h3 className="text-sm font-semibold text-text-primary">Biggest price increases</h3>
                  <p className="mt-0.5 text-xs text-text-secondary">Compared with the same vendor&apos;s previous order of the item.</p>
                  {priceUps.length === 0 ? (
                    <p className="mt-3 text-sm text-text-secondary">No price increases detected.</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {priceUps.map((p) => (
                        <li key={`${p.key}:${p.vendorId}`}>
                          <button
                            type="button"
                            onClick={() => openVendor(p.vendorId, 'pricing')}
                            className="focus-ring flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary p-3 text-left hover:border-accent/40"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-text-primary">{p.description}</span>
                              <span className="block text-xs text-text-secondary">
                                {vendorNames.get(p.vendorId)} · {formatCents(p.previousCents)} → {formatCents(p.latestCents)}
                              </span>
                            </span>
                            <Pill className="bg-danger/10 text-danger">▲ {formatPct(p.changePct, 1)}</Pill>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <DashboardLayout activeLabel="Vendor Management">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Vendor Management</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Performance, pricing, contracts, compliance and payables for every vendor. Place orders in{' '}
              <Link to="/dashboard/procurement" className="focus-ring font-medium text-accent hover:underline">
                Procurement
              </Link>
              .
            </p>
          </div>
          {!vendorId && rows !== null && (
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={handleExport}>
                <Download size={14} /> Export CSV
              </Button>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus size={14} /> Add vendor
              </Button>
            </div>
          )}
        </div>
        {body}
      </div>
      {adding && <AddVendorModal onClose={() => setAdding(false)} onCreated={(id) => void handleCreated(id)} />}
    </DashboardLayout>
  );
}
