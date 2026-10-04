import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, Loader2, Play, Trash2, UserPlus } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { ResultPanel } from '@/components/experimentation/ResultPanel';
import type { ExperimentRow } from '@/lib/opsExperimentsApi';
import {
  CATEGORY_LABELS,
  METRICS,
  analyzeExperiment,
  buildSnapshot,
  enrollmentCandidates,
  formatEffect,
  fromDisplay,
  historicalBaseline,
  runProgress,
  type Assignment,
  type Decision,
  type ExpJob,
  type ResultSnapshot,
} from '@/lib/opsExperiments';

const STEPS = ['Hypothesis', 'Intervention', 'Comparison', 'Outcome', 'Causal estimate', 'Learning'] as const;

function stepIndex(status: ExperimentRow['status']): number {
  if (status === 'draft') return 2;
  if (status === 'running') return 4;
  return 5;
}

const DECISION_LABELS: Record<Decision, string> = {
  adopt: 'Adopt it permanently',
  iterate: 'Redesign and test again',
  reject: 'Stop - keep the current approach',
};

interface Props {
  experiment: ExperimentRow;
  jobs: ExpJob[];
  assignments: Assignment[];
  canManage: boolean;
  busy: string | null;
  onStart: () => void;
  onEnroll: (jobIds: string[]) => void;
  onConclude: (decision: Decision, learning: string, snapshot: ResultSnapshot) => void;
  onArchive: () => void;
  onDeleteDraft: () => void;
}

export function ExperimentDetail({ experiment: e, jobs, assignments, canManage, busy, onStart, onEnroll, onConclude, onArchive, onDeleteDraft }: Props) {
  const [decision, setDecision] = useState<Decision | ''>('');
  const [learning, setLearning] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const analysis = useMemo(() => {
    if (e.status !== 'running') return null;
    const at = new Date();
    const baseline = historicalBaseline(e.primary_metric, jobs, e.service_types, e.maturity_days, at);
    return analyzeExperiment(e, jobs, assignments, baseline, at);
  }, [e, jobs, assignments]);

  const enrolledJobIds = useMemo(() => new Set(assignments.filter((a) => a.unit_type === 'job').map((a) => a.unit_id)), [assignments]);
  const candidates = useMemo(() => enrollmentCandidates(e, jobs, enrolledJobIds), [e, jobs, enrolledJobIds]);
  const treatmentJobs = useMemo(() => {
    const ids = new Set(assignments.filter((a) => a.unit_type === 'job' && a.arm === 'treatment').map((a) => a.unit_id));
    return jobs.filter((j) => ids.has(j.id) && j.job_status === 'scheduled').slice(0, 8);
  }, [assignments, jobs]);

  const progress = runProgress(e, new Date());
  const metric = METRICS[e.primary_metric];
  const armCounts = {
    treatment: assignments.filter((a) => a.arm === 'treatment').length,
    control: assignments.filter((a) => a.arm === 'control').length,
  };
  const unitLabel = e.design === 'randomized' ? 'jobs' : 'technicians';
  const current = stepIndex(e.status);
  const suggested: Decision | '' = analysis
    ? analysis.recommendation === 'adopt' || analysis.recommendation === 'adopt_monitor'
      ? 'adopt'
      : analysis.recommendation === 'reject'
        ? 'reject'
        : analysis.recommendation === 'iterate'
          ? 'iterate'
          : ''
    : '';

  function conclude() {
    if (!analysis) return;
    const chosen = decision || suggested;
    if (!chosen) {
      setFormError('Choose a decision.');
      return;
    }
    if (learning.trim().length < 10) {
      setFormError('Write what you learned in at least one full sentence.');
      return;
    }
    setFormError(null);
    onConclude(chosen, learning, buildSnapshot(e, analysis));
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-bold text-text-primary">{e.title}</h2>
          <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-secondary">{CATEGORY_LABELS[e.category]}</span>
          <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs capitalize text-accent">{e.status}</span>
        </div>
        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Experiment stages">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === current ? 'step' : undefined} className={i < current ? 'text-success-500' : i === current ? 'font-semibold text-accent' : 'text-text-secondary'}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>
      </div>

      <Card className="!p-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-xs font-semibold uppercase text-text-secondary">Hypothesis</dt>
            <dd className="mt-1 text-text-primary">{e.hypothesis}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase text-text-secondary">Intervention</dt>
            <dd className="mt-1 text-text-primary">{e.intervention}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase text-text-secondary">Comparison</dt>
            <dd className="mt-1 text-text-primary">{e.comparison_desc || 'Business as usual'}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase text-text-secondary">Primary outcome</dt>
            <dd className="mt-1 text-text-primary">
              {metric.label}, smallest effect worth detecting {formatEffect(e.primary_metric, fromDisplay(e.primary_metric, e.min_detectable_effect))}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase text-text-secondary">Guardrail</dt>
            <dd className="mt-1 text-text-primary">
              {e.guardrail_metric && e.guardrail_tolerance !== null
                ? `${METRICS[e.guardrail_metric].label}, may worsen by at most ${formatEffect(e.guardrail_metric, fromDisplay(e.guardrail_metric, e.guardrail_tolerance))}`
                : 'None'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase text-text-secondary">Method</dt>
            <dd className="mt-1 text-text-primary">
              {e.design === 'randomized' ? `Randomized jobs (${e.treatment_share}% get the intervention)` : 'Technician groups, before and after (difference-in-differences)'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase text-text-secondary">Run time</dt>
            <dd className="mt-1 text-text-primary">
              {e.status === 'draft' ? `${e.duration_days} days planned` : `Day ${progress.elapsedDays} of ${e.duration_days}`}
              {e.service_types.length > 0 ? `, ${e.service_types.join(', ')}` : ''}
            </dd>
          </div>
        </dl>
      </Card>

      {e.status === 'draft' && canManage && (
        <Card className="!p-5">
          <p className="text-sm text-text-secondary">
            Starting locks the design: the outcome, effect size, groups and duration can no longer be changed, so the result cannot be bent after the fact.
            {e.design === 'comparison' && ` Groups: ${armCounts.treatment} intervention and ${armCounts.control} comparison technicians.`}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button type="button" disabled={busy !== null} onClick={onStart}>
              {busy === 'start' ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              Start experiment
            </Button>
            <Button type="button" variant="ghost" disabled={busy !== null} onClick={onDeleteDraft}>
              <Trash2 size={16} />
              Delete draft
            </Button>
          </div>
        </Card>
      )}

      {e.status === 'running' && (
        <>
          {e.design === 'randomized' && canManage && (
            <Card className="!p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">Enrollment</p>
                  <p className="mt-1 text-sm text-text-secondary">
                    {armCounts.treatment} {unitLabel} get the intervention, {armCounts.control} are the comparison. The system chooses randomly; nobody can pick.
                  </p>
                </div>
                <Button type="button" size="sm" disabled={busy !== null || candidates.length === 0} onClick={() => onEnroll(candidates.map((j) => j.id))}>
                  {busy === 'enroll' ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                  {candidates.length === 0 ? 'No new jobs to enroll' : `Enroll ${candidates.length} new job${candidates.length === 1 ? '' : 's'}`}
                </Button>
              </div>
              {treatmentJobs.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase text-text-secondary">Upcoming jobs that need the intervention</p>
                  <ul className="mt-2 space-y-1">
                    {treatmentJobs.map((j) => (
                      <li key={j.id} className="flex items-center justify-between rounded-lg bg-bg-primary px-3 py-1.5 text-sm text-text-primary">
                        <span className="truncate">{j.service_type || 'Job'}</span>
                        <span className="text-xs text-text-secondary">{j.scheduled_datetime ? new Date(j.scheduled_datetime).toLocaleDateString('en-US') : 'Unscheduled'}</span>
                      </li>
                    ))}
                  </ul>
                  <Link to="/dashboard/jobs" className="focus-ring mt-2 inline-block text-sm text-accent hover:underline">
                    Open jobs board
                  </Link>
                </div>
              )}
            </Card>
          )}

          {analysis && <ResultPanel snapshot={buildSnapshot(e, analysis)} alpha={e.alpha} analysis={analysis} />}

          {canManage && analysis && (
            <Card className="!p-5">
              <p className="text-sm font-semibold text-text-primary">Conclude and record the learning</p>
              {analysis.verdict === 'collecting' && <p className="mt-1 text-sm text-warning-500">Evidence is still being collected. Concluding now is recorded as an early decision.</p>}
              <fieldset className="mt-3 space-y-2">
                <legend className="sr-only">Decision</legend>
                {(Object.keys(DECISION_LABELS) as Decision[]).map((d) => (
                  <label key={d} className="flex items-center gap-2 text-sm text-text-primary">
                    <input type="radio" name="decision" value={d} checked={(decision || suggested) === d} onChange={() => setDecision(d)} />
                    {DECISION_LABELS[d]}
                  </label>
                ))}
              </fieldset>
              <div className="mt-3">
                <Textarea label="What did we learn?" rows={3} maxLength={2000} value={learning} onChange={(ev) => setLearning(ev.target.value)} helperText="This is saved to the learning library for the whole team." />
              </div>
              {formError && (
                <p role="alert" className="mt-2 text-sm text-danger">
                  {formError}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-3">
                <Button type="button" disabled={busy !== null} onClick={conclude}>
                  {busy === 'conclude' && <Loader2 size={16} className="animate-spin" />}
                  Conclude experiment
                </Button>
                <Button type="button" variant="ghost" disabled={busy !== null} onClick={onArchive}>
                  <Archive size={16} />
                  Archive without a result
                </Button>
              </div>
            </Card>
          )}
        </>
      )}

      {(e.status === 'concluded' || e.status === 'archived') && e.result_snapshot && (
        <>
          <ResultPanel snapshot={e.result_snapshot} alpha={e.alpha} />
          {e.decision && e.learning && (
            <Card className="!p-5">
              <p className="text-xs font-semibold uppercase text-text-secondary">Decision: {DECISION_LABELS[e.decision]}</p>
              <p className="mt-2 whitespace-pre-line text-sm text-text-primary">{e.learning}</p>
            </Card>
          )}
          {e.status === 'concluded' && canManage && (
            <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={onArchive}>
              <Archive size={14} />
              Archive
            </Button>
          )}
        </>
      )}
    </div>
  );
}
