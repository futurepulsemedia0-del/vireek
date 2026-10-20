import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, CheckCircle2, ExternalLink, GraduationCap, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonCardList } from '@/components/Skeleton';
import { ProgressBar, SopMarkdown, StatusBadge } from '@/components/sop/SopUi';
import {
  QuizResult,
  SOP_LIMITS,
  SopReader,
  TrainingRow,
  acknowledgeSop,
  describeSopError,
  dueState,
  fetchMyTraining,
  fetchSopReader,
  formatDue,
  isQuizComplete,
  openSopFile,
  sortTraining,
  submitSopQuiz,
  summarizeCompletion,
} from '@/lib/sop';

// ============================================================
// Reader: read → quiz (if any) → acknowledge
// ============================================================

function SopReaderView({ sopId, onBack, onChanged }: { sopId: string; onBack: () => void; onChanged: () => void }) {
  const { profile, teamMember } = useAuth();
  const { toast } = useToast();
  const [reader, setReader] = useState<SopReader | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Array<number | null>>([]);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState(teamMember?.member_name ?? profile?.full_name ?? '');
  const [acking, setAcking] = useState(false);
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetchSopReader(sopId);
      setReader(r);
      setAnswers(r.questions.map(() => null));
      setResult(null);
    } catch (err) {
      setError(describeSopError(err, 'Could not open this SOP.'));
    }
  }, [sopId]);

  useEffect(() => { setReader(null); void load(); }, [load]);

  if (error) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-8 text-center">
        <AlertCircle className="text-danger" />
        <p className="text-sm text-text-primary">{error}</p>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>Back</Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}><RefreshCw size={16} /> Try again</Button>
        </div>
      </div>
    );
  }
  if (!reader) return <SkeletonCardList count={2} rows={3} />;

  const quizPassed = reader.my.quiz_passed || result?.passed === true;
  const acknowledgedAt = reader.my.acknowledged_at;
  const hasQuiz = reader.questions.length > 0;
  const canAcknowledge = !acknowledgedAt && (!hasQuiz || quizPassed);

  const submitQuiz = async () => {
    if (!isQuizComplete(answers, reader.questions.length)) return;
    setSubmitting(true);
    try {
      const r = await submitSopQuiz(reader.sop_id, answers as number[]);
      setResult(r);
      if (r.passed) toast(`Passed with ${r.score_pct}%.`, 'success');
      onChanged();
    } catch (err) {
      toast(describeSopError(err, 'Could not submit the quiz.'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const acknowledge = async () => {
    setAcking(true);
    try {
      const at = await acknowledgeSop(reader.sop_id, name);
      setReader({ ...reader, my: { ...reader.my, acknowledged_at: at } });
      toast('Acknowledged. Thank you.', 'success');
      onChanged();
    } catch (err) {
      toast(describeSopError(err, 'Could not record your acknowledgement.'), 'error');
    } finally {
      setAcking(false);
    }
  };

  const openFile = async () => {
    if (!reader.file_path) return;
    setOpening(true);
    try {
      await openSopFile(reader.file_path);
    } catch (err) {
      toast(describeSopError(err, 'Could not open the file.'), 'error');
    } finally {
      setOpening(false);
    }
  };

  return (
    <article className="space-y-6">
      <button type="button" onClick={onBack} className="focus-ring inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} /> My training
      </button>

      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-text-primary">{reader.title}</h1>
          <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs font-semibold text-text-secondary">v{reader.version}</span>
        </div>
        {reader.summary && <p className="text-sm text-text-secondary">{reader.summary}</p>}
        {reader.change_note && (
          <p className="rounded-lg bg-warning-500/10 px-3 py-2 text-xs text-text-primary">
            <span className="font-semibold">What changed: </span>{reader.change_note}
          </p>
        )}
      </header>

      {reader.file_path && (
        <Button type="button" variant="secondary" size="sm" onClick={() => void openFile()} disabled={opening}>
          <ExternalLink size={16} /> {opening ? 'Opening…' : `Open ${reader.file_name ?? 'attached file'}`}
        </Button>
      )}

      {reader.body_md && (
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <SopMarkdown source={reader.body_md} />
        </div>
      )}

      {hasQuiz && (
        <section aria-labelledby="sop-quiz-title" className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="sop-quiz-title" className="text-base font-bold text-text-primary">Quiz</h2>
            <span className="text-xs text-text-secondary">Pass mark {reader.pass_score_pct}%{reader.my.best_score !== null ? ` · your best ${reader.my.best_score}%` : ''}</span>
          </div>

          {quizPassed && !result ? (
            <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 size={16} /> You have passed this quiz.</p>
          ) : (
            <>
              {reader.questions.map((q, qi) => {
                const wrong = result && !result.passed && result.wrong.includes(qi);
                return (
                  <fieldset key={qi} className={`space-y-2 rounded-xl border p-3 ${wrong ? 'border-danger/50' : 'border-border'}`}>
                    <legend className="px-1 text-sm font-medium text-text-primary">{qi + 1}. {q.prompt}</legend>
                    {q.options.map((opt, oi) => (
                      <label key={oi} className="flex cursor-pointer items-start gap-2 text-sm text-text-secondary">
                        <input
                          type="radio"
                          name={`q-${qi}`}
                          checked={answers[qi] === oi}
                          disabled={submitting || quizPassed}
                          onChange={() => { setAnswers((a) => a.map((v, i) => (i === qi ? oi : v))); }}
                          className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]"
                        />
                        {opt}
                      </label>
                    ))}
                    {wrong && <p role="alert" className="text-xs text-danger">Not quite — review the procedure and try again.</p>}
                  </fieldset>
                );
              })}
              {result && !result.passed && (
                <p role="alert" className="text-sm text-danger">
                  You scored {result.score_pct}% ({result.correct} of {result.total}). You need {result.pass_score_pct}%. Review the procedure and try again.
                </p>
              )}
              <Button type="button" size="sm" onClick={() => void submitQuiz()} disabled={submitting || !isQuizComplete(answers, reader.questions.length)}>
                {submitting ? 'Checking…' : result && !result.passed ? 'Try again' : 'Submit answers'}
              </Button>
            </>
          )}
        </section>
      )}

      <section aria-labelledby="sop-ack-title" className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-5">
        <h2 id="sop-ack-title" className="text-base font-bold text-text-primary">Acknowledgement</h2>
        {acknowledgedAt ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 size={16} /> You acknowledged version {reader.version} on {new Date(acknowledgedAt).toLocaleString()}.
          </p>
        ) : (
          <>
            <p className="text-sm text-text-secondary">
              {hasQuiz && !quizPassed
                ? 'Pass the quiz above to unlock acknowledgement.'
                : 'Type your full name to confirm you have read and understood this procedure. This is recorded with the time and the version.'}
            </p>
            <div className="max-w-sm">
              <Input
                aria-label="Your full name"
                value={name}
                maxLength={SOP_LIMITS.typedName}
                onChange={(e) => setName(e.target.value)}
                disabled={!canAcknowledge || acking}
                placeholder="Full name"
              />
            </div>
            <Button type="button" size="sm" onClick={() => void acknowledge()} disabled={!canAcknowledge || acking || name.trim().length < 2}>
              {acking ? 'Recording…' : 'I have read and understood this SOP'}
            </Button>
          </>
        )}
      </section>
    </article>
  );
}

// ============================================================
// Page
// ============================================================

export function SopTrainingPage() {
  const [rows, setRows] = useState<TrainingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      setRows(sortTraining(await fetchMyTraining()));
    } catch (err) {
      setError(describeSopError(err, 'Could not load your training.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => summarizeCompletion(rows), [rows]);

  return (
    <DashboardLayout activeLabel="SOP Training">
      {openId ? (
        <SopReaderView sopId={openId} onBack={() => setOpenId(null)} onChanged={() => void load(true)} />
      ) : (
        <>
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><GraduationCap size={22} /></span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">My training</h1>
              <p className="text-sm text-text-secondary">Procedures assigned to you. Read, take the quiz if there is one, then acknowledge.</p>
            </div>
          </div>

          {loading ? (
            <SkeletonCardList count={3} rows={2} />
          ) : error ? (
            <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-8 text-center">
              <AlertCircle className="text-danger" />
              <p className="text-sm text-text-primary">{error}</p>
              <Button type="button" variant="secondary" size="sm" onClick={() => void load()}><RefreshCw size={16} /> Try again</Button>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={GraduationCap} title="Nothing assigned to you" description="When your team assigns you a procedure it will show up here." />
          ) : (
            <>
              <div className="mb-5 rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="mb-1.5 flex justify-between text-sm">
                  <span className="font-medium text-text-primary">{summary.completed} of {summary.total} complete</span>
                  <span className="text-text-secondary">{summary.pct}%</span>
                </div>
                <ProgressBar pct={summary.pct} label="Your training progress" />
              </div>
              <ul className="space-y-3">
                {rows.map((r) => {
                  const due = dueState(r.due_at);
                  return (
                    <li key={r.sop_id}>
                      <button
                        type="button"
                        onClick={() => setOpenId(r.sop_id)}
                        className="focus-ring flex w-full flex-wrap items-center gap-3 rounded-2xl border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-accent/40"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-base font-semibold text-text-primary">{r.title} <span className="text-xs font-normal text-text-secondary">v{r.version}</span></p>
                          {r.summary && <p className="mt-0.5 line-clamp-2 text-sm text-text-secondary">{r.summary}</p>}
                          <p className={`mt-1 text-xs ${due === 'overdue' && r.status !== 'completed' ? 'text-danger' : 'text-text-secondary'}`}>
                            {r.status === 'completed' && r.acknowledged_at
                              ? `Acknowledged ${new Date(r.acknowledged_at).toLocaleDateString()}`
                              : formatDue(r.due_at)}
                            {r.quiz_required ? ' · includes a quiz' : ''}
                          </p>
                        </div>
                        <StatusBadge status={r.status} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </DashboardLayout>
  );
}
