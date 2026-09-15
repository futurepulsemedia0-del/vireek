import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Brain,
  Download,
  Search,
  Info,
  Lock,
  Users,
  DollarSign,
  AlertTriangle,
  ShieldAlert,
  Heart,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Customer, Job } from '@/lib/supabase';
import { exportToCsv } from '@/lib/csvExport';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable, FadeIn } from '@/components/Skeleton';

// ============================================================
// TYPES
// ============================================================

type RiskTier = 'new' | 'healthy' | 'watch' | 'at_risk' | 'churned';

interface CustomerIntel {
  key: string;
  customerId: string | null;
  name: string;
  phone: string | null;
  lifecycleStage: Customer['lifecycle_stage'] | null;
  ltv: number;
  pendingRevenue: number;
  jobCount: number;
  firstJobAt: string;
  lastJobAt: string;
  avgCycleDays: number | null;
  daysSinceLastJob: number;
  predictedNextServiceAt: string | null;
  risk: RiskTier;
}

// ============================================================
// CONSTANTS / HELPERS
// ============================================================

const RISK_META: Record<RiskTier, { label: string; dot: string; text: string; bg: string; rank: number }> = {
  at_risk: { label: 'At Risk', dot: 'bg-danger', text: 'text-danger', bg: 'bg-danger/10', rank: 0 },
  churned: { label: 'Churned', dot: 'bg-text-secondary/50', text: 'text-text-secondary', bg: 'bg-bg-tertiary', rank: 1 },
  watch: { label: 'Watch', dot: 'bg-warning-500', text: 'text-warning-500', bg: 'bg-warning-500/10', rank: 2 },
  healthy: { label: 'Healthy', dot: 'bg-success-500', text: 'text-success', bg: 'bg-success/10', rank: 3 },
  new: { label: 'New', dot: 'bg-accent', text: 'text-accent', bg: 'bg-accent/10', rank: 4 },
};

function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

/**
 * Deliberately a transparent heuristic, not a trained ML model — this app
 * has no historical "did they actually churn" labels to train on. The
 * logic: compare a customer's own historical service cadence (average
 * days between their jobs) against how long it's been since their last
 * job. A customer overdue relative to their OWN normal rhythm is a much
 * stronger signal than a fixed day count, since a customer who calls
 * every 45 days behaves very differently from one who calls annually.
 * Single-job customers (no cadence yet) fall back to fixed day bands.
 * An explicit "inactive" lifecycle_stage set by the business owner in
 * Customers always wins — that's a human judgment call, not a guess.
 */
function computeRisk(jobCount: number, avgCycleDays: number | null, daysSinceLastJob: number, lifecycleStage: Customer['lifecycle_stage'] | null): RiskTier {
  if (lifecycleStage === 'inactive') return 'churned';

  if (jobCount === 1 || avgCycleDays === null) {
    if (daysSinceLastJob <= 30) return 'new';
    if (daysSinceLastJob <= 90) return 'healthy';
    if (daysSinceLastJob <= 180) return 'watch';
    return 'at_risk';
  }

  const cycle = Math.max(avgCycleDays, 14);
  const ratio = daysSinceLastJob / cycle;
  if (ratio <= 1) return 'healthy';
  if (ratio <= 1.75) return 'watch';
  return 'at_risk';
}

// ============================================================
// MAIN PAGE
// ============================================================

export function CustomerIntelligencePage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_view_billing;

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    if (!user || !canAccess) return;
    setLoading(true);
    try {
      const [customersRes, jobsRes] = await Promise.all([
        supabase.from('customers').select('*'),
        supabase.from('jobs').select('*').order('created_at', { ascending: true }),
      ]);
      if (customersRes.data) setCustomers(customersRes.data as Customer[]);
      if (jobsRes.data) setJobs(jobsRes.data as Job[]);
    } catch {
      // empty state below handles this
    } finally {
      setLoading(false);
    }
  }, [user, canAccess]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const intel = useMemo((): CustomerIntel[] => {
    const now = new Date();

    // Index customers by id and by phone so job rows (which only carry a
    // customer_id on some rows and a raw phone/name on others, depending on
    // how the job was created) can be enriched with lifecycle_stage.
    const customersById = new Map<string, Customer>();
    const customersByPhone = new Map<string, Customer>();
    for (const c of customers) {
      customersById.set(c.id, c);
      if (c.phone) customersByPhone.set(c.phone.trim(), c);
    }

    type Agg = { key: string; customerId: string | null; name: string; phone: string | null; ltv: number; pendingRevenue: number; dates: string[] };
    const byCustomer = new Map<string, Agg>();

    for (const job of jobs) {
      const key = job.customer_id || job.customer_phone?.trim() || job.customer_name.trim();
      if (!key) continue;
      const paid = job.invoice_status === 'paid' ? job.invoice_amount ?? 0 : 0;
      const pending = job.invoice_status === 'sent' ? job.invoice_amount ?? 0 : 0;

      const existing = byCustomer.get(key);
      if (!existing) {
        byCustomer.set(key, {
          key,
          customerId: job.customer_id,
          name: job.customer_name,
          phone: job.customer_phone,
          ltv: paid,
          pendingRevenue: pending,
          dates: [job.created_at],
        });
      } else {
        existing.ltv += paid;
        existing.pendingRevenue += pending;
        existing.dates.push(job.created_at);
        if (!existing.customerId && job.customer_id) existing.customerId = job.customer_id;
        if (!existing.phone && job.customer_phone) existing.phone = job.customer_phone;
      }
    }

    const results: CustomerIntel[] = [];
    for (const agg of byCustomer.values()) {
      const sortedDates = [...agg.dates].sort();
      const firstJobAt = sortedDates[0];
      const lastJobAt = sortedDates[sortedDates.length - 1];
      const jobCount = sortedDates.length;

      let avgCycleDays: number | null = null;
      if (jobCount >= 2) {
        let totalGap = 0;
        for (let i = 1; i < sortedDates.length; i++) {
          totalGap += daysBetween(new Date(sortedDates[i]), new Date(sortedDates[i - 1]));
        }
        avgCycleDays = Math.round(totalGap / (sortedDates.length - 1));
      }

      const daysSinceLastJob = daysBetween(now, new Date(lastJobAt));
      const predictedNextServiceAt = avgCycleDays !== null
        ? new Date(new Date(lastJobAt).getTime() + avgCycleDays * 86400000).toISOString()
        : null;

      const matchedCustomer = (agg.customerId && customersById.get(agg.customerId))
        || (agg.phone && customersByPhone.get(agg.phone.trim()))
        || null;

      const risk = computeRisk(jobCount, avgCycleDays, daysSinceLastJob, matchedCustomer?.lifecycle_stage ?? null);

      results.push({
        key: agg.key,
        customerId: agg.customerId,
        name: agg.name,
        phone: agg.phone,
        lifecycleStage: matchedCustomer?.lifecycle_stage ?? null,
        ltv: agg.ltv,
        pendingRevenue: agg.pendingRevenue,
        jobCount,
        firstJobAt,
        lastJobAt,
        avgCycleDays,
        daysSinceLastJob,
        predictedNextServiceAt,
        risk,
      });
    }

    return results;
  }, [jobs, customers]);

  const filtered = useMemo(() => {
    if (!search.trim()) return intel;
    const q = search.trim().toLowerCase();
    return intel.filter((c) => c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q));
  }, [intel, search]);

  const summary = useMemo(() => {
    const totalCustomers = intel.length;
    const totalLtv = intel.reduce((s, c) => s + c.ltv, 0);
    const avgLtv = totalCustomers > 0 ? totalLtv / totalCustomers : 0;
    const atRisk = intel.filter((c) => c.risk === 'watch' || c.risk === 'at_risk');
    const churned = intel.filter((c) => c.risk === 'churned');
    const revenueAtRisk = [...atRisk, ...churned].reduce((s, c) => s + c.ltv, 0);
    return {
      totalCustomers,
      totalLtv,
      avgLtv,
      atRiskCount: atRisk.length,
      churnedCount: churned.length,
      revenueAtRisk,
    };
  }, [intel]);

  const topByLtv = useMemo(
    () => [...filtered].filter((c) => c.ltv > 0).sort((a, b) => b.ltv - a.ltv).slice(0, 10),
    [filtered],
  );

  const watchlist = useMemo(
    () => [...filtered]
      .filter((c) => c.risk === 'at_risk' || c.risk === 'watch' || c.risk === 'churned')
      .sort((a, b) => RISK_META[a.risk].rank - RISK_META[b.risk].rank || b.ltv - a.ltv),
    [filtered],
  );

  const handleExport = () => {
    exportToCsv(
      intel,
      [
        { header: 'Name', accessor: (c) => c.name },
        { header: 'Phone', accessor: (c) => c.phone },
        { header: 'Lifecycle Stage', accessor: (c) => c.lifecycleStage ?? '' },
        { header: 'Churn Risk', accessor: (c) => RISK_META[c.risk].label },
        { header: 'LTV (Paid)', accessor: (c) => c.ltv },
        { header: 'Pending Revenue', accessor: (c) => c.pendingRevenue },
        { header: 'Job Count', accessor: (c) => c.jobCount },
        { header: 'Avg. Service Cycle (days)', accessor: (c) => c.avgCycleDays ?? '' },
        { header: 'Days Since Last Job', accessor: (c) => c.daysSinceLastJob },
        { header: 'Last Job', accessor: (c) => formatDate(c.lastJobAt) },
        { header: 'Predicted Next Service', accessor: (c) => formatDate(c.predictedNextServiceAt) },
      ],
      'customer-intelligence-ltv-churn.csv',
    );
    toast('Customer intelligence exported as CSV.', 'success');
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Customer Intelligence">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Customer Intelligence access is restricted. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Customer Intelligence">
      {/* Header */}
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
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Brain size={16} />
              </span>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
                Customer Intelligence
              </h1>
            </div>
            <p className="mt-1 text-sm text-text-secondary">Lifetime value and churn risk, built from your real job history</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={loading || intel.length === 0}
          className="focus-ring flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50"
        >
          <Download size={16} />
          Export CSV
        </button>
      </div>

      {loading ? (
        <>
          <SkeletonStatGrid count={4} />
          <div className="mt-6">
            <SkeletonTable rows={6} columns={5} />
          </div>
        </>
      ) : intel.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Not enough job history yet"
          description="Once you have jobs with paid invoices on file, LTV and churn risk will show up here automatically."
        />
      ) : (
        <FadeIn>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-text-secondary">
                <Users size={14} />
                <span className="text-xs font-medium">Customers</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{summary.totalCustomers}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-text-secondary">
                <DollarSign size={14} />
                <span className="text-xs font-medium">Total LTV</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{formatCurrency(summary.totalLtv)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-text-secondary">
                <Heart size={14} />
                <span className="text-xs font-medium">Avg. LTV</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{formatCurrency(summary.avgLtv)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-warning-500">
                <AlertTriangle size={14} />
                <span className="text-xs font-medium">At Risk</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{summary.atRiskCount + summary.churnedCount}</p>
            </div>
            <div className="col-span-2 rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark sm:col-span-1">
              <div className="flex items-center gap-2 text-danger">
                <ShieldAlert size={14} />
                <span className="text-xs font-medium">Revenue at Risk</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{formatCurrency(summary.revenueAtRisk)}</p>
            </div>
          </div>

          {/* Search */}
          <div className="relative mt-6 max-w-sm">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or phone…"
              className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary"
            />
          </div>

          {/* Churn watchlist */}
          <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger">
                <ShieldAlert size={18} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Churn Watchlist</h3>
                <p className="text-xs text-text-secondary">Customers overdue relative to their own service cadence, ranked by value</p>
              </div>
            </div>

            {watchlist.length === 0 ? (
              <p className="mt-6 text-sm text-text-secondary">No customers are currently at risk — nice work.</p>
            ) : (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-text-secondary">
                      <th className="pb-2 font-medium">Customer</th>
                      <th className="pb-2 font-medium">Risk</th>
                      <th className="pb-2 font-medium">LTV</th>
                      <th className="pb-2 font-medium">Last Job</th>
                      <th className="pb-2 font-medium">Days Overdue</th>
                      <th className="pb-2 font-medium">Predicted Next Visit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {watchlist.map((c) => {
                      const meta = RISK_META[c.risk];
                      const overdueDays = c.avgCycleDays !== null ? c.daysSinceLastJob - c.avgCycleDays : null;
                      return (
                        <tr key={c.key} className="border-t border-border/60">
                          <td className="py-2">
                            <p className="font-medium text-text-primary">{c.name}</p>
                            <p className="text-text-secondary">{c.phone ?? 'No phone on file'}</p>
                          </td>
                          <td className="py-2">
                            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium ${meta.bg} ${meta.text}`}>
                              <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                              {meta.label}
                            </span>
                          </td>
                          <td className="py-2 font-semibold text-text-primary">{formatCurrency(c.ltv)}</td>
                          <td className="py-2 text-text-secondary">{formatDate(c.lastJobAt)}</td>
                          <td className="py-2 text-text-secondary">
                            {overdueDays !== null && overdueDays > 0 ? `${overdueDays}d` : '—'}
                          </td>
                          <td className="py-2 text-text-secondary">{formatDate(c.predictedNextServiceAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Top customers by LTV */}
          <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <DollarSign size={18} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Top Customers by Lifetime Value</h3>
                <p className="text-xs text-text-secondary">Based on paid invoices only</p>
              </div>
            </div>

            {topByLtv.length === 0 ? (
              <p className="mt-6 text-sm text-text-secondary">No paid jobs yet.</p>
            ) : (
              <div className="mt-5 space-y-1.5">
                {topByLtv.map((c) => {
                  const meta = RISK_META[c.risk];
                  return (
                    <div key={c.key} className="flex items-center justify-between rounded-xl border border-border/60 px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                        <span className="font-medium text-text-primary">{c.name}</span>
                        <span className="text-text-secondary">· {c.jobCount} job{c.jobCount === 1 ? '' : 's'}</span>
                      </div>
                      <span className="font-semibold text-text-primary">{formatCurrency(c.ltv)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Methodology disclaimer */}
          <div className="mt-6 flex items-start gap-2 rounded-xl border border-dashed border-border p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
            <p className="text-xs leading-relaxed text-text-secondary">
              LTV counts only invoices marked &ldquo;paid.&rdquo; Churn risk is a transparent heuristic — not a trained
              model — that compares each customer's normal time-between-jobs against how long it's actually been
              since their last one, so a customer who typically calls every 6 weeks is flagged sooner than one who
              typically calls once a year. Customers marked &ldquo;Inactive&rdquo; on the Customers page are always
              shown as Churned regardless of timing. Predicted next visit dates are directional, not guarantees.
            </p>
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
