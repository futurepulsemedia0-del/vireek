import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ChevronDown, Clock, ExternalLink, GraduationCap, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCard } from '@/components/Skeleton';
import { useLearnT } from '@/i18n/learnNamespace';
import {
  courseProgress, LEARN_COURSES, PASS_PCT, recommendedCourse, scoreModule,
  type LearnCourse, type LearnModule, type QuizScore,
} from '@/lib/learnCourses';
import { fetchMyCompletions, fetchTeamCompletions, recordCompletion, type CompletionRow, type TeamCompletionRow } from '@/lib/learnApi';

function Quiz({ course, mod, onPassed }: { course: LearnCourse; mod: LearnModule; onPassed: (score: QuizScore) => Promise<void> }) {
  const { t } = useLearnT();
  const [answers, setAnswers] = useState<Array<number | null>>(() => mod.questions.map(() => null));
  const [result, setResult] = useState<QuizScore | null>(null);
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (answers.some((a) => a === null)) { setMissing(true); return; }
    setMissing(false);
    const score = scoreModule(mod, answers);
    setResult(score);
    if (score.passed) {
      setSaving(true);
      try { await onPassed(score); } finally { setSaving(false); }
    }
  };

  const locked = result?.passed === true;
  return (
    <div className="mt-3 rounded-xl border border-border bg-bg-primary p-4">
      <p className="text-xs text-text-secondary">{t('quiz.passMark', { pct: PASS_PCT })}</p>
      <ol className="mt-3 space-y-5">
        {mod.questions.map((q, qi) => {
          const showWhy = locked;
          const right = answers[qi] === q.correct;
          return (
            <li key={`${course.slug}-${mod.id}-${q.id}`}>
              <fieldset disabled={locked || saving}>
                <legend className="text-sm font-medium text-text-primary">
                  <span className="sr-only">{t('quiz.question', { n: qi + 1, total: mod.questions.length })}. </span>{q.prompt}
                </legend>
                <div className="mt-2 space-y-1.5">
                  {q.options.map((opt, oi) => (
                    <label key={opt} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-bg-secondary">
                      <input
                        type="radio"
                        name={`${course.slug}-${mod.id}-${q.id}`}
                        checked={answers[qi] === oi}
                        onChange={() => { setAnswers((a) => a.map((v, i) => (i === qi ? oi : v))); setResult(null); setMissing(false); }}
                        className="mt-0.5"
                      />
                      <span>{opt}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {showWhy && (
                <p role="status" className={`mt-2 text-xs ${right ? 'text-success' : 'text-danger'}`}>
                  {right ? t('quiz.correct') : t('quiz.incorrect')} · <span className="text-text-secondary">{t('quiz.why')} {q.explain}</span>
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {missing && <p role="alert" className="mt-3 text-sm text-danger">{t('quiz.answerAll')}</p>}
      {result && (
        <p role="status" className={`mt-3 text-sm font-medium ${result.passed ? 'text-success' : 'text-warning'}`}>
          {result.passed ? t('quiz.passed', { pct: result.pct }) : t('quiz.failed', { pct: result.pct })}
        </p>
      )}
      {!locked && (
        <button type="button" onClick={() => void submit()} disabled={saving}
          className="focus-ring mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:brightness-110 disabled:opacity-50">
          {t('quiz.submit')}
        </button>
      )}
    </div>
  );
}

export function LearnPage() {
  const { user, isOwner, permissions, loading, profileLoading } = useAuth();
  const { t } = useLearnT();
  const { toast } = useToast();

  const [rows, setRows] = useState<CompletionRow[]>([]);
  const [team, setTeam] = useState<TeamCompletionRow[] | null>(null);
  const [teamError, setTeamError] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openQuiz, setOpenQuiz] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      setRows(await fetchMyCompletions(user.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('page.loadError'));
    } finally {
      setBusy(false);
    }
    if (isOwner) {
      try { setTeam(await fetchTeamCompletions()); setTeamError(false); } catch { setTeamError(true); }
    }
  }, [user, isOwner, t]);

  useEffect(() => { void load(); }, [load]);

  const done = useMemo(() => new Set(rows.map((r) => r.module_id)), [rows]);
  const best = useMemo(() => new Map(rows.map((r) => [r.module_id, r.score_pct])), [rows]);
  const recommended = recommendedCourse({ isOwner, canViewAllJobs: Boolean(permissions.can_view_all_jobs), canManageTeam: Boolean(permissions.can_manage_team) });
  const courses = useMemo(() => [...LEARN_COURSES].sort((a, b) => Number(b.slug === recommended) - Number(a.slug === recommended)), [recommended]);

  const handlePassed = async (course: LearnCourse, mod: LearnModule, score: QuizScore) => {
    try {
      await recordCompletion(course.slug, mod.id, score.pct);
      setRows((prev) => [...prev.filter((r) => !(r.course_slug === course.slug && r.module_id === mod.id)), { course_slug: course.slug, module_id: mod.id, score_pct: Math.max(score.pct, best.get(mod.id) ?? 0), completed_at: new Date().toISOString() }]);
      setOpenQuiz(null);
      if (isOwner) void fetchTeamCompletions().then(setTeam).catch(() => setTeamError(true));
    } catch {
      toast(t('quiz.saveFailed'), 'error');
    }
  };

  if (loading || profileLoading) return <DashboardLayout activeLabel="Learn"><SkeletonCard rows={4} /></DashboardLayout>;

  return (
    <DashboardLayout activeLabel="Learn">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><GraduationCap size={24} aria-hidden /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">{t('page.title')}</h1>
          <p className="text-sm text-text-secondary">{t('page.subtitle')}</p>
        </div>
      </div>

      {busy && rows.length === 0 && !error ? <SkeletonCard rows={6} /> : error ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          <span className="flex items-center gap-2"><AlertCircle size={16} aria-hidden />{error}</span>
          <button type="button" onClick={() => void load()} className="focus-ring inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium underline">
            <RefreshCw size={12} aria-hidden />{t('page.retry')}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {courses.map((course) => {
            const p = courseProgress(course, done);
            return (
              <section key={course.slug} aria-labelledby={`course-${course.slug}`} className="rounded-2xl border border-border bg-bg-secondary p-5">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 id={`course-${course.slug}`} className="text-lg font-semibold text-text-primary">{t(`courses.${course.slug}`)}</h2>
                      {course.slug === recommended && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{t('page.recommended')}</span>}
                      {p.done && <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">{t('page.courseDone')}</span>}
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">{course.summary}</p>
                  </div>
                  <p className="text-sm tabular-nums text-text-secondary">{t('page.modules', { done: p.completed, total: p.total })}</p>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-label={t(`courses.${course.slug}`)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent}>
                  <div className="h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${p.percent}%` }} />
                </div>

                <ul className="mt-4 space-y-3">
                  {course.modules.map((mod) => {
                    const key = `${course.slug}:${mod.id}`;
                    const isDone = done.has(mod.id);
                    const expanded = openQuiz === key;
                    return (
                      <li key={mod.id} className="rounded-xl border border-border bg-bg-primary p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          {isDone ? <CheckCircle2 size={18} className="text-success" aria-hidden /> : <span className="h-[18px] w-[18px] rounded-full border border-border" aria-hidden />}
                          <h3 className="text-sm font-semibold text-text-primary">{mod.title}</h3>
                          <span className="inline-flex items-center gap-1 text-xs text-text-secondary"><Clock size={12} aria-hidden />{t('page.minutes', { count: mod.minutes })}</span>
                          {isDone && <span className="text-xs text-success">{t('page.completed')} · {t('page.score', { pct: best.get(mod.id) ?? 0 })}</span>}
                          <Link to={mod.route} className="focus-ring ms-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline">
                            {t('page.openScreen')}: {mod.screen} <ExternalLink size={12} aria-hidden />
                          </Link>
                        </div>
                        <details className="mt-2 text-sm text-text-secondary">
                          <summary className="focus-ring cursor-pointer rounded text-text-primary">{t('objectives')}</summary>
                          <ul className="ms-5 mt-1 list-disc">{mod.objectives.map((o) => <li key={o}>{o}</li>)}</ul>
                          <p className="mt-2 font-medium text-text-primary">{t('steps')}</p>
                          <ol className="ms-5 list-decimal">{mod.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                        </details>
                        <button type="button" aria-expanded={expanded} onClick={() => setOpenQuiz(expanded ? null : key)}
                          className="focus-ring mt-3 inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary">
                          {isDone ? t('page.retakeQuiz') : t('page.startQuiz')}
                          <ChevronDown size={12} className={expanded ? 'rotate-180' : ''} aria-hidden />
                        </button>
                        {expanded && <Quiz key={key} course={course} mod={mod} onPassed={(s) => handlePassed(course, mod, s)} />}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          {isOwner && (
            <section aria-labelledby="team-record" className="rounded-2xl border border-border bg-bg-secondary p-5">
              <h2 id="team-record" className="text-lg font-semibold text-text-primary">{t('team.title')}</h2>
              <p className="mt-1 text-sm text-text-secondary">{t('team.body')}</p>
              {teamError ? (
                <p role="alert" className="mt-3 text-sm text-danger">{t('team.loadError')}</p>
              ) : team && team.length === 0 ? (
                <p className="mt-3 text-sm text-text-secondary">{t('team.empty')}</p>
              ) : team && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[28rem] text-sm">
                    <thead>
                      <tr className="text-xs text-text-secondary">
                        <th scope="col" className="py-2 text-start font-medium">{t('team.person')}</th>
                        <th scope="col" className="py-2 text-start font-medium">{t('team.course')}</th>
                        <th scope="col" className="py-2 text-end font-medium">{t('team.modules')}</th>
                        <th scope="col" className="py-2 text-end font-medium">{t('team.last')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {team.map((r) => {
                        const total = LEARN_COURSES.find((c) => c.slug === r.course)?.modules.length ?? 0;
                        return (
                          <tr key={`${r.userId}-${r.course}`} className="border-t border-border">
                            <td className="py-2 text-text-primary">{r.displayName}</td>
                            <td className="py-2 text-text-primary">{t(`courses.${r.course}`)}</td>
                            <td className="py-2 text-end tabular-nums text-text-primary" dir="ltr">{r.modulesCompleted}/{total}</td>
                            <td className="py-2 text-end tabular-nums text-text-secondary" dir="ltr">{new Date(r.lastCompletedAt).toLocaleDateString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
