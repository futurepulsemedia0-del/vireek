import { useEffect, useMemo, useState, useCallback } from 'react';
import { Stethoscope, RefreshCw, Loader2, TrendingUp, DollarSign, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import {
  fetchJobAutopsyCases,
  runJobAutopsy,
  setReportReviewed,
  computeJobAutopsyPatterns,
  overallAutopsyStats,
  formatCents,
  ROOT_CAUSE_LABELS,
  ROOT_CAUSE_COLORS,
  type JobAutopsyCase,
} from '@/lib/jobAutopsy';

function RootCauseBar({ report }: { report: NonNullable<JobAutopsyCase['report']> }) {
  return (
    <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
      {report.root_causes.map((rc, i) => (
        <div key={i} style={{ width: `${rc.pct}%`, backgroundColor: ROOT_CAUSE_COLORS[rc.category] }} title={`${ROOT_CAUSE_LABELS[rc.category]} — ${rc.pct}%`} />
      ))}
    </div>
  );
}

export function JobAutopsyPage() {
  const { toast } = useToast();
  const [cases, setCases] = useState<JobAutopsyCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCases(await fetchJobAutopsyCases());
    } catch {
      toast('Could not load job autopsy data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const patterns = useMemo(() => computeJobAutopsyPatterns(cases), [cases]);
  const stats = useMemo(() => overallAutopsyStats(cases), [cases]);
  const pending = cases.filter((c) => !c.report);
  const analyzed = cases.filter((c) => c.report).sort((a, b) => (b.report!.variance_cents) - (a.report!.variance_cents));

  const handleRun = async (jobId: string) => {
    setRunningId(jobId);
    try {
      await runJobAutopsy(jobId);
      toast('Autopsy complete.', 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Autopsy failed.', 'error');
    } finally {
      setRunningId(null);
    }
  };

  const handleReview = async (reportId: string) => {
    try {
      await setReportReviewed(reportId, true);
      setCases((prev) => prev.map((c) => (c.report?.id === reportId ? { ...c, report: { ...c.report, reviewed: true } } : c)));
    } catch {
      toast('Could not update report.', 'error');
    }
  };

  if (loading) {
    return (
      <DashboardLayout activeLabel="AI Job Autopsy">
        <p className="text-sm text-text-secondary">Loading...</p>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="AI Job Autopsy">
      <div className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <Stethoscope size={22} /> AI Job Autopsy
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          For every completed job that cost more than the Price Book expected, AI explains WHY — down to a percentage
          breakdown of root causes — and what to do differently next time.
        </p>
      </div>

      {cases.length === 0 ? (
        <EmptyState
          icon={Stethoscope}
          title="No autopsy candidates yet"
          description="Once a completed, invoiced job matches a Price Book entry, it will appear here for analysis."
        />
      ) : (
        <div className="space-y-8">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="p-4">
              <p className="flex items-center gap-1.5 text-xs text-text-secondary"><CheckCircle2 size={13} /> Jobs analyzed</p>
              <p className="mt-1 text-xl font-bold text-text-primary">{stats.analyzedCount}</p>
            </Card>
            <Card className="p-4">
              <p className="flex items-center gap-1.5 text-xs text-text-secondary"><TrendingUp size={13} /> Total overrun found</p>
              <p className="mt-1 text-xl font-bold text-danger">{formatCents(stats.totalOverrunCents)}</p>
            </Card>
            <Card className="p-4">
              <p className="flex items-center gap-1.5 text-xs text-text-secondary"><DollarSign size={13} /> Estimated recoverable</p>
              <p className="mt-1 text-xl font-bold text-success-500">{formatCents(stats.totalRecoverableCents)}</p>
            </Card>
          </div>

          {patterns.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Recurring patterns across every job</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {patterns.map((p) => (
                  <Card key={p.category} className="p-4">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                      <p className="text-sm font-medium text-text-primary">{p.label}</p>
                    </div>
                    <p className="mt-1.5 text-xs text-text-secondary">
                      {p.jobCount} jobs · avg {p.avgSharePct}% share · {formatCents(p.totalVarianceCents)} attributed
                    </p>
                    {p.topPreventionAction && (
                      <p className="mt-2 text-xs text-text-primary">
                        <span className="font-medium">Most common fix: </span>
                        {p.topPreventionAction}
                      </p>
                    )}
                  </Card>
                ))}
              </div>
            </section>
          )}

          {pending.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Awaiting autopsy ({pending.length})</h2>
              <div className="space-y-2">
                {pending.map((c) => (
                  <Card key={c.job_id} className="flex items-center justify-between gap-4 p-4">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{c.customer_name}</p>
                      <p className="text-xs text-text-secondary">
                        {c.service_type ?? 'Unknown type'} · {c.technician_name ?? 'Unassigned'} ·{' '}
                        {c.variance_cents > 0 ? `${formatCents(c.variance_cents)} over expected` : `${formatCents(Math.abs(c.variance_cents))} under`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRun(c.job_id)}
                      disabled={runningId === c.job_id}
                      className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {runningId === c.job_id ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                      Run autopsy
                    </button>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {analyzed.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Analyzed jobs ({analyzed.length})</h2>
              <div className="space-y-3">
                {analyzed.map((c) => {
                  const r = c.report!;
                  return (
                    <Card key={c.job_id} className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-text-primary">{c.customer_name}</p>
                          <p className="text-xs text-text-secondary">{c.service_type ?? 'Unknown type'} · {c.technician_name ?? 'Unassigned'}</p>
                        </div>
                        <span className={`shrink-0 text-sm font-semibold ${r.variance_cents > 0 ? 'text-danger' : 'text-success-500'}`}>
                          {r.variance_cents > 0 ? '+' : ''}{formatCents(r.variance_cents)}
                        </span>
                      </div>

                      <RootCauseBar report={r} />
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-secondary">
                        {r.root_causes.map((rc, i) => (
                          <span key={i} className="flex items-center gap-1">
                            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ROOT_CAUSE_COLORS[rc.category] }} />
                            {ROOT_CAUSE_LABELS[rc.category]} {rc.pct}%
                          </span>
                        ))}
                      </div>

                      {r.ai_summary && <p className="mt-3 text-sm text-text-primary">{r.ai_summary}</p>}
                      {r.counterfactual_summary && (
                        <p className="mt-2 text-xs text-text-secondary">
                          <span className="font-medium text-text-primary">If handled differently: </span>
                          {r.counterfactual_summary}
                        </p>
                      )}
                      {r.recommended_prevention_action && (
                        <p className="mt-2 text-xs text-text-primary">
                          <span className="font-medium">Prevent next time: </span>
                          {r.recommended_prevention_action}
                        </p>
                      )}

                      <div className="mt-3 flex items-center justify-between">
                        <span className="text-[11px] text-text-secondary">Confidence: {r.confidence}</span>
                        {!r.reviewed ? (
                          <button
                            type="button"
                            onClick={() => handleReview(r.id)}
                            className="focus-ring rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                          >
                            Mark reviewed
                          </button>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-success-500"><CheckCircle2 size={13} /> Reviewed</span>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
