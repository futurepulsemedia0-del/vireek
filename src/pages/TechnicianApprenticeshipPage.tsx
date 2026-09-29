import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  BadgeCheck,
  BookOpen,
  Briefcase,
  Check,
  ClipboardCheck,
  Database,
  FlaskConical,
  GraduationCap,
  Lock,
  Target,
  Wrench,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { supabase, Job, TeamMember, ReviewRequest } from '@/lib/supabase';
import { computeSkillGraph } from '@/lib/technicianSkillGraph';
import { SIM_TRADES, SIM_TRADE_META, type SimTrade } from '@/lib/technicianSimulator';
import {
  APPRENTICESHIP_LEVELS,
  APPRENTICESHIP_LEVEL_LIST,
  STATUS_META,
  computeApprenticeship,
  snapshotScores,
  type ApprenticeshipAssessment,
  type ApprenticeshipLevel,
  type Pathway,
  type SimEvidenceRow,
  type StageId,
} from '@/lib/technicianApprenticeship';
import {
  completeLesson,
  createPlan,
  fetchActivePlans,
  fetchLessonCompletions,
  fetchSimEvidence,
  setPlanStatus,
  type ApprenticeshipPlan,
  type LessonCompletion,
} from '@/lib/technicianApprenticeshipApi';
import { lessonsFor } from '@/lib/apprenticeshipLessons';

// ============================================================
// DISPLAY HELPERS
// ============================================================

const DEFAULT_TARGET_LEVEL: ApprenticeshipLevel = 4;
const PATHWAYS_COLLAPSED = 4;

const STAGE_ICONS: Record<StageId, typeof Briefcase> = {
  job: Briefcase,
  learning: BookOpen,
  simulation: FlaskConical,
  assessment: ClipboardCheck,
  certification: BadgeCheck,
  real_job: Wrench,
};

/** team_members.user_id exists in the database; read it defensively in case the TeamMember type predates it. */
function memberUserId(member: TeamMember): string | null {
  return (member as TeamMember & { user_id?: string | null }).user_id ?? null;
}

const TONE_CLASSES = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  warning: 'bg-warning-500/10 text-warning-500',
  accent: 'bg-accent/10 text-accent',
  success: 'bg-success-500/10 text-success-500',
} as const;

function scoreColor(score: number | null, required: number): string {
  if (score === null) return 'text-text-secondary';
  if (score >= required) return 'text-success-500';
  if (score >= required - 15) return 'text-warning-500';
  return 'text-danger';
}

function barColor(score: number | null, required: number): string {
  if (score === null) return 'bg-bg-tertiary';
  if (score >= required) return 'bg-success-500';
  if (score >= required - 15) return 'bg-warning-500';
  return 'bg-danger';
}

function ProgressBar({
  value,
  marker,
  tone,
  label,
}: {
  value: number;
  marker?: number;
  tone: string;
  label: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className="relative h-2.5 w-full overflow-hidden rounded-full bg-bg-tertiary"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div
        className={`h-full rounded-full transition-all duration-500 ${tone}`}
        style={{ width: `${pct}%` }}
      />
      {marker !== undefined && (
        <span
          className="absolute top-0 h-full w-0.5 bg-text-primary/60"
          style={{ left: `${Math.max(0, Math.min(100, marker))}%` }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

// ============================================================
// SECTIONS
// ============================================================

function ReadinessHero({
  a,
  plan,
}: {
  a: ApprenticeshipAssessment;
  plan: ApprenticeshipPlan | null;
}) {
  const status = STATUS_META[a.status];
  const delta =
    plan && plan.baseline_readiness !== null
      ? Math.round((a.readiness - plan.baseline_readiness) * 10) / 10
      : null;
  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-text-secondary">{a.technicianName}</p>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <p className="text-sm text-text-secondary">
              Current{' '}
              <span
                className={`ml-1 text-3xl font-bold ${scoreColor(a.readiness, a.targetReadiness)}`}
              >
                {a.readiness}%
              </span>
            </p>
            <p className="text-sm text-text-secondary">
              Target{' '}
              <span className="ml-1 text-3xl font-bold text-text-primary">
                {a.targetReadiness}%
              </span>
            </p>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Level {a.targetLevel} · {a.levelLabel}
            {a.currentLevel > 0
              ? ` · currently performing at Level ${a.currentLevel}`
              : ' · not yet at Level 1 readiness'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${TONE_CLASSES[status.tone]}`}
          >
            {status.label}
          </span>
          {delta !== null && (
            <span
              className={`text-xs font-semibold ${delta >= 0 ? 'text-success-500' : 'text-danger'}`}
            >
              {delta >= 0 ? '+' : ''}
              {delta} pts since the plan started
            </span>
          )}
        </div>
      </div>
      <div className="mt-5">
        <ProgressBar
          value={a.readiness}
          marker={a.targetReadiness}
          tone={barColor(a.readiness, a.targetReadiness)}
          label="Readiness toward target"
        />
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-text-secondary">
          <span>
            {a.gapPoints > 0 ? `${a.gapPoints} points to go` : 'Readiness target reached'}
          </span>
          <span>{a.stageProgressPct}% of pathway stages complete</span>
        </div>
      </div>
      {a.next && (
        <div className="mt-5 rounded-xl border border-accent/20 bg-accent/5 p-4">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-accent">
            <Target size={13} />
            Next best step · {a.next.label}
          </p>
          <p className="mt-1 text-sm text-text-primary">{a.next.action}</p>
        </div>
      )}
    </Card>
  );
}

function GapList({ a }: { a: ApprenticeshipAssessment }) {
  if (a.gaps.length === 0) {
    return (
      <Card className="p-6">
        <h2 className="text-base font-semibold text-text-primary">What&apos;s missing</h2>
        <p className="mt-2 text-sm text-text-secondary">
          No skill gaps against Level {a.targetLevel}. Remaining work is assessment and proof on
          real jobs.
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold text-text-primary">What&apos;s missing</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Ranked by how many readiness points each gap costs.
      </p>
      <ul className="mt-4 space-y-4">
        {a.gaps.map((g) => (
          <li key={g.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-text-primary">
                {g.label}
                {g.critical && (
                  <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
                    Safety gate
                  </span>
                )}
              </p>
              <p className="text-xs text-text-secondary">
                <span className={`font-semibold ${scoreColor(g.score, g.required)}`}>
                  {g.score === null ? 'No evidence yet' : `${g.score}%`}
                </span>{' '}
                of {g.required}% needed · −{g.impactPoints} pts
              </p>
            </div>
            <div className="mt-1.5">
              <ProgressBar
                value={g.score ?? 0}
                marker={g.required}
                tone={barColor(g.score, g.required)}
                label={`${g.label} score`}
              />
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              Evidence: {g.evidence.jobs} job{g.evidence.jobs === 1 ? '' : 's'},{' '}
              {g.evidence.simulations} simulation{g.evidence.simulations === 1 ? '' : 's'} ·
              confidence {g.confidence}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PathwayCard({
  pathway,
  isSelf,
  busyLesson,
  onCompleteLesson,
}: {
  pathway: Pathway;
  isSelf: boolean;
  busyLesson: string | null;
  onCompleteLesson: (lessonId: string) => void;
}) {
  const [openLesson, setOpenLesson] = useState<string | null>(null);
  const active = pathway.activeStage;
  const showSimulator =
    (active === 'simulation' || active === 'assessment') && pathway.simulatorTrade;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-primary">{pathway.label}</p>
        <p className="text-xs text-text-secondary">
          <span className={`font-semibold ${scoreColor(pathway.score, pathway.required)}`}>
            {pathway.score === null ? 'No evidence' : `${pathway.score}%`}
          </span>{' '}
          → {pathway.required}%
        </p>
      </div>

      <ol className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {pathway.stages.map((stage) => {
          const Icon = STAGE_ICONS[stage.id];
          const tone =
            stage.state === 'done'
              ? 'bg-success-500/10 text-success-500'
              : stage.state === 'active'
                ? 'bg-accent/10 text-accent ring-1 ring-accent/40'
                : 'bg-bg-tertiary text-text-secondary/70';
          return (
            <li
              key={stage.id}
              className={`rounded-xl p-2.5 text-center ${tone}`}
              title={stage.detail}
            >
              <span className="mx-auto flex h-6 w-6 items-center justify-center">
                {stage.state === 'done' ? (
                  <Check size={16} />
                ) : stage.state === 'locked' ? (
                  <Lock size={14} />
                ) : (
                  <Icon size={16} />
                )}
              </span>
              <p className="mt-1 text-[11px] font-semibold leading-tight">{stage.label}</p>
              <span className="sr-only">
                {stage.state}. {stage.detail}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 text-sm text-text-primary">{pathway.nextAction}</p>
      {active && (
        <p className="mt-0.5 text-xs text-text-secondary">
          {pathway.stages.find((s) => s.id === active)?.detail}
        </p>
      )}

      {showSimulator && (
        <Link
          to={`/dashboard/technician-simulator?trade=${pathway.simulatorTrade}`}
          className="focus-ring mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
        >
          <FlaskConical size={13} />
          Open the {SIM_TRADE_META[pathway.simulatorTrade as SimTrade].label} simulator
        </Link>
      )}

      {active === 'learning' && (
        <ul className="mt-3 space-y-2">
          {pathway.lessons.map((lesson) => {
            const full = lessonsFor(pathway.competencyId).find((l) => l.id === lesson.id);
            const isOpen = openLesson === lesson.id;
            return (
              <li
                key={lesson.id}
                className="rounded-xl border border-border/70 bg-bg-tertiary/40 p-3"
              >
                <button
                  type="button"
                  onClick={() => setOpenLesson(isOpen ? null : lesson.id)}
                  aria-expanded={isOpen}
                  className="focus-ring flex w-full items-center justify-between gap-3 rounded-lg text-left"
                >
                  <span className="text-sm font-semibold text-text-primary">{lesson.title}</span>
                  <span className="shrink-0 text-xs text-text-secondary">
                    {lesson.done ? 'Done' : `${lesson.minutes} min`}
                  </span>
                </button>
                {isOpen && full && (
                  <div className="mt-3 space-y-2 text-sm text-text-secondary">
                    <p>{full.summary}</p>
                    <ul className="list-disc space-y-1 pl-5">
                      {full.checkpoints.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                    {!lesson.done &&
                      (isSelf ? (
                        <Button
                          size="sm"
                          onClick={() => onCompleteLesson(lesson.id)}
                          disabled={busyLesson === lesson.id}
                        >
                          {busyLesson === lesson.id ? 'Saving…' : 'Mark lesson complete'}
                        </Button>
                      ) : (
                        <p className="text-xs">The technician marks their own lessons complete.</p>
                      ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export function TechnicianApprenticeshipPage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const userId = user?.id ?? null;
  const { toast } = useToast();
  const canManage = isOwner || permissions.can_view_billing;

  const [technicians, setTechnicians] = useState<TeamMember[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [reviews, setReviews] = useState<ReviewRequest[]>([]);
  const [simRows, setSimRows] = useState<SimEvidenceRow[]>([]);
  const [plans, setPlans] = useState<ApprenticeshipPlan[]>([]);
  const [completions, setCompletions] = useState<LessonCompletion[]>([]);
  const [loading, setLoading] = useState(true);
  const [setupMissing, setSetupMissing] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [levelChoice, setLevelChoice] = useState<ApprenticeshipLevel>(DEFAULT_TARGET_LEVEL);
  const [tradeOverride, setTradeOverride] = useState<SimTrade[] | null>(null);
  const [showAllPathways, setShowAllPathways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLesson, setBusyLesson] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const [techRes, jobsRes, reviewsRes, simRes, planRes, lessonRes] = await Promise.allSettled([
        supabase
          .from('team_members')
          .select('*')
          .eq('role', 'technician')
          .eq('invite_status', 'active'),
        supabase.from('jobs').select('*').not('assigned_technician_id', 'is', null),
        supabase.from('review_requests').select('*').not('rating', 'is', null),
        fetchSimEvidence(),
        fetchActivePlans(),
        fetchLessonCompletions(),
      ]);

      const allTechs =
        techRes.status === 'fulfilled' && !techRes.value.error
          ? ((techRes.value.data as TeamMember[]) ?? [])
          : [];
      setTechnicians(canManage ? allTechs : allTechs.filter((t) => memberUserId(t) === userId));
      setJobs(jobsRes.status === 'fulfilled' ? ((jobsRes.value.data as Job[]) ?? []) : []);
      setReviews(
        reviewsRes.status === 'fulfilled' ? ((reviewsRes.value.data as ReviewRequest[]) ?? []) : [],
      );
      setSimRows(simRes.status === 'fulfilled' ? simRes.value : []);
      setPlans(planRes.status === 'fulfilled' ? planRes.value : []);
      setCompletions(lessonRes.status === 'fulfilled' ? lessonRes.value : []);
      // The three apprenticeship-owned reads only fail when the migration has not been applied yet.
      setSetupMissing([simRes, planRes, lessonRes].some((r) => r.status === 'rejected'));
    } finally {
      setLoading(false);
    }
  }, [userId, canManage]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (technicians.length > 0 && (!selectedId || !technicians.some((t) => t.id === selectedId))) {
      setSelectedId(technicians[0].id);
    }
  }, [technicians, selectedId]);

  const graph = useMemo(
    () => computeSkillGraph(jobs, reviews, technicians),
    [jobs, reviews, technicians],
  );
  const planByTech = useMemo(() => new Map(plans.map((p) => [p.team_member_id, p])), [plans]);
  const lessonsByTech = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const c of completions) {
      const set = map.get(c.team_member_id) ?? new Set<string>();
      set.add(c.lesson_id);
      map.set(c.team_member_id, set);
    }
    return map;
  }, [completions]);

  const assessments = useMemo(() => {
    const map = new Map<string, ApprenticeshipAssessment>();
    for (const tech of technicians) {
      const plan = planByTech.get(tech.id) ?? null;
      const isSelected = tech.id === selectedId;
      map.set(
        tech.id,
        computeApprenticeship({
          technician: tech,
          jobs,
          reviews,
          graph,
          simRows: simRows.filter((r) => r.technician_id === tech.id),
          completedLessonIds: lessonsByTech.get(tech.id) ?? new Set<string>(),
          targetLevel: plan?.target_level ?? (isSelected ? levelChoice : DEFAULT_TARGET_LEVEL),
          trades: plan?.trades ?? (isSelected && tradeOverride ? tradeOverride : []),
        }),
      );
    }
    return map;
  }, [
    technicians,
    planByTech,
    selectedId,
    levelChoice,
    tradeOverride,
    jobs,
    reviews,
    graph,
    simRows,
    lessonsByTech,
  ]);

  const selectedTech = technicians.find((t) => t.id === selectedId) ?? null;
  const assessment = selectedId ? (assessments.get(selectedId) ?? null) : null;
  const plan = selectedId ? (planByTech.get(selectedId) ?? null) : null;
  const isSelf = !!selectedTech && !!userId && memberUserId(selectedTech) === userId;

  const overview = useMemo(
    () => [...assessments.values()].sort((a, b) => b.gapPoints - a.gapPoints),
    [assessments],
  );

  const selectTechnician = (id: string) => {
    setSelectedId(id);
    setTradeOverride(null);
    setShowAllPathways(false);
  };

  const toggleTrade = (trade: SimTrade) => {
    if (!assessment || plan) return;
    const current = tradeOverride ?? assessment.scopeTrades;
    setTradeOverride(
      current.includes(trade) ? current.filter((t) => t !== trade) : [...current, trade],
    );
  };

  const handleStartPlan = async () => {
    if (!selectedTech || !assessment || plan || busy) return;
    if (assessment.scopeTrades.length === 0) {
      toast('Select at least one trade for this plan.', 'error');
      return;
    }
    setBusy(true);
    try {
      const created = await createPlan({
        accountOwnerId: selectedTech.account_owner_id,
        teamMemberId: selectedTech.id,
        targetLevel: assessment.targetLevel,
        trades: assessment.scopeTrades,
        baselineReadiness: assessment.readiness,
        baselineScores: snapshotScores(assessment),
      });
      setPlans((prev) => [...prev, created]);
      setTradeOverride(null);
      toast('Apprenticeship plan started.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the plan.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePlanStatus = async (status: 'cancelled' | 'completed') => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      await setPlanStatus(plan.id, status);
      setPlans((prev) => prev.filter((p) => p.id !== plan.id));
      toast(status === 'completed' ? 'Certification recorded.' : 'Plan cancelled.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the plan.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCompleteLesson = async (lessonId: string) => {
    if (!selectedTech || busyLesson) return;
    setBusyLesson(lessonId);
    try {
      await completeLesson(lessonId);
      setCompletions((prev) => [
        ...prev,
        {
          team_member_id: selectedTech.id,
          lesson_id: lessonId,
          completed_at: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the lesson.', 'error');
    } finally {
      setBusyLesson(null);
    }
  };

  const visiblePathways = assessment
    ? showAllPathways
      ? assessment.pathways
      : assessment.pathways.slice(0, PATHWAYS_COLLAPSED)
    : [];
  const fieldClass =
    'focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary';

  return (
    <DashboardLayout activeLabel="Apprenticeship Engine">
      <div className="mb-8 flex items-center gap-3">
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
            <GraduationCap size={22} className="text-accent" />
            Technician Apprenticeship Engine
          </h1>
          <p className="text-sm text-text-secondary">
            Exactly what a technician is missing for the next level, then the full path: job,
            learning, simulation, assessment, certification, real job.
          </p>
        </div>
      </div>

      {setupMissing && (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/5 p-4 text-sm text-text-secondary">
          <Database size={18} className="mt-0.5 shrink-0 text-warning-500" />
          <p>
            The apprenticeship database objects are not available yet. Apply the migration{' '}
            <span className="font-mono text-text-primary">
              20270105000000_technician_apprenticeship_engine.sql
            </span>{' '}
            to enable plans, lessons and simulator evidence.
          </p>
        </div>
      )}

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : technicians.length === 0 || !assessment || !selectedTech ? (
        <EmptyState
          icon={GraduationCap}
          title="No technicians to develop yet"
          description="Invite an active technician to your team. Their gaps and pathway will appear here as soon as they have job or simulator history."
        />
      ) : (
        <FadeIn>
          <div className="space-y-6">
            <Card className="p-6">
              <div className="grid gap-4 md:grid-cols-3">
                <label className="block text-sm font-semibold text-text-primary">
                  Technician
                  <select
                    value={selectedTech.id}
                    onChange={(e) => selectTechnician(e.target.value)}
                    disabled={technicians.length === 1}
                    className={`${fieldClass} mt-1.5 font-normal`}
                  >
                    {technicians.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.member_name || t.member_email}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-semibold text-text-primary">
                  Target level
                  <select
                    value={plan?.target_level ?? levelChoice}
                    onChange={(e) => setLevelChoice(Number(e.target.value) as ApprenticeshipLevel)}
                    disabled={!!plan || !canManage}
                    className={`${fieldClass} mt-1.5 font-normal`}
                  >
                    {APPRENTICESHIP_LEVEL_LIST.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        Level {lvl} · {APPRENTICESHIP_LEVELS[lvl].label} (
                        {APPRENTICESHIP_LEVELS[lvl].readiness}%)
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset>
                  <legend className="text-sm font-semibold text-text-primary">
                    Trades in scope
                  </legend>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {SIM_TRADES.map((trade) => {
                      const on = assessment.scopeTrades.includes(trade);
                      return (
                        <button
                          key={trade}
                          type="button"
                          onClick={() => toggleTrade(trade)}
                          disabled={!!plan || !canManage}
                          aria-pressed={on}
                          className={`focus-ring rounded-full px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60 ${on ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary'}`}
                        >
                          {SIM_TRADE_META[trade].label}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              </div>

              {canManage && (
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  {plan ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handlePlanStatus('cancelled')}
                        disabled={busy}
                      >
                        Cancel plan
                      </Button>
                      {assessment.status === 'certified' && (
                        <Button
                          size="sm"
                          onClick={() => handlePlanStatus('completed')}
                          disabled={busy}
                        >
                          Record certification
                        </Button>
                      )}
                    </>
                  ) : (
                    <Button size="sm" onClick={handleStartPlan} disabled={busy || setupMissing}>
                      {busy ? 'Starting…' : 'Start apprenticeship plan'}
                    </Button>
                  )}
                  <p className="text-xs text-text-secondary">
                    {plan
                      ? 'Plan active. Progress is measured from where this technician started.'
                      : 'Preview only until you start a plan. Nothing is saved yet.'}
                  </p>
                </div>
              )}
            </Card>

            {assessment.status === 'no_scope' ? (
              <EmptyState
                icon={Target}
                title="Select a trade"
                description="Pick at least one trade so the engine knows which technical skills to measure."
              />
            ) : (
              <>
                <ReadinessHero a={assessment} plan={plan} />
                <GapList a={assessment} />

                <section aria-labelledby="pathways-heading" className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id="pathways-heading" className="text-base font-semibold text-text-primary">
                      Pathway to Level {assessment.targetLevel}
                    </h2>
                    {assessment.pathways.length > PATHWAYS_COLLAPSED && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowAllPathways((v) => !v)}
                      >
                        {showAllPathways
                          ? 'Show top gaps only'
                          : `Show all ${assessment.pathways.length} competencies`}
                      </Button>
                    )}
                  </div>
                  {visiblePathways.map((p) => (
                    <PathwayCard
                      key={p.competencyId}
                      pathway={p}
                      isSelf={isSelf}
                      busyLesson={busyLesson}
                      onCompleteLesson={handleCompleteLesson}
                    />
                  ))}
                </section>
              </>
            )}

            {canManage && overview.length > 1 && (
              <Card className="p-6">
                <h2 className="text-base font-semibold text-text-primary">Team overview</h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Largest readiness gap first. Uses each technician&apos;s plan target, or Level{' '}
                  {DEFAULT_TARGET_LEVEL} for a preview.
                </p>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead>
                      <tr className="text-xs text-text-secondary">
                        <th scope="col" className="pb-2 pr-3 font-semibold">
                          Technician
                        </th>
                        <th scope="col" className="pb-2 pr-3 font-semibold">
                          Readiness
                        </th>
                        <th scope="col" className="pb-2 pr-3 font-semibold">
                          Gap
                        </th>
                        <th scope="col" className="pb-2 font-semibold">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.map((row) => {
                        const meta = STATUS_META[row.status];
                        return (
                          <tr key={row.technicianId} className="border-t border-border/60">
                            <td className="py-2.5 pr-3">
                              <button
                                type="button"
                                onClick={() => selectTechnician(row.technicianId)}
                                className="focus-ring rounded font-semibold text-text-primary hover:text-accent"
                              >
                                {row.technicianName}
                              </button>
                            </td>
                            <td className="py-2.5 pr-3 text-text-secondary">
                              <span
                                className={`font-semibold ${scoreColor(row.readiness, row.targetReadiness)}`}
                              >
                                {row.readiness}%
                              </span>{' '}
                              / {row.targetReadiness}%
                            </td>
                            <td className="py-2.5 pr-3 text-text-secondary">
                              {row.gapPoints > 0 ? `${row.gapPoints} pts` : '—'}
                            </td>
                            <td className="py-2.5">
                              <span
                                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_CLASSES[meta.tone]}`}
                              >
                                {meta.label}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
