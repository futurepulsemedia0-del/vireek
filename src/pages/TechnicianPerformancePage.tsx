import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Lock,
  Download,
  Save,
  ChevronDown,
  ChevronUp,
  Trash2,
  History,
  Wrench,
  DollarSign,
  Star,
  Gauge,
  AlertTriangle,
  Lightbulb,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { supabase, Job, TeamMember, ReviewRequest } from '@/lib/supabase';
import { exportToCsv } from '@/lib/csvExport';
import {
  computeTechnicianPerformance,
  saveTechnicianScorecard,
  fetchTechnicianScorecards,
  deleteTechnicianScorecard,
  type TechnicianMetrics,
  type TechnicianScorecard,
} from '@/lib/technicianPerformance';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonCardList, FadeIn } from '@/components/Skeleton';

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
  return { start, end };
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function rateColor(value: number | null, goodAbove: number): string {
  if (value === null) return 'text-text-secondary';
  if (value >= goodAbove) return 'text-success-500';
  if (value >= goodAbove - 15) return 'text-warning-500';
  return 'text-danger';
}

function severityColor(severity: 'low' | 'medium' | 'high'): string {
  if (severity === 'high') return 'bg-danger/10 text-danger';
  if (severity === 'medium') return 'bg-warning-500/10 text-warning-500';
  return 'bg-bg-tertiary text-text-secondary';
}

function ftfBadgeClasses(value: number | null): string {
  if (value === null) return 'bg-bg-tertiary text-text-secondary';
  if (value >= 80) return 'bg-success-500/10 text-success-500';
  if (value >= 65) return 'bg-warning-500/10 text-warning-500';
  return 'bg-danger/10 text-danger';
}

// ============================================================
// SCORECARD CARD
// ============================================================

function StatBlock({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div>
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-0.5 text-lg font-bold ${color ?? 'text-text-primary'}`}>{value}</p>
      {sub && <p className="text-[11px] text-text-secondary/70">{sub}</p>}
    </div>
  );
}

function TechnicianScorecardCard({ metrics }: { metrics: TechnicianMetrics }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">{metrics.technicianName}</p>
          <p className="text-xs text-text-secondary">{metrics.jobsCompleted} jobs completed this period</p>
        </div>
        {metrics.jobsCompleted > 0 && (
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${ftfBadgeClasses(metrics.firstTimeFixRate)}`}>
            {metrics.firstTimeFixRate ?? '—'}% FTF
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatBlock
          label="First-time-fix"
          value={metrics.firstTimeFixRate !== null ? `${metrics.firstTimeFixRate}%` : '—'}
          color={rateColor(metrics.firstTimeFixRate, 80)}
        />
        <StatBlock
          label="Callback rate"
          value={metrics.callbackRate !== null ? `${metrics.callbackRate}%` : '—'}
          color={rateColor(metrics.callbackRate === null ? null : 100 - metrics.callbackRate, 85)}
        />
        <StatBlock
          label="Avg job duration"
          value={metrics.avgJobDurationMinutes !== null ? `${Math.round(metrics.avgJobDurationMinutes)} min` : '—'}
        />
        <StatBlock label="Revenue" value={formatCents(metrics.revenueCents)} />
        <StatBlock
          label="CSAT"
          value={metrics.csatAvg !== null ? `${metrics.csatAvg}/5` : '—'}
          sub={metrics.csatResponses > 0 ? `${metrics.csatResponses} response${metrics.csatResponses === 1 ? '' : 's'}` : undefined}
          color={rateColor(metrics.csatAvg === null ? null : metrics.csatAvg * 20, 80)}
        />
        <StatBlock
          label="Utilization"
          value={metrics.utilizationRate !== null ? `${metrics.utilizationRate}%` : '—'}
          color={metrics.utilizationRate !== null && metrics.utilizationRate > 95 ? 'text-warning-500' : undefined}
        />
      </div>

      {(metrics.trainingGaps.length > 0 || metrics.aiCoachingNotes.length > 0) && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="focus-ring flex items-center gap-1.5 text-xs font-semibold text-accent"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {expanded ? 'Hide' : 'Show'} training gaps & AI coaching
            {metrics.trainingGaps.length > 0 && (
              <span className="ml-1 rounded-full bg-warning-500/10 px-1.5 py-0.5 text-[10px] text-warning-500">
                {metrics.trainingGaps.length}
              </span>
            )}
          </button>

          {expanded && (
            <div className="mt-3 space-y-3">
              {metrics.trainingGaps.length > 0 && (
                <div className="space-y-1.5">
                  {metrics.trainingGaps.map((gap, i) => (
                    <div key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${severityColor(gap.severity)}`}>
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      <span>{gap.reason}</span>
                    </div>
                  ))}
                </div>
              )}
              {metrics.aiCoachingNotes.length > 0 && (
                <div className="space-y-1.5">
                  {metrics.aiCoachingNotes.map((note, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-lg border border-border/70 px-3 py-2 text-xs">
                      <Lightbulb size={13} className="mt-0.5 shrink-0 text-accent" />
                      <div>
                        <p className="text-text-primary">{note.tip}</p>
                        <p className="mt-0.5 text-text-secondary/70">{note.basis}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export function TechnicianPerformancePage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_view_billing;

  const [technicians, setTechnicians] = useState<TeamMember[]>([]);
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [allReviews, setAllReviews] = useState<ReviewRequest[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [saving, setSaving] = useState(false);

  const [history, setHistory] = useState<TechnicianScorecard[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  const loadData = useCallback(async () => {
    if (!user || !canAccess) return;
    setDataLoading(true);
    try {
      const [techRes, jobsRes, reviewsRes] = await Promise.all([
        supabase.from('team_members').select('*').eq('role', 'technician').eq('invite_status', 'active'),
        supabase.from('jobs').select('*').not('assigned_technician_id', 'is', null),
        supabase.from('review_requests').select('*').not('rating', 'is', null),
      ]);
      if (techRes.error) throw techRes.error;
      setTechnicians((techRes.data as TeamMember[]) ?? []);
      setAllJobs((jobsRes.data as Job[]) ?? []);
      setAllReviews((reviewsRes.data as ReviewRequest[]) ?? []);
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
      setHistory(await fetchTechnicianScorecards());
    } catch {
      // history section just stays empty
    } finally {
      setHistoryLoading(false);
    }
  }, [user, canAccess]);

  useEffect(() => {
    loadData();
    loadHistory();
  }, [loadData, loadHistory]);

  const range = useMemo(() => getRange(preset), [preset]);

  const result = useMemo(
    () => computeTechnicianPerformance(allJobs, allReviews, technicians, range.start, range.end),
    [allJobs, allReviews, technicians, range],
  );

  const handleSaveSnapshot = async () => {
    if (!user) return;
    const withActivity = result.byTechnician.filter((t) => t.jobsCompleted > 0);
    if (withActivity.length === 0) {
      toast('No completed jobs in this period to save.', 'error');
      return;
    }
    setSaving(true);
    try {
      await Promise.all(
        withActivity.map((t) => saveTechnicianScorecard(t.technicianId, t, range.start, range.end, user.id)),
      );
      toast(`Saved scorecards for ${withActivity.length} technician${withActivity.length === 1 ? '' : 's'}.`, 'success');
      loadHistory();
    } catch {
      toast('Could not save scorecards. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteHistoryRow = async (id: string) => {
    try {
      await deleteTechnicianScorecard(id);
      setHistory((prev) => prev.filter((r) => r.id !== id));
      toast('Scorecard deleted.', 'success');
    } catch {
      toast('Could not delete this scorecard.', 'error');
    }
  };

  const handleExport = () => {
    exportToCsv(
      result.byTechnician,
      [
        { header: 'Technician', accessor: (t) => t.technicianName },
        { header: 'Jobs Completed', accessor: (t) => t.jobsCompleted },
        { header: 'First-Time-Fix Rate %', accessor: (t) => t.firstTimeFixRate },
        { header: 'Callback Rate %', accessor: (t) => t.callbackRate },
        { header: 'Avg Job Duration (min)', accessor: (t) => t.avgJobDurationMinutes },
        { header: 'Revenue', accessor: (t) => (t.revenueCents / 100).toFixed(2) },
        { header: 'CSAT', accessor: (t) => t.csatAvg },
        { header: 'CSAT Responses', accessor: (t) => t.csatResponses },
        { header: 'Utilization %', accessor: (t) => t.utilizationRate },
        { header: 'Training Gaps', accessor: (t) => t.trainingGaps.map((g) => g.serviceType).join('; ') },
      ],
      'technician-performance.csv',
    );
    toast('Technician performance exported as CSV.', 'success');
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Technician Performance">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Technician Performance access is restricted. Ask your account owner to grant you the "View Billing"
            permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const loading = dataLoading;
  const fleet = result.fleet;

  return (
    <DashboardLayout activeLabel="Technician Performance">
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
                <Gauge size={16} />
              </span>
              <h1 className="text-2xl font-bold text-text-primary">Technician Performance OS</h1>
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              Scorecards, first-time-fix rate, revenue per tech, callbacks, CSAT, utilization, training gaps and
              AI coaching — for every dispatch-enabled technician.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-border bg-bg-secondary p-1">
            {(['7d', '30d', '90d'] as RangePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPreset(p)}
                className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  preset === p ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {p === '7d' ? '7 days' : p === '30d' ? '30 days' : '90 days'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleExport}
            disabled={loading || fleet.jobsCompleted === 0}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={14} />
            Export CSV
          </button>
          <button
            type="button"
            onClick={handleSaveSnapshot}
            disabled={saving || loading || fleet.jobsCompleted === 0}
            className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving…' : 'Save snapshot'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-6">
          <SkeletonStatGrid count={6} />
          <SkeletonCardList count={4} rows={3} />
        </div>
      ) : (
        <FadeIn>
          {technicians.length === 0 ? (
            <EmptyState
              icon={Wrench}
              title="No dispatch-enabled technicians yet"
              description="Add technicians under Team and enable dispatch to start seeing performance scorecards here."
              action={{ label: 'Go to Team', onClick: () => navigate('/dashboard/team') }}
            />
          ) : (
            <>
              <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Card className="p-4 text-center">
                  <p className="text-xl font-bold text-text-primary">{fleet.technicianCount}</p>
                  <p className="text-xs text-text-secondary">Technicians</p>
                </Card>
                <Card className="p-4 text-center">
                  <p className="text-xl font-bold text-text-primary">{fleet.jobsCompleted}</p>
                  <p className="text-xs text-text-secondary">Jobs completed</p>
                </Card>
                <Card className={`p-4 text-center ${rateColor(fleet.avgFirstTimeFixRate, 80)}`}>
                  <p className="text-xl font-bold">{fleet.avgFirstTimeFixRate ?? '—'}%</p>
                  <p className="text-xs text-text-secondary">Avg first-time-fix</p>
                </Card>
                <Card className="p-4 text-center">
                  <p className="text-xl font-bold text-text-primary">{fleet.avgCallbackRate ?? '—'}%</p>
                  <p className="text-xs text-text-secondary">Avg callback rate</p>
                </Card>
                <Card className="p-4 text-center">
                  <p className="flex items-center justify-center gap-1 text-xl font-bold text-text-primary">
                    <DollarSign size={16} />
                    {formatCents(fleet.revenueCents)}
                  </p>
                  <p className="text-xs text-text-secondary">Revenue, all techs</p>
                </Card>
                <Card className="p-4 text-center">
                  <p className="flex items-center justify-center gap-1 text-xl font-bold text-text-primary">
                    <Star size={14} className="text-warning-500" />
                    {fleet.avgCsat ?? '—'}
                  </p>
                  <p className="text-xs text-text-secondary">Avg CSAT</p>
                </Card>
              </div>

              <div className="mb-8 grid gap-4 sm:grid-cols-2">
                {result.byTechnician.map((metrics) => (
                  <TechnicianScorecardCard key={metrics.technicianId} metrics={metrics} />
                ))}
              </div>

              <Card className="p-6">
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  className="focus-ring flex w-full items-center justify-between text-left"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                    <History size={15} />
                    Saved scorecard snapshots
                  </span>
                  {showHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>

                {showHistory && (
                  <div className="mt-4 space-y-1.5">
                    {historyLoading ? (
                      <div className="space-y-2">
                        {[0, 1, 2].map((i) => (
                          <div key={i} className="h-10 animate-pulse rounded-lg bg-bg-tertiary" />
                        ))}
                      </div>
                    ) : history.length === 0 ? (
                      <p className="py-4 text-center text-sm text-text-secondary">
                        No saved snapshots yet — use "Save snapshot" above to keep a record of this period.
                      </p>
                    ) : (
                      history.map((row) => {
                        const tech = technicians.find((t) => t.id === row.technician_id);
                        return (
                          <div
                            key={row.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2 text-xs"
                          >
                            <span className="font-medium text-text-primary">
                              {tech?.member_name || tech?.member_email || 'Unknown technician'}
                            </span>
                            <span className="text-text-secondary">
                              {row.period_start} → {row.period_end}
                            </span>
                            <span className="text-text-secondary">{row.jobs_completed} jobs</span>
                            <span className={rateColor(row.first_time_fix_rate, 80)}>
                              {row.first_time_fix_rate ?? '—'}% FTF
                            </span>
                            <span className="text-text-secondary">{formatCents(row.revenue_cents)}</span>
                            <button
                              type="button"
                              onClick={() => handleDeleteHistoryRow(row.id)}
                              className="focus-ring text-text-secondary/70 transition-colors hover:text-danger"
                              aria-label="Delete snapshot"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </Card>
            </>
          )}
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
