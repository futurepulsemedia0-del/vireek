import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Loader2,
  Lock,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Job } from '@/lib/supabase';
import {
  CostCategory,
  JobCostEntry,
  JobCostEntryInput,
  JobProfitability,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
  fetchJobsForCosting,
  fetchCostEntries,
  addCostEntry,
  updateCostEntry,
  deleteCostEntry,
  computeProfitability,
  marginTier,
  buildCategoryBreakdown,
  formatCurrency,
} from '@/lib/jobCosting';

// ============================================================
// SHARED UI
// ============================================================

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

const MARGIN_TIER_CLASS: Record<string, string> = {
  healthy: 'bg-success-500/10 text-success-500',
  thin: 'bg-warning-500/10 text-warning-500',
  loss: 'bg-danger/10 text-danger',
  unknown: 'bg-bg-tertiary text-text-secondary',
};

function MarginBadge({ marginPct }: { marginPct: number | null }) {
  const tier = marginTier(marginPct);
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${MARGIN_TIER_CLASS[tier]}`}>
      {marginPct === null ? 'No revenue yet' : `${marginPct.toFixed(0)}% margin`}
    </span>
  );
}

// ============================================================
// CATEGORY BREAKDOWN (horizontal bars)
// ============================================================

function CategoryBreakdownChart({ entries }: { entries: JobCostEntry[] }) {
  const breakdown = useMemo(() => buildCategoryBreakdown(entries), [entries]);
  const maxVal = Math.max(...breakdown.map((b) => b.total), 1);

  if (breakdown.length === 0) {
    return <p className="py-8 text-center text-sm text-text-secondary">No costs logged yet.</p>;
  }

  return (
    <div className="space-y-3">
      {breakdown.map((b, i) => (
        <div key={b.category} className="flex items-center gap-3">
          <span className="w-28 shrink-0 text-xs font-medium text-text-secondary">{CATEGORY_LABELS[b.category]}</span>
          <div className="h-6 flex-1 overflow-hidden rounded-md bg-bg-tertiary">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(b.total / maxVal) * 100}%` }}
              transition={{ duration: 0.5, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="h-full rounded-md"
              style={{ backgroundColor: CATEGORY_COLORS[b.category] }}
            />
          </div>
          <span className="w-20 shrink-0 text-right text-xs font-semibold text-text-primary">{formatCurrency(b.total)}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// COST ENTRY MODAL (add / edit)
// ============================================================

function CostEntryModal({
  initial,
  onClose,
  onSave,
  submitting,
}: {
  initial?: JobCostEntry;
  onClose: () => void;
  onSave: (input: JobCostEntryInput) => void;
  submitting: boolean;
}) {
  const [category, setCategory] = useState<CostCategory>(initial?.category ?? 'labor');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');

  const parsedAmount = parseFloat(amount);
  const canSubmit = description.trim().length > 0 && !Number.isNaN(parsedAmount) && parsedAmount > 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.25 }}
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-bold text-text-primary">{initial ? 'Edit Cost' : 'Add Cost'}</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label className="text-xs font-medium text-text-secondary">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as CostCategory)}
              className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            >
              {(Object.keys(CATEGORY_LABELS) as CostCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-text-secondary">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Copper piping, 2 technicians x 3 hrs"
              className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-text-secondary">Amount ($)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button type="button" onClick={onClose} className="focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={() => onSave({ category, description: description.trim(), amount: parsedAmount })}
            className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {initial ? 'Save Changes' : 'Add Cost'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================
// DELETE CONFIRM MODAL
// ============================================================

function DeleteConfirmModal({ onClose, onConfirm, submitting }: { onClose: () => void; onConfirm: () => void; submitting: boolean }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
        className="relative w-full max-w-sm rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-danger/10 text-danger">
          <Trash2 size={20} />
        </span>
        <h2 className="mt-4 text-base font-bold text-text-primary">Delete this cost entry?</h2>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">This will remove it from the job's profitability calculation. This can't be undone.</p>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary">
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={onConfirm}
            className="focus-ring flex items-center gap-2 rounded-xl bg-danger px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            Delete
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================
// JOB ROW (expandable)
// ============================================================

function JobRow({
  data,
  expanded,
  onToggle,
  onAddCost,
  onEditCost,
  onDeleteCost,
}: {
  data: JobProfitability;
  expanded: boolean;
  onToggle: () => void;
  onAddCost: () => void;
  onEditCost: (entry: JobCostEntry) => void;
  onDeleteCost: (entry: JobCostEntry) => void;
}) {
  const { job, costEntries, revenue, totalCost, profit, marginPct } = data;
  const isLoss = profit < 0;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
      <button type="button" onClick={onToggle} className="focus-ring flex w-full items-center gap-3 px-5 py-4 text-left">
        {expanded ? <ChevronDown size={16} className="shrink-0 text-text-secondary" /> : <ChevronRight size={16} className="shrink-0 text-text-secondary" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{job.customer_name}</p>
          <p className="truncate text-xs text-text-secondary">
            {job.service_type ?? 'No service type'} · {job.job_status}
          </p>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <p className="text-xs text-text-secondary">Revenue</p>
          <p className="text-sm font-semibold text-text-primary">{formatCurrency(revenue)}</p>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <p className="text-xs text-text-secondary">Costs</p>
          <p className="text-sm font-semibold text-text-primary">{formatCurrency(totalCost)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-text-secondary">Profit</p>
          <p className={`flex items-center justify-end gap-1 text-sm font-bold ${isLoss ? 'text-danger' : 'text-success-500'}`}>
            {isLoss ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
            {formatCurrency(profit)}
          </p>
        </div>
        <div className="hidden shrink-0 sm:block">
          <MarginBadge marginPct={marginPct} />
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="border-t border-border px-5 py-4">
              <div className="mb-3 flex items-center justify-between sm:hidden">
                <MarginBadge marginPct={marginPct} />
                <span className="text-xs text-text-secondary">
                  {formatCurrency(revenue)} revenue · {formatCurrency(totalCost)} costs
                </span>
              </div>

              {costEntries.length === 0 ? (
                <p className="py-2 text-sm text-text-secondary">No costs logged for this job yet.</p>
              ) : (
                <div className="space-y-2">
                  {costEntries.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between gap-3 rounded-lg bg-bg-tertiary/50 px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[entry.category] }} />
                        <div className="min-w-0">
                          <p className="truncate text-sm text-text-primary">{entry.description}</p>
                          <p className="text-xs text-text-secondary">{CATEGORY_LABELS[entry.category]}</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-sm font-semibold text-text-primary">{formatCurrency(entry.amount)}</span>
                        <button
                          type="button"
                          onClick={() => onEditCost(entry)}
                          className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                          aria-label="Edit cost"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteCost(entry)}
                          className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-danger/10 hover:text-danger"
                          aria-label="Delete cost"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <button type="button" onClick={onAddCost} className="focus-ring mt-3 flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
                <Plus size={14} /> Add cost
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

type SortKey = 'margin_asc' | 'margin_desc' | 'profit_desc' | 'revenue_desc' | 'recent';

export function ProfitabilityPage() {
  const navigate = useNavigate();
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();

  // Reuses the existing billing permission — profitability is financial data.
  const canAccess = isOwner || permissions.can_view_billing;

  const [jobs, setJobs] = useState<Job[]>([]);
  const [costEntries, setCostEntries] = useState<JobCostEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [serviceFilter, setServiceFilter] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey>('margin_asc');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [costModal, setCostModal] = useState<{ jobId: string; entry?: JobCostEntry } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<JobCostEntry | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [jobsData, entriesData] = await Promise.all([fetchJobsForCosting(), fetchCostEntries()]);
      setJobs(jobsData);
      setCostEntries(entriesData);
    } catch {
      toast('Could not load profitability data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const entriesByJob = useMemo(() => {
    const map = new Map<string, JobCostEntry[]>();
    costEntries.forEach((e) => {
      const list = map.get(e.job_id) ?? [];
      list.push(e);
      map.set(e.job_id, list);
    });
    return map;
  }, [costEntries]);

  const profitability = useMemo(() => jobs.map((job) => computeProfitability(job, entriesByJob.get(job.id) ?? [])), [jobs, entriesByJob]);

  const serviceTypes = useMemo(() => {
    const set = new Set<string>();
    jobs.forEach((j) => j.service_type && set.add(j.service_type));
    return Array.from(set).sort();
  }, [jobs]);

  const filtered = useMemo(() => {
    let list = profitability.filter((p) => {
      if (serviceFilter !== 'all' && p.job.service_type !== serviceFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const haystack = `${p.job.customer_name} ${p.job.service_type ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    list = [...list].sort((a, b) => {
      switch (sortKey) {
        case 'margin_asc':
          return (a.marginPct ?? 999) - (b.marginPct ?? 999);
        case 'margin_desc':
          return (b.marginPct ?? -999) - (a.marginPct ?? -999);
        case 'profit_desc':
          return b.profit - a.profit;
        case 'revenue_desc':
          return b.revenue - a.revenue;
        case 'recent':
        default:
          return new Date(b.job.created_at).getTime() - new Date(a.job.created_at).getTime();
      }
    });

    return list;
  }, [profitability, search, serviceFilter, sortKey]);

  const kpis = useMemo(() => {
    const totalRevenue = profitability.reduce((sum, p) => sum + p.revenue, 0);
    const totalCost = profitability.reduce((sum, p) => sum + p.totalCost, 0);
    const grossProfit = totalRevenue - totalCost;
    const withRevenue = profitability.filter((p) => p.marginPct !== null);
    const avgMargin = withRevenue.length > 0 ? withRevenue.reduce((s, p) => s + (p.marginPct ?? 0), 0) / withRevenue.length : null;
    return { totalRevenue, totalCost, grossProfit, avgMargin };
  }, [profitability]);

  const handleSaveCost = async (input: JobCostEntryInput) => {
    if (!costModal) return;
    setSubmitting(true);
    try {
      if (costModal.entry) {
        await updateCostEntry(costModal.entry.id, input);
      } else {
        await addCostEntry(costModal.jobId, input);
      }
      toast(costModal.entry ? 'Cost updated.' : 'Cost added.', 'success');
      setCostModal(null);
      loadData();
    } catch {
      toast('Could not save this cost entry.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteCost = async () => {
    if (!deleteTarget) return;
    setSubmitting(true);
    try {
      await deleteCostEntry(deleteTarget.id);
      toast('Cost entry deleted.', 'success');
      setDeleteTarget(null);
      loadData();
    } catch {
      toast('Could not delete this cost entry.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

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
            <p className="mt-1 text-sm text-text-secondary">Track real margin per job — revenue against actual cost.</p>
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
              <p className="mt-2 text-3xl font-bold text-text-primary">{formatCurrency(kpis.totalRevenue)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Total Costs</p>
              <p className="mt-2 text-3xl font-bold text-text-primary">{formatCurrency(kpis.totalCost)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Gross Profit</p>
              <p className={`mt-2 text-3xl font-bold ${kpis.grossProfit < 0 ? 'text-danger' : 'text-success-500'}`}>
                {formatCurrency(kpis.grossProfit)}
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Avg. Margin</p>
              <p className="mt-2 flex items-center gap-1 text-3xl font-bold text-cta">
                {kpis.avgMargin === null ? '—' : `${kpis.avgMargin.toFixed(0)}%`}
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
              <CategoryBreakdownChart entries={costEntries} />
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
            className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-9 pr-3 text-sm text-text-primary"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value)}
            className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary"
          >
            <option value="all">All service types</option>
            {serviceTypes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary"
          >
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
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
              <DollarSign size={22} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">
              {jobs.length === 0 ? 'No jobs to cost out yet' : 'No jobs match your filters'}
            </h3>
            <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
              {jobs.length === 0 ? "Once jobs come in from calls, they'll show up here for cost tracking." : 'Try a different search term or service type.'}
            </p>
          </div>
        ) : (
          filtered.map((data) => (
            <JobRow
              key={data.job.id}
              data={data}
              expanded={expandedId === data.job.id}
              onToggle={() => setExpandedId(expandedId === data.job.id ? null : data.job.id)}
              onAddCost={() => setCostModal({ jobId: data.job.id })}
              onEditCost={(entry) => setCostModal({ jobId: data.job.id, entry })}
              onDeleteCost={(entry) => setDeleteTarget(entry)}
            />
          ))
        )}
      </div>

      {costModal && (
        <CostEntryModal initial={costModal.entry} onClose={() => setCostModal(null)} onSave={handleSaveCost} submitting={submitting} />
      )}

      {deleteTarget && <DeleteConfirmModal onClose={() => setDeleteTarget(null)} onConfirm={handleDeleteCost} submitting={submitting} />}
    </DashboardLayout>
  );
}
