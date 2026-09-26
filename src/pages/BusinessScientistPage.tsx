/**
 * Autonomous Business Scientist — /dashboard/business-scientist
 *
 * Research (reused from the Decision Engine) -> Hypothesis (AI-drafted)
 * -> Simulation -> Experiment -> Measurement -> Rollout, one study per
 * card. Every number past the hypothesis stage is plain arithmetic the
 * owner can inspect — see src/lib/businessScientist.ts.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Beaker, CheckCircle2, ChevronDown, FlaskConical, Loader2, Play, RefreshCcw, Trash2, XCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  abandonStudy,
  advancePendingHypotheses,
  BusinessScientistStudy,
  confirmRollout,
  deleteStudy,
  fetchSettings,
  fetchStudies,
  formatDollars,
  runResearchCycle,
  ScientistSettings,
  STAGE_COLORS,
  STAGE_LABELS,
  startExperiment,
  submitMeasurement,
} from '@/lib/businessScientist';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

function MeasurementForm({ study, onDone }: { study: BusinessScientistStudy; onDone: () => void }) {
  const { toast } = useToast();
  const [controlValue, setControlValue] = useState('');
  const [controlN, setControlN] = useState('');
  const [treatmentValue, setTreatmentValue] = useState('');
  const [treatmentN, setTreatmentN] = useState('');
  const [saving, setSaving] = useState(false);

  const valid = [controlValue, controlN, treatmentValue, treatmentN].every((v) => v.trim() !== '' && !Number.isNaN(Number(v)));

  const handleSubmit = async () => {
    if (!valid) return toast('Fill in all four numbers', 'error');
    setSaving(true);
    try {
      await submitMeasurement(study, {
        controlValue: Number(controlValue),
        controlN: Number(controlN),
        treatmentValue: Number(treatmentValue),
        treatmentN: Number(treatmentN),
      });
      toast('Result scored', 'success');
      onDone();
    } catch {
      toast('Could not save the measurement', 'error');
    }
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <p className="mb-2 text-xs font-medium text-text-primary">Enter what actually happened</p>
      <div className="grid grid-cols-2 gap-2">
        <input value={controlValue} onChange={(e) => setControlValue(e.target.value)} placeholder={`Control: ${study.predicted_metric ?? 'value'}`} className={inputClass} />
        <input value={controlN} onChange={(e) => setControlN(e.target.value)} placeholder="Control sample size" className={inputClass} />
        <input value={treatmentValue} onChange={(e) => setTreatmentValue(e.target.value)} placeholder={`Treatment: ${study.predicted_metric ?? 'value'}`} className={inputClass} />
        <input value={treatmentN} onChange={(e) => setTreatmentN(e.target.value)} placeholder="Treatment sample size" className={inputClass} />
      </div>
      <p className="mt-1.5 text-[11px] text-text-secondary">
        If both values are rates (0-100), this runs a two-proportion significance test. Otherwise it checks sample size + effect size.
      </p>
      <button
        type="button"
        disabled={!valid || saving}
        onClick={() => void handleSubmit()}
        className="focus-ring mt-2 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Score result
      </button>
    </div>
  );
}

function StudyCard({ study, settings, onChanged }: { study: BusinessScientistStudy; settings: ScientistSettings; onChanged: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [rolloutNote, setRolloutNote] = useState('');
  const [busy, setBusy] = useState(false);

  const durationDays = study.experiment_design?.duration_days ?? settings.default_experiment_days;

  const handleStart = async () => {
    setBusy(true);
    try {
      await startExperiment(study.id, durationDays);
      toast('Experiment started', 'success');
      onChanged();
    } catch {
      toast('Could not start the experiment', 'error');
    }
    setBusy(false);
  };

  const handleAbandon = async () => {
    setBusy(true);
    try {
      await abandonStudy(study.id, 'Abandoned by owner before completion.');
      toast('Study abandoned', 'success');
      onChanged();
    } catch {
      toast('Could not abandon the study', 'error');
    }
    setBusy(false);
  };

  const handleRollout = async () => {
    setBusy(true);
    try {
      await confirmRollout(study.id, rolloutNote || study.proposed_intervention || 'Rolled out');
      toast('Marked as rolled out', 'success');
      onChanged();
    } catch {
      toast('Could not confirm rollout', 'error');
    }
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="flex w-full items-center justify-between gap-3 text-left">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STAGE_COLORS[study.stage]}`}>{STAGE_LABELS[study.stage]}</span>
            {study.confidence_score !== null && <span className="text-[10px] text-text-secondary">{study.confidence_score}% confidence</span>}
          </div>
          <p className="truncate text-sm font-semibold text-text-primary">{study.problem_title}</p>
          {study.hypothesis && <p className="mt-0.5 truncate text-xs text-text-secondary">{study.hypothesis}</p>}
        </div>
        <ChevronDown size={16} className={`shrink-0 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3 text-xs">
          {study.hypothesis && (
            <div>
              <p className="font-medium text-text-primary">Hypothesis</p>
              <p className="text-text-secondary">{study.hypothesis}</p>
            </div>
          )}
          {study.proposed_intervention && (
            <div>
              <p className="font-medium text-text-primary">Proposed intervention</p>
              <p className="text-text-secondary">{study.proposed_intervention}</p>
            </div>
          )}
          {study.simulation && (
            <div className="rounded-lg bg-bg-primary p-2.5">
              <p className="font-medium text-text-primary">Simulated impact</p>
              <p className="text-text-secondary">
                {study.simulation.magnitude_low_pct}%–{study.simulation.magnitude_high_pct}% on {study.predicted_metric}
                {study.simulation.dollars_expected !== null && ` (≈ ${formatDollars(study.simulation.dollars_low)} to ${formatDollars(study.simulation.dollars_high)})`}
              </p>
              <p className="mt-0.5 text-[10px] text-text-secondary/70">{study.simulation.method}</p>
            </div>
          )}

          {study.stage === 'experimenting' && study.experiment_status === 'not_started' && study.experiment_design && (
            <div className="rounded-lg bg-bg-primary p-2.5">
              <p className="font-medium text-text-primary">Experiment design</p>
              <p className="text-text-secondary">Control: {study.experiment_design.control_desc}</p>
              <p className="text-text-secondary">Treatment: {study.experiment_design.treatment_desc}</p>
              <p className="text-text-secondary">Success metric: {study.experiment_design.success_metric} · {durationDays} days</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStart()}
                className="focus-ring mt-2 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Start experiment
              </button>
            </div>
          )}

          {study.stage === 'experimenting' && study.experiment_status === 'running' && (
            <>
              <p className="text-text-secondary">
                Running since {new Date(study.experiment_started_at ?? '').toLocaleDateString()}, ends {new Date(study.experiment_ends_at ?? '').toLocaleDateString()}.
              </p>
              <MeasurementForm study={study} onDone={onChanged} />
            </>
          )}

          {study.stage === 'experimenting' && (
            <button type="button" disabled={busy} onClick={() => void handleAbandon()} className="focus-ring text-text-secondary hover:text-danger">
              Abandon this study
            </button>
          )}

          {study.measured_result && (
            <div className="rounded-lg bg-bg-primary p-2.5">
              <p className="font-medium text-text-primary">Measured result</p>
              <p className="text-text-secondary">
                Control {study.measured_result.control_value} (n={study.measured_result.control_n}) vs treatment {study.measured_result.treatment_value} (n={study.measured_result.treatment_n}) · {study.measured_result.lift_pct}% lift
                {study.measured_result.significant ? ' · significant' : ' · not yet significant'}
              </p>
            </div>
          )}

          {study.decision_reasoning && (
            <p className="rounded-lg bg-bg-primary p-2.5 text-text-secondary">{study.decision_reasoning}</p>
          )}

          {study.stage === 'decided' && study.decision === 'rollout' && (
            <div className="rounded-xl border border-border bg-bg-primary p-3">
              <input value={rolloutNote} onChange={(e) => setRolloutNote(e.target.value)} placeholder="What was rolled out (optional note)" className={`${inputClass} mb-2`} />
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleRollout()}
                className="focus-ring flex items-center gap-1.5 rounded-lg bg-success-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              >
                <CheckCircle2 size={13} /> Confirm rollout
              </button>
            </div>
          )}

          {study.stage === 'rolled_out' && (
            <p className="flex items-center gap-1.5 text-success-500"><CheckCircle2 size={13} /> Rolled out: {study.rollout_action}</p>
          )}
          {study.stage === 'abandoned' && (
            <p className="flex items-center gap-1.5 text-danger"><XCircle size={13} /> Abandoned</p>
          )}

          <button type="button" onClick={() => setPendingDelete(true)} className="focus-ring flex items-center gap-1 text-text-secondary hover:text-danger">
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete}
        title="Delete this study?"
        description={`"${study.problem_title}" will be removed.`}
        confirmLabel="Yes, delete it"
        onConfirm={() => void deleteStudy(study.id).then(() => { setPendingDelete(false); onChanged(); })}
        onCancel={() => setPendingDelete(false)}
      />
    </div>
  );
}

export function BusinessScientistPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [studies, setStudies] = useState<BusinessScientistStudy[]>([]);
  const [settings, setSettings] = useState<ScientistSettings>({ min_confidence_threshold: 70, min_effect_pct: 3, default_experiment_days: 14 });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (user) {
        const studySettings = await fetchSettings(user.id);
        setSettings(studySettings);
        const fetched = await fetchStudies();
        await advancePendingHypotheses(fetched, studySettings);
        setStudies(fetched.some((s) => s.stage === 'hypothesis' && !s.simulation) ? await fetchStudies() : fetched);
      }
    } catch {
      /* empty state covers it */
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const handleRunCycle = async () => {
    setRunning(true);
    try {
      const result = await runResearchCycle();
      toast(result.studies_created > 0 ? `${result.studies_created} new stud${result.studies_created === 1 ? 'y' : 'ies'} started` : 'No new studies — nothing unactioned met the bar', 'success');
      await load();
    } catch {
      toast('Could not run the research cycle', 'error');
    }
    setRunning(false);
  };

  return (
    <DashboardLayout activeLabel="Business Scientist">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <FlaskConical size={18} /> Autonomous Business Scientist
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Research → hypothesis → simulation → experiment → measurement → rollout. Every unactioned decision becomes a testable claim before it becomes a company-wide change.
            </p>
          </div>
          <button
            type="button"
            disabled={running}
            onClick={() => void handleRunCycle()}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
          >
            {running ? <Loader2 size={13} className="animate-spin" /> : <RefreshCcw size={13} />} Run research cycle
          </button>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : studies.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center">
            <Beaker className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              No studies yet. Run a research cycle to turn your unactioned Decision Engine recommendations into testable hypotheses.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {studies.map((s) => (
              <motion.div key={s.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <StudyCard study={s} settings={settings} onChanged={() => void load()} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
