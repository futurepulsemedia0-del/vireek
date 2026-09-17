import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingDown, Search, Info } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';
import {
  UnderpricedJobRow,
  TechnicianUnderpricingSummary,
  formatCents,
  formatPct,
  severityColor,
  technicianLabel,
  summarizeUnderpricing,
  MATCH_TYPE_LABELS,
} from '@/lib/underpricing';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

export function UnderpricedJobsPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [rows, setRows] = useState<UnderpricedJobRow[]>([]);
  const [techSummary, setTechSummary] = useState<TechnicianUnderpricingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [techFilter, setTechFilter] = useState<string>('all');
  const [threshold, setThreshold] = useState(0);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [rowsRes, techRes] = await Promise.all([
      supabase.from('underpriced_jobs').select('*').order('scheduled_datetime', { ascending: false }),
      supabase.from('technician_underpricing_summary').select('*'),
    ]);
    if (rowsRes.error) toast('Could not load underpriced job data', 'error');
    else setRows((rowsRes.data as UnderpricedJobRow[]) || []);
    setTechSummary((techRes.data as TechnicianUnderpricingSummary[]) || []);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (user) fetchAll();
  }, [user, fetchAll]);

  const technicianOptions = useMemo(
    () =>
      [...techSummary]
        .filter((t) => t.underpriced_job_count > 0)
        .sort((a, b) => (technicianLabel(a) > technicianLabel(b) ? 1 : -1)),
    [techSummary],
  );

  const underpricedRows = useMemo(() => rows.filter((r) => r.underprice_cents > 0), [rows]);

  const filteredRows = useMemo(
    () =>
      underpricedRows.filter((r) => {
        if ((r.underprice_pct ?? 0) < threshold) return false;
        if (techFilter !== 'all' && (r.assigned_technician_id ?? 'unassigned') !== techFilter) return false;
        if (search && !r.customer_name.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      }),
    [underpricedRows, threshold, techFilter, search],
  );

  const sortedFilteredRows = useMemo(
    () => [...filteredRows].sort((a, b) => b.underprice_cents - a.underprice_cents),
    [filteredRows],
  );

  const leaderboard = useMemo(
    () => [...techSummary].filter((t) => t.underpriced_job_count > 0).sort((a, b) => b.total_underpriced_cents - a.total_underpriced_cents),
    [techSummary],
  );

  const techNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of techSummary) map.set(t.assigned_technician_id ?? 'unassigned', technicianLabel(t));
    return map;
  }, [techSummary]);
  
  const summary = summarizeUnderpricing(rows);

  return (
    <DashboardLayout activeLabel="Underpriced Jobs">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger">
            <TrendingDown size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Underpriced Jobs</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Jobs invoiced below what your Price Book says that service costs — where margin quietly leaks out.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : summary.matchedJobCount === 0 ? (
          <div className="flex items-start gap-3 rounded-2xl border border-dashed border-border p-6 text-sm text-text-secondary">
            <Info size={16} className="mt-0.5 shrink-0" />
            <p>
              No invoiced jobs could be matched to a Price Book entry yet. Link jobs to a Price Book item when creating
              them (Jobs → Create Job → Price Book Item), or make sure your Price Book's service names/keywords match
              how jobs are described.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{summary.matchedJobCount}</p>
                <p className="text-xs text-text-secondary">Jobs matched</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-danger">{summary.underpricedJobCount}</p>
                <p className="text-xs text-text-secondary">Underpriced</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-danger">{formatCents(summary.totalUnderpricedCents)}</p>
                <p className="text-xs text-text-secondary">Revenue given away</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{formatPct(summary.avgUnderpricePct)}</p>
                <p className="text-xs text-text-secondary">Avg underprice</p>
              </div>
            </div>

            {leaderboard.length > 0 && (
              <div className="mb-6 overflow-hidden rounded-2xl border border-border bg-bg-secondary">
                <div className="border-b border-border px-4 py-3">
                  <p className="text-sm font-semibold text-text-primary">By technician</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-text-secondary">
                        <th className="px-4 py-2 font-medium">Technician</th>
                        <th className="px-4 py-2 font-medium">Matched jobs</th>
                        <th className="px-4 py-2 font-medium">Underpriced</th>
                        <th className="px-4 py-2 font-medium">Avg underprice</th>
                        <th className="px-4 py-2 text-right font-medium">Revenue given away</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboard.map((t) => (
                        <tr
                          key={t.assigned_technician_id ?? 'unassigned'}
                          className="border-b border-border last:border-0 hover:bg-bg-tertiary/50"
                        >
                          <td className="px-4 py-2.5 font-medium text-text-primary">{technicianLabel(t)}</td>
                          <td className="px-4 py-2.5 text-text-secondary">{t.matched_job_count}</td>
                          <td className="px-4 py-2.5 text-text-secondary">
                            {t.underpriced_job_count}/{t.matched_job_count}
                          </td>
                          <td className="px-4 py-2.5 text-text-secondary">{formatPct(t.avg_underprice_pct)}</td>
                          <td className="px-4 py-2.5 text-right font-semibold text-danger">
                            {formatCents(t.total_underpriced_cents)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by customer"
                  className={`${inputClass} pl-9`}
                />
              </div>
              <select value={techFilter} onChange={(e) => setTechFilter(e.target.value)} className={`${inputClass} sm:w-48`}>
                <option value="all">All technicians</option>
                {technicianOptions.map((t) => (
                  <option key={t.assigned_technician_id ?? 'unassigned'} value={t.assigned_technician_id ?? 'unassigned'}>
                    {technicianLabel(t)}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-2 sm:w-56">
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={1}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  className="w-full accent-accent"
                />
                <span className="w-14 shrink-0 text-right text-xs text-text-secondary">{threshold}%+</span>
              </div>
            </div>

            {sortedFilteredRows.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-text-secondary">
                No underpriced jobs match these filters.
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-text-secondary">
                        <th className="px-4 py-2.5 font-medium">Customer / Service</th>
                        <th className="px-4 py-2.5 font-medium">Technician</th>
                        <th className="px-4 py-2.5 font-medium">Book price</th>
                        <th className="px-4 py-2.5 font-medium">Invoiced</th>
                        <th className="px-4 py-2.5 font-medium">Gap</th>
                        <th className="px-4 py-2.5 font-medium">Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedFilteredRows.map((row) => (
                        <tr key={row.job_id} className="border-b border-border last:border-0 hover:bg-bg-tertiary/50">
                          <td className="px-4 py-3">
                            <Link to={`/dashboard/profitability?job=${row.job_id}`} className="focus-ring block">
                              <p className="font-medium text-text-primary hover:text-accent">{row.customer_name}</p>
                              <p className="text-xs text-text-secondary">
                                {row.matched_service_name}
                                {row.match_type !== 'linked' && (
                                  <span className="ml-1 text-text-secondary/70">({MATCH_TYPE_LABELS[row.match_type]})</span>
                                )}
                              </p>
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-text-secondary">{techNameById.get(row.assigned_technician_id ?? 'unassigned') ?? 'Unassigned'}</td>
                          <td className="px-4 py-3 text-text-secondary">{formatCents(row.book_price_cents)}</td>
                          <td className="px-4 py-3 text-text-secondary">{formatCents(row.invoice_cents)}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${severityColor(row.underprice_pct)}`}>
                              -{formatCents(row.underprice_cents)} ({formatPct(row.underprice_pct)})
                            </span>
                          </td>
                          <td className="px-4 py-3 text-text-secondary">{row.margin_pct !== null ? formatPct(row.margin_pct) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
