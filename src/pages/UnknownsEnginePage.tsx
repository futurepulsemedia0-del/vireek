/**
 * Unknowns Engine — /dashboard/unknowns
 *
 * Portfolio view of every active job (scheduled / en route / in progress):
 * which decisions across the business still rest on unknown, contradictory or
 * unverified evidence, and which jobs to fix first. Scoring is the same pure
 * engine as the per-job panel (src/lib/unknownsEngine.ts).
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Brain, Loader2, RefreshCw } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { STATUS_META, VERDICT_META, type GateVerdict } from '@/lib/unknownsEngine';
import {
  PORTFOLIO_JOB_LIMIT,
  fetchUnknownsPortfolio,
  type PortfolioResult,
} from '@/lib/unknownsPortfolio';

type Filter = 'all' | GateVerdict;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'resolve_first', label: 'Resolve first' },
  { key: 'proceed_with_caution', label: 'Caution' },
  { key: 'clear', label: 'Ready' },
];

function readinessTone(pct: number | null): string {
  if (pct === null) return 'text-text-secondary';
  if (pct >= 80) return 'text-success-500';
  if (pct >= 60) return 'text-warning-500';
  return 'text-danger';
}

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tone ?? 'text-text-primary'}`}>{value}</p>
    </div>
  );
}

export function UnknownsEnginePage() {
  const [data, setData] = useState<PortfolioResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchUnknownsPortfolio());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load active jobs.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const jobs = data?.jobs.filter((j) => filter === 'all' || j.report.verdict === filter) ?? [];
  const maxOpen = Math.max(1, ...(data?.dimensions.map((d) => d.openCount) ?? [1]));

  return (
    <DashboardLayout activeLabel="Unknowns Engine">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Brain size={18} /> Unknowns Engine
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Vireek does not just answer — it tracks what it does not know. Every active job, ranked by how much of
              its decision still rests on unknown, contradictory or unverified evidence.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-secondary disabled:opacity-60"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {loading && !data && (
          <div className="flex items-center gap-2 py-16 text-sm text-text-secondary" aria-live="polite">
            <Loader2 size={16} className="animate-spin" /> Mapping unknowns across active jobs…
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
            {error}
          </div>
        )}

        {data && data.total === 0 && !error && (
          <div className="rounded-xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
            No active jobs right now. Scheduled, en-route and in-progress jobs appear here.
          </div>
        )}

        {data && data.total > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Resolve first" value={data.byVerdict.resolve_first} tone={data.byVerdict.resolve_first ? 'text-danger' : undefined} />
              <StatCard label="Proceed with caution" value={data.byVerdict.proceed_with_caution} tone={data.byVerdict.proceed_with_caution ? 'text-warning-500' : undefined} />
              <StatCard label="Ready to decide" value={data.byVerdict.clear} tone="text-success-500" />
              <StatCard label="Average readiness" value={data.avgReadinessPct === null ? '—' : `${data.avgReadinessPct}%`} tone={readinessTone(data.avgReadinessPct)} />
            </div>

            <section className="mt-5 rounded-xl border border-border bg-bg-secondary p-4" aria-label="Where the unknowns are">
              <h2 className="text-sm font-semibold text-text-primary">Where the unknowns concentrate</h2>
              <p className="mt-0.5 text-xs text-text-secondary">Jobs where each decision area is still open (not verified, not Known or Likely).</p>
              <ul className="mt-3 space-y-2.5">
                {data.dimensions.map((d) => (
                  <li key={d.key}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-text-primary">{d.label}</span>
                      <span className="tabular-nums text-text-secondary">
                        {d.openCount} of {d.applicable} jobs
                        {d.contradictoryCount > 0 && <span className="text-danger"> · {d.contradictoryCount} contradictory</span>}
                      </span>
                    </div>
                    <div
                      role="meter"
                      aria-label={`${d.label}: ${d.openCount} open`}
                      aria-valuemin={0}
                      aria-valuemax={maxOpen}
                      aria-valuenow={d.openCount}
                      className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary"
                    >
                      <div className={`h-full rounded-full ${d.contradictoryCount ? 'bg-danger' : 'bg-warning-500'}`} style={{ width: `${(d.openCount / maxOpen) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <div className="mt-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter jobs">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${
                    filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {f.label}
                  {f.key !== 'all' && <span className="ml-1 tabular-nums">{data.byVerdict[f.key]}</span>}
                </button>
              ))}
            </div>

            <ul className="mt-3 space-y-2">
              {jobs.map((j) => {
                const v = VERDICT_META[j.report.verdict];
                return (
                  <li key={j.id} className={`rounded-xl border p-4 ${v.className}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text-primary">{j.customer_name}</p>
                        <p className="mt-0.5 text-xs text-text-secondary">
                          {[j.service_type, j.job_status.replace(/_/g, ' '), j.scheduled_datetime ? new Date(j.scheduled_datetime).toLocaleString() : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className={`text-lg font-bold tabular-nums ${readinessTone(j.report.readinessPct)}`}>
                          {j.report.readinessPct === null ? '—' : `${j.report.readinessPct}%`}
                        </p>
                        <p className="text-[11px] text-text-secondary">{v.label}</p>
                      </div>
                    </div>
                    {j.report.resolveFirst.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {j.report.resolveFirst.map((d) => (
                          <li key={d.key} className="flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_META[d.status].className}`}>
                              {STATUS_META[d.status].label}
                            </span>
                            <span className="font-medium text-text-primary">{d.label}</span>
                            <span>— {d.resolveWith}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Link
                      to="/dashboard/jobs"
                      className="focus-ring mt-2 inline-block rounded-md text-xs font-medium text-accent hover:underline"
                    >
                      Open Jobs board →
                    </Link>
                  </li>
                );
              })}
              {jobs.length === 0 && <li className="py-8 text-center text-sm text-text-secondary">No jobs in this group.</li>}
            </ul>

            {data.truncated && (
              <p className="mt-3 text-xs text-text-secondary">
                Showing the first {PORTFOLIO_JOB_LIMIT} active jobs by schedule; later jobs are not scored here.
              </p>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
