import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ClipboardCheck,
  Database,
  Activity,
  Minus,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import {
  DOCUMENTATION_PARTS,
  LEVEL_META,
  adoptionTrend,
  buildOnboardingPlan,
  computeAdoption,
  computeAdoptionSummary,
  interventionOutcome,
  type AdoptionLevel,
  type AdoptionTrend,
  type TechnicianAdoption,
} from '@/lib/adoptionIntelligence';
import {
  closeIntervention,
  createIntervention,
  fetchAdoptionSignals,
  fetchInterventions,
  type AdoptionIntervention,
  type AdoptionWindowDays,
} from '@/lib/adoptionIntelligenceApi';

// ============================================================
// DISPLAY HELPERS
// ============================================================

const WINDOWS: AdoptionWindowDays[] = [30, 60, 90];

const TONE_CLASSES = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  warning: 'bg-warning-500/10 text-warning-500',
  accent: 'bg-accent/10 text-accent',
  success: 'bg-success-500/10 text-success-500',
} as const;

const LEVEL_ORDER: Record<AdoptionLevel, number> = { low: 0, medium: 1, high: 2, insufficient: 3 };

function barColor(pct: number | null): string {
  if (pct === null) return 'bg-bg-tertiary';
  if (pct >= 75) return 'bg-success-500';
  if (pct >= 50) return 'bg-accent';
  return 'bg-warning-500';
}

function formatPct(value: number | null): string {
  return value === null ? '-' : `${value}%`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function LevelBadge({ level }: { level: AdoptionLevel }) {
  const meta = LEVEL_META[level];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_CLASSES[meta.tone]}`}
    >
      {meta.label}
    </span>
  );
}

function TrendIcon({ trend }: { trend: AdoptionTrend }) {
  if (trend === 'improving')
    return <TrendingUp size={16} className="text-success-500" aria-label="Improving" />;
  if (trend === 'declining')
    return <TrendingDown size={16} className="text-warning-500" aria-label="Declining" />;
  if (trend === 'steady') return <Minus size={16} className="text-text-secondary" aria-label="Steady" />;
  return null;
}

function Bar({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-text-secondary">{label}</span>
        <span className="font-semibold text-text-primary">{formatPct(value)}</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-bg-tertiary"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? 0}
      >
        <div className={`h-full rounded-full ${barColor(value)}`} style={{ width: `${value ?? 0}%` }} />
      </div>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="!p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-3xl font-bold text-text-primary">{value}</p>
      <p className="mt-1 text-xs text-text-secondary">{hint}</p>
    </Card>
  );
}

// ============================================================
// PAGE
// ============================================================

export function AdoptionOSPage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const userId = user?.id ?? null;
  const { toast } = useToast();
  const canManage = isOwner || permissions.can_view_billing;

  const [windowDays, setWindowDays] = useState<AdoptionWindowDays>(30);
  const [current, setCurrent] = useState<TechnicianAdoption[]>([]);
  const [previousScores, setPreviousScores] = useState<Record<string, number | null>>({});
  const [interventions, setInterventions] = useState<AdoptionIntervention[]>([]);
  const [loading, setLoading] = useState(true);
  const [setupMissing, setSetupMissing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadData = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const [currentRes, previousRes, interventionRes] = await Promise.allSettled([
        fetchAdoptionSignals(windowDays, 0),
        fetchAdoptionSignals(windowDays, windowDays),
        fetchInterventions(),
      ]);
      setCurrent(
        currentRes.status === 'fulfilled' ? currentRes.value.map(computeAdoption) : [],
      );
      const prev: Record<string, number | null> = {};
      if (previousRes.status === 'fulfilled') {
        for (const row of previousRes.value) {
          const a = computeAdoption(row);
          prev[a.technicianId] = a.score;
        }
      }
      setPreviousScores(prev);
      setInterventions(interventionRes.status === 'fulfilled' ? interventionRes.value : []);
      // Both reads only fail together when the migration has not been applied yet.
      setSetupMissing(currentRes.status === 'rejected' || interventionRes.status === 'rejected');
    } finally {
      setLoading(false);
    }
  }, [userId, windowDays]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const sorted = useMemo(
    () =>
      [...current].sort(
        (a, b) =>
          LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
          (a.score ?? 101) - (b.score ?? 101) ||
          a.name.localeCompare(b.name),
      ),
    [current],
  );
  const summary = useMemo(() => computeAdoptionSummary(current), [current]);
  const selected = useMemo(
    () => sorted.find((t) => t.technicianId === selectedId) ?? sorted[0] ?? null,
    [sorted, selectedId],
  );
  const plan = useMemo(() => (selected ? buildOnboardingPlan(selected) : []), [selected]);
  const openPlan = selected
    ? interventions.find((i) => i.team_member_id === selected.technicianId && i.status === 'open')
    : undefined;
  const history = selected
    ? interventions.filter((i) => i.team_member_id === selected.technicianId && i.status !== 'open')
    : [];
  const weakestTeamLabel =
    DOCUMENTATION_PARTS.find((p) => p.part === summary.weakestTeamPart)?.label ?? null;

  const startPlan = async () => {
    if (!selected || plan.length === 0 || busy) return;
    setBusy(true);
    try {
      const created = await createIntervention({
        teamMemberId: selected.technicianId,
        focus: selected.gaps,
        steps: plan,
        baselineScore: selected.score,
      });
      setInterventions((prev) => [created, ...prev]);
      toast('Onboarding plan started.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the plan.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const closePlan = async (id: string, status: 'completed' | 'dismissed') => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await closeIntervention(id, status, selected.score);
      setInterventions(await fetchInterventions());
      toast(status === 'completed' ? 'Plan marked complete.' : 'Plan dismissed.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the plan.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Adoption OS">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
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
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Activity size={22} className="text-accent" />
              Adoption OS
            </h1>
            <p className="text-sm text-text-secondary">
              Which technicians actually use the system, where they get stuck, and a personal
              onboarding plan for each one.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2" role="group" aria-label="Measurement window">
          {WINDOWS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === windowDays ? 'primary' : 'secondary'}
              aria-pressed={d === windowDays}
              onClick={() => setWindowDays(d)}
            >
              {d} days
            </Button>
          ))}
        </div>
      </div>

      {setupMissing && (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/5 p-4 text-sm text-text-secondary">
          <Database size={18} className="mt-0.5 shrink-0 text-warning-500" />
          <p>
            The adoption database objects are not available yet. Apply the migration{' '}
            <span className="font-mono text-text-primary">20270210000000_adoption_os.sql</span> to
            enable adoption signals and onboarding plans.
          </p>
        </div>
      )}

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : !selected ? (
        <EmptyState
          icon={Users}
          title="No active technicians to measure"
          description="Invite technicians to your team. Adoption is measured from the jobs they complete."
          action={
            canManage ? (
              <Link to="/dashboard/team">
                <Button size="sm">Open team</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <FadeIn>
          {canManage ? (
            <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Adoption rate"
                value={formatPct(summary.adoptionRatePct)}
                hint={`${summary.high + summary.medium} of ${summary.measured} measured technicians`}
              />
              <StatCard
                label="Avg AI usage"
                value={formatPct(summary.avgAiUsagePct)}
                hint="Jobs where a copilot was used"
              />
              <StatCard
                label="Avg documentation"
                value={formatPct(summary.avgDocumentationPct)}
                hint={weakestTeamLabel ? `Weakest: ${weakestTeamLabel}` : 'Across completed jobs'}
              />
              <StatCard
                label="Need onboarding"
                value={String(summary.low)}
                hint={`${summary.insufficient} with too few jobs to rate`}
              />
            </div>
          ) : (
            <p className="mb-6 text-sm text-text-secondary">Showing your own adoption.</p>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <div className="space-y-3" role="list" aria-label="Technicians">
              {sorted.map((t) => {
                const active = t.technicianId === selected.technicianId;
                return (
                  <button
                    key={t.technicianId}
                    type="button"
                    role="listitem"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setSelectedId(t.technicianId)}
                    className={`focus-ring w-full rounded-xl border p-4 text-left transition-colors ${
                      active
                        ? 'border-accent bg-accent/5'
                        : 'border-border bg-bg-secondary hover:border-accent/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-text-primary">{t.name}</p>
                        <p className="text-xs text-text-secondary">
                          {t.jobsCompleted} completed {t.jobsCompleted === 1 ? 'job' : 'jobs'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <TrendIcon trend={adoptionTrend(t.score, previousScores[t.technicianId] ?? null)} />
                        <LevelBadge level={t.level} />
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-4">
                      <Bar label="AI usage" value={t.aiUsagePct} />
                      <Bar label="Documentation" value={t.documentationPct} />
                    </div>
                  </button>
                );
              })}
            </div>

            <Card className="h-fit">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-text-primary">{selected.name}</h2>
                  <p className="text-sm text-text-secondary">
                    Adoption score {selected.score ?? '-'} / 100 over the last {windowDays} days
                  </p>
                </div>
                <LevelBadge level={selected.level} />
              </div>

              <div className="mt-5 grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl bg-bg-tertiary p-3">
                  <Bot size={16} className="mx-auto text-accent" />
                  <p className="mt-1 text-lg font-bold text-text-primary">{selected.aiSessions}</p>
                  <p className="text-xs text-text-secondary">Copilot sessions</p>
                </div>
                <div className="rounded-xl bg-bg-tertiary p-3">
                  <ClipboardCheck size={16} className="mx-auto text-accent" />
                  <p className="mt-1 text-lg font-bold text-text-primary">{selected.lessonsCompleted}</p>
                  <p className="text-xs text-text-secondary">Lessons done</p>
                </div>
                <div className="rounded-xl bg-bg-tertiary p-3">
                  <Users size={16} className="mx-auto text-accent" />
                  <p className="mt-1 text-lg font-bold text-text-primary">{selected.simulatorAttempts}</p>
                  <p className="text-xs text-text-secondary">Simulator runs</p>
                </div>
              </div>

              <h3 className="mt-6 text-sm font-semibold text-text-primary">Documentation breakdown</h3>
              <div className="mt-3 space-y-3">
                {selected.breakdown.map((b) => (
                  <Bar key={b.part} label={b.label} value={b.pct} />
                ))}
              </div>

              <h3 className="mt-6 text-sm font-semibold text-text-primary">Personal onboarding plan</h3>
              {selected.level === 'insufficient' ? (
                <p className="mt-2 text-sm text-text-secondary">
                  A plan is created once this technician has completed at least 3 jobs in the
                  window.
                </p>
              ) : plan.length === 0 ? (
                <p className="mt-2 text-sm text-text-secondary">
                  Adoption is high. Nothing to fix here, so recognise the habit and let others learn
                  from it.
                </p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {(openPlan?.steps ?? plan).map((step, index) => (
                    <li key={step.id} className="rounded-xl border border-border p-3">
                      <p className="text-sm font-semibold text-text-primary">
                        {index + 1}. {step.title}
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">{step.why}</p>
                      <p className="mt-1 text-xs text-text-primary">{step.action}</p>
                      {step.href && (
                        <Link
                          to={step.href}
                          className="focus-ring mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent"
                        >
                          Open tool <ArrowRight size={12} />
                        </Link>
                      )}
                    </li>
                  ))}
                </ol>
              )}

              {canManage && plan.length > 0 && !openPlan && (
                <div className="mt-4">
                  <Button size="sm" onClick={startPlan} disabled={busy || setupMissing}>
                    Start onboarding plan
                  </Button>
                </div>
              )}

              {openPlan && (
                <div className="mt-4 rounded-xl bg-accent/5 p-3 text-sm text-text-secondary">
                  <p>
                    Plan active since {formatDate(openPlan.created_at)}
                    {openPlan.baseline_score !== null
                      ? `, baseline score ${openPlan.baseline_score}.`
                      : '.'}
                  </p>
                  {canManage && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => closePlan(openPlan.id, 'completed')}
                      >
                        Mark complete
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => closePlan(openPlan.id, 'dismissed')}
                      >
                        Dismiss
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {history.length > 0 && (
                <>
                  <h3 className="mt-6 text-sm font-semibold text-text-primary">Past plans</h3>
                  <ul className="mt-2 space-y-2">
                    {history.map((h) => {
                      const outcome = interventionOutcome(h.baseline_score, h.outcome_score);
                      return (
                        <li
                          key={h.id}
                          className="flex items-center justify-between gap-3 text-xs text-text-secondary"
                        >
                          <span>
                            {formatDate(h.created_at)} -{' '}
                            {h.status === 'completed' ? 'completed' : 'dismissed'}
                          </span>
                          {h.status === 'completed' && (
                            <span className="font-semibold text-text-primary">
                              {outcome.verdict === 'unmeasured'
                                ? 'Not measured'
                                : `${outcome.verdict} (${outcome.delta !== null && outcome.delta > 0 ? '+' : ''}${outcome.delta} pts)`}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              <p className="mt-6 text-xs text-text-secondary">
                Adoption is measured per completed job from work already recorded in Vireek. It
                never uses location, screen time or keystrokes, and it is meant to target training,
                not to rank people.
              </p>
            </Card>
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
