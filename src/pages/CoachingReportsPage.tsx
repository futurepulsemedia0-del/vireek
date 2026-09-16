import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  GraduationCap,
  Lock,
  Download,
  Save,
  TrendingUp,
  TrendingDown,
  Minus,
  ShieldAlert,
  Gift,
  Lightbulb,
  Phone,
  History,
  ChevronDown,
  ChevronUp,
  Trash2,
  Info,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Call } from '@/lib/supabase';
import { exportToCsv } from '@/lib/csvExport';
import {
  computeCoachingMetrics,
  saveCoachingReport,
  fetchCoachingReports,
  deleteCoachingReport,
  type CoachingMetrics,
  type CoachingReport,
} from '@/lib/coachingReports';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable, FadeIn } from '@/components/Skeleton';

// ============================================================
// DATE RANGE HELPERS
// ============================================================

type RangePreset = '7d' | '30d' | '90d';

function getRange(preset: RangePreset) {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;

  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const prevEnd = new Date(start);
  prevEnd.setTime(start.getTime() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (days - 1));
  prevStart.setHours(0, 0, 0, 0);

  return { start, end, prevStart, prevEnd };
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-success';
  if (score >= 60) return 'text-warning-500';
  return 'text-danger';
}

function scoreBarColor(score: number): string {
  if (score >= 80) return 'bg-success-500';
  if (score >= 60) return 'bg-warning-500';
  return 'bg-danger';
}

// ============================================================
// SCORE TREND CHART (lightweight, self-contained — no chart lib)
// ============================================================

function ScoreTrendChart({ scoreByDay }: { scoreByDay: CoachingMetrics['scoreByDay'] }) {
  if (scoreByDay.length === 0) return null;
  const chartH = 120;

  return (
    <div className="flex items-end gap-1" style={{ height: chartH }}>
      {scoreByDay.map((d) => {
        const heightPct = d.avgScore !== null ? Math.max(d.avgScore, 4) : 0;
        return (
          <div key={d.date} className="group relative flex flex-1 flex-col items-center justify-end" style={{ height: '100%' }}>
            <div
              className={`w-full rounded-t transition-opacity group-hover:opacity-80 ${d.avgScore !== null ? scoreBarColor(d.avgScore) : 'bg-bg-tertiary'}`}
              style={{ height: `${heightPct}%` }}
            />
            <div className="pointer-events-none absolute bottom-full mb-1 hidden whitespace-nowrap rounded-lg bg-text-primary px-2 py-1 text-[10px] text-bg-primary group-hover:block">
              {new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: {d.avgScore ?? '—'} ({d.count} call{d.count === 1 ? '' : 's'})
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export function CoachingReportsPage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_view_billing;

  const [allCalls, setAllCalls] = useState<Call[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [saving, setSaving] = useState(false);

  const [reports, setReports] = useState<CoachingReport[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  const loadCalls = useCallback(async () => {
    if (!user || !canAccess) return;
    setDataLoading(true);
    try {
      const { data, error } = await supabase.from('calls').select('*').order('call_datetime', { ascending: false });
      if (error) throw error;
      setAllCalls((data as Call[]) ?? []);
    } catch {
      // empty state below
    } finally {
      setDataLoading(false);
    }
  }, [user, canAccess]);

  const loadHistory = useCallback(async () => {
    if (!user || !canAccess) return;
    setHistoryLoading(true);
    try {
      setReports(await fetchCoachingReports());
    } catch {
      // history section just stays empty
    } finally {
      setHistoryLoading(false);
    }
  }, [user, canAccess]);

  useEffect(() => {
    loadCalls();
    loadHistory();
  }, [loadCalls, loadHistory]);

  const range = useMemo(() => getRange(preset), [preset]);

  const callsInRange = useMemo(
    () => allCalls.filter((c) => {
      const d = new Date(c.call_datetime);
      return d >= range.start && d <= range.end;
    }),
    [allCalls, range],
  );

  const prevRangeCalls = useMemo(
    () => allCalls.filter((c) => {
      const d = new Date(c.call_datetime);
      return d >= range.prevStart && d <= range.prevEnd;
    }),
    [allCalls, range],
  );

  const metrics = useMemo(
    () => computeCoachingMetrics(callsInRange, prevRangeCalls),
    [callsInRange, prevRangeCalls],
  );

  const scoreDelta = metrics.avgCallScore !== null && metrics.prevAvgCallScore !== null
    ? Math.round((metrics.avgCallScore - metrics.prevAvgCallScore) * 10) / 10
    : null;

  const handleSaveReport = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await saveCoachingReport(metrics, range.start, range.end, user.id);
      toast('Coaching report saved.', 'success');
      loadHistory();
    } catch {
      toast('Could not save this report. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteReport = async (id: string) => {
    try {
      await deleteCoachingReport(id);
      setReports((prev) => prev.filter((r) => r.id !== id));
      toast('Report deleted.', 'success');
    } catch {
      toast('Could not delete this report.', 'error');
    }
  };

  const handleExport = () => {
    exportToCsv(
      callsInRange.filter((c) => c.call_score !== null),
      [
        { header: 'Date', accessor: (c) => formatDate(c.call_datetime) },
        { header: 'Caller', accessor: (c) => c.caller_name },
        { header: 'Phone', accessor: (c) => c.caller_phone },
        { header: 'Call Score', accessor: (c) => c.call_score },
        { header: 'Sentiment', accessor: (c) => c.sentiment },
        { header: 'Booking Outcome', accessor: (c) => c.booking_outcome },
        { header: 'Objections Raised', accessor: (c) => (c.objections_raised ?? []).join('; ') },
        { header: 'Objections Resolved', accessor: (c) => c.objections_resolved },
        { header: 'Missed Upsell Opportunities', accessor: (c) => (c.upsell_opportunities ?? []).join('; ') },
        { header: 'Coaching Tip', accessor: (c) => c.coaching_tip },
      ],
      'ai-coaching-report.csv',
    );
    toast('Coaching data exported as CSV.', 'success');
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Coaching Reports">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Coaching Reports access is restricted. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const loading = dataLoading;

  return (
    <DashboardLayout activeLabel="Coaching Reports">
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
                <GraduationCap size={16} />
              </span>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">AI Coaching Reports</h1>
            </div>
            <p className="mt-1 text-sm text-text-secondary">What's actually worth coaching on, rolled up from every scored call</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-border bg-bg-secondary p-1">
            {(['7d', '30d', '90d'] as RangePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPreset(p)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${preset === p ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {p === '7d' ? '7 days' : p === '30d' ? '30 days' : '90 days'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleExport}
            disabled={loading || metrics.callsAnalyzed === 0}
            className="focus-ring flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
            aria-label="Export CSV"
            title="Export CSV"
          >
            <Download size={15} />
          </button>
          <button
            type="button"
            onClick={handleSaveReport}
            disabled={loading || saving || metrics.callsAnalyzed === 0}
            className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            <Save size={15} />
            {saving ? 'Saving…' : 'Save report'}
          </button>
        </div>
      </div>

      {loading ? (
        <>
          <SkeletonStatGrid count={4} />
          <div className="mt-6"><SkeletonTable rows={5} columns={4} /></div>
        </>
      ) : metrics.callsAnalyzed === 0 ? (
        <EmptyState
          icon={GraduationCap}
          title="No scored calls in this period"
          description="Once calls in this range have been analyzed by Call Intelligence, coaching insights will show up here automatically."
        />
      ) : (
        <FadeIn>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-text-secondary">
                <Phone size={14} />
                <span className="text-xs font-medium">Calls Analyzed</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{metrics.callsAnalyzed}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-text-secondary">
                <GraduationCap size={14} />
                <span className="text-xs font-medium">Avg. Call Score</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <p className={`text-xl font-bold ${metrics.avgCallScore !== null ? scoreColor(metrics.avgCallScore) : 'text-text-primary'}`}>
                  {metrics.avgCallScore ?? '—'}
                </p>
                {scoreDelta !== null && (
                  <span className={`flex items-center gap-0.5 text-xs font-medium ${scoreDelta > 0 ? 'text-success' : scoreDelta < 0 ? 'text-danger' : 'text-text-secondary'}`}>
                    {scoreDelta > 0 ? <TrendingUp size={12} /> : scoreDelta < 0 ? <TrendingDown size={12} /> : <Minus size={12} />}
                    {Math.abs(scoreDelta)}
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-text-secondary">
                <TrendingUp size={14} />
                <span className="text-xs font-medium">Booking Rate</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{metrics.bookingRate !== null ? `${metrics.bookingRate}%` : '—'}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-text-secondary">
                <ShieldAlert size={14} />
                <span className="text-xs font-medium">Objections Resolved</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{metrics.objectionResolutionRate !== null ? `${metrics.objectionResolutionRate}%` : '—'}</p>
            </div>
          </div>

          {/* Score trend */}
          {metrics.scoreByDay.length > 1 && (
            <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
              <h3 className="text-sm font-semibold text-text-primary">Call Score Trend</h3>
              <p className="text-xs text-text-secondary">Daily average, 0–100</p>
              <div className="mt-4">
                <ScoreTrendChart scoreByDay={metrics.scoreByDay} />
              </div>
            </div>
          )}

          {/* Objections + upsells */}
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger">
                  <ShieldAlert size={18} />
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Most Common Objections</h3>
                  <p className="text-xs text-text-secondary">How often each one was actually resolved on the call</p>
                </div>
              </div>
              {metrics.topObjections.length === 0 ? (
                <p className="mt-5 text-sm text-text-secondary">No objections detected in this period.</p>
              ) : (
                <div className="mt-5 space-y-2">
                  {metrics.topObjections.map((o) => (
                    <div key={o.text} className="rounded-xl border border-border/60 px-3 py-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-text-primary">{o.text}</span>
                        <span className="text-text-secondary">{o.count}x</span>
                      </div>
                      <div className="mt-1 text-text-secondary">{o.resolvedCount}/{o.count} resolved</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning-500/10 text-warning-500">
                  <Gift size={18} />
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Most Missed Upsell Opportunities</h3>
                  <p className="text-xs text-text-secondary">Detected as a good fit, but not offered on the call</p>
                </div>
              </div>
              {metrics.topMissedUpsells.length === 0 ? (
                <p className="mt-5 text-sm text-text-secondary">No missed upsell opportunities detected.</p>
              ) : (
                <div className="mt-5 space-y-1.5">
                  {metrics.topMissedUpsells.map((u) => (
                    <div key={u.text} className="flex items-center justify-between rounded-xl border border-border/60 px-3 py-2 text-xs">
                      <span className="font-medium text-text-primary">{u.text}</span>
                      <span className="text-text-secondary">{u.count}x</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Recurring coaching themes */}
          <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Lightbulb size={18} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Recurring Coaching Themes</h3>
                <p className="text-xs text-text-secondary">The tips Call Intelligence gave more than once this period — start here</p>
              </div>
            </div>
            {metrics.recurringThemes.length === 0 ? (
              <p className="mt-5 text-sm text-text-secondary">No coaching tips recorded in this period.</p>
            ) : (
              <div className="mt-5 space-y-1.5">
                {metrics.recurringThemes.map((t) => (
                  <div key={t.text} className="flex items-start justify-between gap-3 rounded-xl border border-border/60 px-3 py-2 text-xs">
                    <span className="text-text-primary">{t.text}</span>
                    <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 font-medium text-text-secondary">{t.count}x</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Lowest scoring calls */}
          {metrics.lowestScoringCalls.length > 0 && (
            <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
              <h3 className="text-sm font-semibold text-text-primary">Lowest-Scoring Calls</h3>
              <p className="text-xs text-text-secondary">Concrete calls to review in a coaching session</p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-text-secondary">
                      <th className="pb-2 font-medium">Caller</th>
                      <th className="pb-2 font-medium">Date</th>
                      <th className="pb-2 font-medium">Score</th>
                      <th className="pb-2 font-medium">Coaching Tip</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.lowestScoringCalls.map((c) => (
                      <tr key={c.id} className="border-t border-border/60">
                        <td className="py-2">
                          <p className="font-medium text-text-primary">{c.callerName ?? 'Unknown'}</p>
                          <p className="text-text-secondary">{c.callerPhone ?? ''}</p>
                        </td>
                        <td className="py-2 text-text-secondary">{formatDate(c.callDatetime)}</td>
                        <td className={`py-2 font-semibold ${scoreColor(c.score)}`}>{c.score}</td>
                        <td className="py-2 max-w-xs text-text-secondary">{c.coachingTip ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                onClick={() => navigate('/dashboard/calls')}
                className="focus-ring mt-4 text-xs font-medium text-accent hover:underline"
              >
                View all calls →
              </button>
            </div>
          )}

          {/* Saved report history */}
          <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
            <button
              type="button"
              onClick={() => setShowHistory(!showHistory)}
              className="focus-ring flex w-full items-center justify-between gap-2 text-left"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <History size={15} /> Saved Reports {reports.length > 0 && `(${reports.length})`}
              </span>
              {showHistory ? <ChevronUp size={16} className="text-text-secondary" /> : <ChevronDown size={16} className="text-text-secondary" />}
            </button>
            {showHistory && (
              <div className="mt-3 space-y-1.5">
                {historyLoading ? (
                  <p className="text-xs text-text-secondary">Loading…</p>
                ) : reports.length === 0 ? (
                  <p className="text-xs text-text-secondary">No saved reports yet — use &ldquo;Save report&rdquo; above to snapshot this period.</p>
                ) : (
                  reports.map((r) => (
                    <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2 text-xs">
                      <div>
                        <p className="font-medium text-text-primary">{formatDate(r.period_start)} – {formatDate(r.period_end)}</p>
                        <p className="text-text-secondary">
                          {r.calls_analyzed} calls · avg score {r.avg_call_score ?? '—'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteReport(r.id)}
                        className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-danger"
                        aria-label="Delete report"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Methodology disclaimer */}
          <div className="mt-6 flex items-start gap-2 rounded-xl border border-dashed border-border p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
            <p className="text-xs leading-relaxed text-text-secondary">
              Every number here comes from Call Intelligence's per-call analysis — nothing on this page is scored or
              re-analyzed here. Objections and coaching tips are grouped by exact text match, not fuzzy similarity, so
              a count is always literally how many calls said the same thing. Calls without a score (not yet analyzed,
              or too short to analyze) are excluded from these metrics.
            </p>
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
