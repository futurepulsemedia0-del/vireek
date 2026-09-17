/**
 * Cross-Tenant Anonymous Benchmarking — /dashboard/benchmarks
 *
 * Shows this account's own numbers next to an anonymized peer
 * distribution. Every number that isn't "my_value" comes from
 * `get_benchmark_comparison()` (see src/lib/benchmarking.ts) — a single
 * RPC over pre-aggregated, k-anonymous cohort statistics. This page has
 * no cross-tenant query of its own and never will; see the migration's
 * header comment for why that matters.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, BarChart3, Info, ShieldCheck, TrendingUp, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  BUCKET_COLORS,
  BUCKET_LABELS,
  describeGap,
  fetchBenchmarkComparison,
  formatMetricValue,
  METRIC_DESCRIPTIONS,
  METRIC_LABELS,
  scopeLabel,
  summarizeStanding,
} from '@/lib/benchmarking';
import type { BenchmarkRow } from '@/lib/benchmarking';

const PERIOD_OPTIONS = [
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

// ============================================================
// DISTRIBUTION BAR
// ============================================================

function DistributionBar({ row }: { row: BenchmarkRow }) {
  if (row.p10 === null || row.p90 === null) return null;

  const lo = Math.min(row.p10, row.my_value);
  const hi = Math.max(row.p90, row.my_value);
  const span = hi - lo || 1;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - lo) / span) * 100));

  return (
    <div className="relative mt-4 h-2 rounded-full bg-bg-tertiary">
      {/* p25–p75 band */}
      {row.p25 !== null && row.p75 !== null && (
        <div
          className="absolute top-0 h-2 rounded-full bg-accent/20"
          style={{ left: `${pct(row.p25)}%`, width: `${Math.max(2, pct(row.p75) - pct(row.p25))}%` }}
        />
      )}
      {/* median tick */}
      {row.p50 !== null && (
        <div className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-text-secondary/40" style={{ left: `${pct(row.p50)}%` }} />
      )}
      {/* you */}
      <div
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent shadow"
        style={{ left: `${pct(row.my_value)}%` }}
        title="You"
      />
    </div>
  );
}

// ============================================================
// ROW CARD
// ============================================================

function MetricCard({ row }: { row: BenchmarkRow }) {
  const gap = describeGap(row);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-border bg-bg-secondary p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">{METRIC_LABELS[row.metric]}</p>
          <p className="mt-0.5 text-xs text-text-secondary">{METRIC_DESCRIPTIONS[row.metric]}</p>
        </div>
        {row.percentile_bucket && (
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${BUCKET_COLORS[row.percentile_bucket]}`}>
            {BUCKET_LABELS[row.percentile_bucket]}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-end gap-4">
        <div>
          <p className="text-2xl font-bold text-text-primary">{formatMetricValue(row.my_value, row.unit)}</p>
          <p className="text-[11px] text-text-secondary">You</p>
        </div>
        {row.cohort_avg !== null ? (
          <div>
            <p className="text-lg font-semibold text-text-secondary">{formatMetricValue(row.cohort_avg, row.unit)}</p>
            <p className="text-[11px] text-text-secondary">Peer average</p>
          </div>
        ) : (
          <div>
            <p className="text-sm text-text-secondary/70">Not enough peer data yet</p>
          </div>
        )}
      </div>

      {row.cohort_avg !== null && <DistributionBar row={row} />}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <p className="text-xs text-text-secondary">{scopeLabel(row)}</p>
        {gap && <p className="text-xs font-medium text-text-primary">{gap}</p>}
      </div>
    </motion.div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function BenchmarksPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [rows, setRows] = useState<BenchmarkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodDays, setPeriodDays] = useState(30);
  const [showMethodology, setShowMethodology] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const result = await fetchBenchmarkComparison(user.id, periodDays);
      setRows(result.rows);
    } catch {
      toast('Could not load benchmarks', 'error');
    }
    setLoading(false);
  }, [user, periodDays, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const standing = useMemo(() => summarizeStanding(rows), [rows]);
  const comparable = rows.filter((r) => r.scope !== 'none');
  const uncomparable = rows.filter((r) => r.scope === 'none');
  const industryScope = rows.find((r) => r.scope === 'industry');

  return (
    <DashboardLayout activeLabel="Benchmarks">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <BarChart3 size={22} className="text-accent" /> Benchmarks
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              How your numbers compare to other businesses on Vireek — anonymized, and only shown once enough
              businesses share a category that no single one can be picked out.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={periodDays}
              onChange={(e) => setPeriodDays(Number(e.target.value))}
              className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary"
            >
              {PERIOD_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowMethodology(true)}
              aria-label="How this works"
              className="focus-ring flex h-9 w-9 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-accent"
            >
              <Info size={15} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center">
            <Users className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              Not enough of your own activity yet to benchmark. Once you have calls, leads, quotes, or jobs in
              this period, your numbers will show up here.
            </p>
          </div>
        ) : (
          <>
            {standing.total > 0 && (
              <div className="mb-4 flex items-center gap-3 rounded-2xl border border-accent/25 bg-accent/5 px-4 py-3">
                <TrendingUp size={18} className="shrink-0 text-accent" />
                <p className="text-sm text-text-primary">
                  You're at or above average on <span className="font-semibold">{standing.strong}</span> of{' '}
                  <span className="font-semibold">{standing.total}</span> comparable metrics.
                </p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {comparable.map((row) => (
                <MetricCard key={row.metric} row={row} />
              ))}
            </div>

            {uncomparable.length > 0 && (
              <div className="mt-4 rounded-2xl border border-dashed border-border p-4">
                <p className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                  <AlertCircle size={13} /> Not enough platform data yet to compare
                </p>
                <p className="mt-1 text-xs text-text-secondary">
                  {uncomparable.map((r) => METRIC_LABELS[r.metric]).join(', ')} — you have activity here, but not
                  enough other businesses have shared this metric yet for an anonymous comparison. Check back as
                  Vireek grows.
                </p>
              </div>
            )}

            {!industryScope && comparable.some((r) => r.scope === 'all') && (
              <p className="mt-4 text-xs text-text-secondary/80">
                Showing the all-industry benchmark for now — once enough businesses in your specific trade join,
                comparisons will narrow to just your industry.
              </p>
            )}
          </>
        )}

        <div className="mt-6 flex items-start gap-2 text-xs text-text-secondary/70">
          <ShieldCheck size={13} className="mt-0.5 shrink-0" />
          <p>
            Every comparison here is built from at least five other businesses' numbers averaged together — no
            individual business's data is ever visible to another account, in any form.
          </p>
        </div>
      </div>

      {showMethodology && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
          onClick={() => setShowMethodology(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-5 shadow-2xl"
          >
            <h4 className="text-sm font-semibold text-text-primary">How benchmarking works</h4>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-xs leading-relaxed text-text-secondary">
              <li>Your own numbers are calculated live from your account, right now.</li>
              <li>
                Peer numbers are recomputed every night from every business on Vireek, but only ever published as
                a group average and percentile spread — never as any single business's figures.
              </li>
              <li>
                A comparison only appears once at least 5 businesses in the group have contributed a value for
                that metric in the period. Below that, nothing is shown for it at all.
              </li>
              <li>
                When your own trade doesn't have enough businesses yet, you're compared against all trades
                instead, and this page tells you which one you're seeing.
              </li>
            </ol>
            <button
              type="button"
              onClick={() => setShowMethodology(false)}
              className="focus-ring mt-4 w-full rounded-xl border border-border py-2 text-sm text-text-secondary hover:text-text-primary"
            >
              Close
            </button>
          </motion.div>
        </div>
      )}
    </DashboardLayout>
  );
}
