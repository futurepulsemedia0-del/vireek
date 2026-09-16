import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  DollarSign,
  TrendingDown,
  TrendingUp,
  Percent,
  Search,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Pencil,
  Trash2,
  Check,
  Loader2,
  Lock,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TeamMember } from '@/lib/supabase';
import { PriceBookItem } from '@/lib/priceBook';
import {
  CostCategory,
  JobCostEntry,
  JobProfitability,
  JobCostFormState,
  EMPTY_JOB_COST_FORM,
  COST_CATEGORY_LABELS,
  COST_CATEGORY_COLORS,
  entryToForm,
  marginBadgeColor,
  formatMargin,
  formatCents,
  summarize,
  buildCategoryBreakdown,
  fetchProfitabilityRows,
  fetchCostEntries,
  saveCostEntry,
  deleteCostEntry,
} from '@/lib/jobCosting';
import { supabase } from '@/lib/supabase';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

// ============================================================
// SHARED UI
// ============================================================

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

function MarginBadge({ marginPct }: { marginPct: number | null }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${marginBadgeColor(marginPct)}`}>
      {marginPct !== null && (marginPct < 0 ? <TrendingDown size={11} /> : <TrendingUp size={11} />)}
      {marginPct === null ? 'No revenue yet' : formatMargin(marginPct)}
    </span>
  );
}

// ============================================================
// CATEGORY BREAKDOWN (horizontal bars) — driven by the view's
// per-category columns on whatever rows are currently filtered.
// ============================================================

function CategoryBreakdownChart({ rows }: { rows: JobProfitability[] }) {
  const breakdown = useMemo(() => buildCategoryBreakdown(rows), [rows]);
  const maxVal = Math.max(...breakdown.map((b) => b.totalCents), 1);

  if (breakdown.length === 0) {
    return <p className="py-8 text-center text-sm text-text-secondary">No costs logged yet.</p>;
  }

  return (
    <div className="space-y-3">
      {breakdown.map((b, i) => (
        <div key={b.category} className="flex items-center gap-3">
          <span className="w-28 shrink-0 text-xs font-medium text-text-secondary">{COST_CATEGORY_LABELS[b.category]}</span>
          <div className="h-6 flex-1 overflow-hidden rounded-md bg-bg-tertiary">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(b.totalCents / maxVal) * 100}%` }}
              transition={{ duration: 0.5, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="h-full rounded-md"
              style={{ backgroundColor: COST_CATEGORY_COLORS[b.category] }}
            />
          </div>
          <span className="w-20 shrink-0 text-right text-xs font-semibold text-text-primary">{formatCents(b.totalCents)}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// COST ENTRY FORM (inline add / edit — with technician + price
// book item linking)
// ============================================================

function CostEntryForm({
  jobId,
  entry,
  technicians,
  priceBookItems,
  onSaved,
  onCancel,
}: {
  jobId: string;
  entry?: JobCostEntry;
  technicians: TeamMember[];
  priceBookItems: PriceBookItem[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [form, setForm] = useState<JobCostFormState>(entry ? entryToForm(entry) : EMPTY_JOB_COST_FORM);
  const [saving, setSaving] = useState(false);

  const handleTechPick = (techId: string) => {
    const tech = technicians.find((t) => t.id === techId);
    setForm((f) => ({
      ...f,
      team_member_id: techId,
      unit_cost: tech?.hourly_cost_rate_cents != null ? String(tech.hourly_cost_rate_cents / 100) : f.unit_cost,
    }));
  };

  const handleItemPick = (itemId: string) => {
    const item = priceBookItems.find((i) => i.id === itemId);
    setForm((f) => ({
      ...f,
      price_book_item_id: itemId,
      description: f.description || item?.service_name || '',
      unit_cost: item?.cost_cents != null ? String(item.cost_cents / 100) : f.unit_cost,
    }));
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await saveCostEntry(form, jobId, user.id, entry?.id);
      toast('Cost saved', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this cost', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as CostCategory }))} className={inputClass}>
          {(Object.keys(COST_CATEGORY_LABELS) as CostCategory[]).map((c) => (
            <option key={c} value={c}>{COST_CATEGORY_LABELS[c]}</option>
          ))}
        </select>
        <input type="number" min={0} step="0.01" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} placeholder="Qty" className={inputClass} />
        <input type="number" min={0} step="0.01" value={form.unit_cost} onChange={(e) => setForm((f) => ({ ...f, unit_cost: e.target.value }))} placeholder="Unit cost ($)" className={inputClass} />
      </div>

      <input
        type="text"
        value={form.description}
        onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        placeholder="Description, e.g. 2hrs labor — drain snake"
        className={`${inputClass} mt-3`}
      />

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <select value={form.team_member_id} onChange={(e) => handleTechPick(e.target.value)} className={inputClass}>
          <option value="">Link technician (optional)</option>
          {technicians.map((t) => (
            <option key={t.id} value={t.id}>{t.member_name ?? t.member_email}</option>
          ))}
        </select>
        <select value={form.price_book_item_id} onChange={(e) => handleItemPick(e.target.value)} className={inputClass}>
          <option value="">Link price book item (optional)</option>
          {priceBookItems.map((i) => (
            <option key={i.id} value={i.id}>{i.service_name}</option>
          ))}
        </select>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="focus-ring flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
          <X size={14} /> Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          Save cost
        </button>
      </div>
    </div>
  );
}

// ============================================================
// JOB ROW (expandable — lazy-loads its cost entries)
// ============================================================

function JobRow({
  row,
  technicians,
  priceBookItems,
  expanded,
  onToggle,
}: {
  row: JobProfitability;
  technicians: TeamMember[];
  priceBookItems: PriceBookItem[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { toast } = useToast();
  const [entries, setEntries] = useState<JobCostEntry[] | null>(null);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingEntry, setEditingEntry] = useState<JobCostEntry | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const tech = technicians.find((t) => t.id === row.assigned_technician_id) ?? null;

  const loadEntries = useCallback(async () => {
    setLoadingEntries(true);
    try {
      const data = await fetchCostEntries(row.job_id);
      setEntries(data);
    } catch {
      toast('Could not load cost entries', 'error');
    } finally {
      setLoadingEntries(false);
    }
  }, [row.job_id, toast]);

  useEffect(() => {
    if (expanded && entries === null) loadEntries();
  }, [expanded, entries, loadEntries]);

  const handleDelete = async () => {
    if (!deletingId) return;
    setDeleting(true);
    try {
      await deleteCostEntry(deletingId);
      setEntries((prev) => (prev ? prev.filter((e) => e.id !== deletingId) : prev));
      toast('Cost deleted', 'success');
      setDeletingId(null);
    } catch {
      toast('Could not delete this cost', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
      <button type="button" onClick={onToggle} className="focus-ring flex w-full items-center gap-3 px-5 py-4 text-left">
        {expanded ? <ChevronDown size={16} className="shrink-0 text-text-secondary" /> : <ChevronRight size={16} className="shrink-0 text-text-secondary" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{row.customer_name}</p>
          <p className="truncate text-xs text-text-secondary">
            {row.service_type ?? 'General'} · {tech ? (tech.member_name ?? tech.member_email) : 'Unassigned'} · {row.job_status}
          </p>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <p className="text-xs text-text-secondary">Revenue</p>
          <p className="text-sm font-semibold text-text-primary">{formatCents(row.revenue_cents)}</p>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <p className="text-xs text-text-secondary">Costs</p>
          <p className="text-sm font-semibold text-text-primary">{formatCents(row.total_cost_cents)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-text-secondary">Profit</p>
          <p className={`text-sm font-bold ${row.gross_profit_cents < 0 ? 'text-danger' : 'text-success-500'}`}>
            {formatCents(row.gross_profit_cents)}
          </p>
        </div>
        <div className="hidden shrink-0 sm:block">
          <MarginBadge marginPct={row.margin_pct} />
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-border"
          >
            <div className="space-y-2 p-4">
              <div className="mb-1 flex items-center justify-between sm:hidden">
                <MarginBadge marginPct={row.margin_pct} />
                <span className="text-xs text-text-secondary">
                  {formatCents(row.revenue_cents)} revenue · {formatCents(row.total_cost_cents)} costs
                </span>
              </div>

              {loadingEntries ? (
                <div className="h-10 animate-pulse rounded-xl bg-bg-tertiary" />
              ) : entries && entries.length > 0 ? (
                entries.map((entry) =>
                  editingEntry?.id === entry.id ? (
                    <CostEntryForm
                      key={entry.id}
                      jobId={row.job_id}
                      entry={entry}
                      technicians={technicians}
                      priceBookItems={priceBookItems}
                      onCancel={() => setEditingEntry(null)}
                      onSaved={() => {
                        setEditingEntry(null);
                        setEntries(null);
                      }}
                    />
                  ) : (
                    <div key={entry.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary px-4 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: COST_CATEGORY_COLORS[entry.category] }} />
                        <div className="min-w-0">
                          <p className="truncate text-sm text-text-primary">{entry.description}</p>
                          <p className="text-xs text-text-secondary">
                            {COST_CATEGORY_LABELS[entry.category]} · {entry.quantity} × {formatCents(entry.unit_cost_cents)}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-sm font-medium text-text-primary">{formatCents(entry.total_cost_cents)}</span>
                        <button type="button" onClick={() => setEditingEntry(entry)} className="focus-ring text-text-secondary hover:text-accent" aria-label="Edit cost">
                          <Pencil size={14} />
                        </button>
                        <button type="button" onClick={() => setDeletingId(entry.id)} className="focus-ring text-text-secondary hover:text-danger" aria-label="Delete cost">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ),
                )
              ) : (
                <p className="py-2 text-sm text-text-secondary">No costs logged for this job yet.</p>
              )}

              {adding ? (
                <CostEntryForm
                  jobId={row.job_id}
                  technicians={technicians}
                  priceBookItems={priceBookItems}
                  onCancel={() => setAdding(false)}
                  onSaved={() => {
                    setAdding(false);
                    setEntries(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="focus-ring flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:border-accent hover:text-accent"
                >
                  <Plus size={14} /> Add cost
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={!!deletingId}
        title="Delete this cost entry?"
        description="This will remove it from the job's profitability calculation. This can't be undone."
        confirmLabel="Yes, delete it"
        onConfirm={handleDelete}
        onCancel={() => setDeletingId(null)}
        loading={deleting}
      />
    </div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

type SortKey = 'margin_asc' | 'margin_desc' | 'profit_desc' | 'revenue_desc' | 'recent';
type StatusFilter = 'all' | JobProfitability['job_status'];

export function ProfitabilityPage() {
  const navigate = useNavigate();
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // Reuses the existing billing permission — profitability is financial data.
  const canAccess = isOwner || permissions.can_view_billing;

  const [rows, setRows] = useState<JobProfitability[]>([]);
  const [technicians, setTechnicians] = useState<TeamMember[]>([]);
  const [priceBookItems, setPriceBookItems] = useState<PriceBookItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [serviceFilter, setServiceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('margin_asc');
  const [expandedJobId, setExpandedJobId] = useState<string | null>(searchParams.get('job'));

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [rowsData, techRes, itemsRes] = await Promise.all([
        fetchProfitabilityRows(),
        supabase.from('team_members').select('*'),
        supabase.from('price_book_items').select('*').eq('active', true),
      ]);
      setRows(rowsData);
      setTechnicians((techRes.data as TeamMember[]) || []);
      setPriceBookItems((itemsRes.data as PriceBookItem[]) || []);
    } catch {
      toast('Could not load profitability data', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (canAccess) fetchAll();
    else setLoading(false);
  }, [canAccess, fetchAll]);

  // Consume the ?job= deep link once, then clean the URL.
  useEffect(() => {
    if (searchParams.get('job')) {
      searchParams.delete('job');
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const serviceTypes = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => r.service_type && set.add(r.service_type));
    return Array.from(set).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    let list = rows.filter((r) => {
      if (serviceFilter !== 'all' && r.service_type !== serviceFilter) return false;
      if (statusFilter !== 'all' && r.job_status !== statusFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const haystack = `${r.customer_name} ${r.service_type ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    list = [...list].sort((a, b) => {
      switch (sortKey) {
        case 'margin_asc':
          return (a.margin_pct ?? 999) - (b.margin_pct ?? 999);
        case 'margin_desc':
          return (b.margin_pct ?? -999) - (a.margin_pct ?? -999);
        case 'profit_desc':
          return b.gross_profit_cents - a.gross_profit_cents;
        case 'revenue_desc':
          return b.revenue_cents - a.revenue_cents;
        case 'recent':
        default:
          return new Date(b.scheduled_datetime ?? 0).getTime() - new Date(a.scheduled_datetime ?? 0).getTime();
      }
    });

    return list;
  }, [rows, search, serviceFilter, statusFilter, sortKey]);

  const summary = useMemo(() => summarize(filteredRows), [filteredRows]);

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Profitability">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Profitability access is restricted. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Profitability">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Profitability</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Revenue, cost and margin per job — log labor, material and other costs to see real profit, not just invoiced revenue.
            </p>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <SkeletonBlock className="h-4 w-24" />
              <SkeletonBlock className="mt-3 h-8 w-16" />
            </div>
          ))
        ) : (
          <>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Total Revenue</p>
              <p className="mt-2 text-3xl font-bold text-text-primary">{formatCents(summary.totalRevenueCents)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Total Costs</p>
              <p className="mt-2 text-3xl font-bold text-text-primary">{formatCents(summary.totalCostCents)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Gross Profit</p>
              <p className={`mt-2 text-3xl font-bold ${summary.totalProfitCents < 0 ? 'text-danger' : 'text-success-500'}`}>
                {formatCents(summary.totalProfitCents)}
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Avg. Margin</p>
              <p className="mt-2 flex items-center gap-1 text-3xl font-bold text-cta">
                {formatMargin(summary.avgMarginPct)}
                <Percent size={18} className="text-cta/60" />
              </p>
            </div>
          </>
        )}
      </div>

      {/* Cost breakdown by category */}
      <div className="mt-6">
        {loading ? (
          <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
            <SkeletonBlock className="h-5 w-48" />
            <SkeletonBlock className="mt-6 h-24 w-full" />
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
            <h3 className="text-sm font-semibold text-text-primary">Costs by Category</h3>
            <div className="mt-5">
              <CategoryBreakdownChart rows={filteredRows} />
            </div>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 sm:max-w-sm">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by customer or service type…"
            className={`${inputClass} pl-9`}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)} className={`${inputClass} w-auto`}>
            <option value="all">All service types</option>
            {serviceTypes.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className={`${inputClass} w-auto`}>
            <option value="all">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="en_route">En Route</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className={`${inputClass} w-auto`}>
            <option value="margin_asc">Lowest margin first</option>
            <option value="margin_desc">Highest margin first</option>
            <option value="profit_desc">Highest profit first</option>
            <option value="revenue_desc">Highest revenue first</option>
            <option value="recent">Most recent</option>
          </select>
        </div>
      </div>

      {/* Job list */}
      <div className="mt-6 space-y-3">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <SkeletonBlock className="h-4 w-48" />
              <SkeletonBlock className="mt-2 h-3 w-32" />
            </div>
          ))
        ) : filteredRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
              <DollarSign size={22} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">
              {rows.length === 0 ? 'No jobs to cost out yet' : 'No jobs match your filters'}
            </h3>
            <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
              {rows.length === 0 ? "Once jobs come in from calls, they'll show up here for cost tracking." : 'Try a different search term or filter.'}
            </p>
          </div>
        ) : (
          filteredRows.map((row) => (
            <JobRow
              key={row.job_id}
              row={row}
              technicians={technicians}
              priceBookItems={priceBookItems}
              expanded={expandedJobId === row.job_id}
              onToggle={() => setExpandedJobId((prev) => (prev === row.job_id ? null : row.job_id))}
            />
          ))
        )}
      </div>
    </DashboardLayout>
  );
}
