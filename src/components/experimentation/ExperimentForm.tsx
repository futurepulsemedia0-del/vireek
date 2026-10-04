import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import {
  CATEGORY_LABELS,
  EXPERIMENT_TEMPLATES,
  METRICS,
  METRIC_KEYS,
  historicalBaseline,
  jobsPerDay,
  requiredPerArm,
  fromDisplay,
  validateDraft,
  type Alpha,
  type DesignKind,
  type ExpJob,
  type ExperimentCategory,
  type ExperimentTemplate,
  type MetricKey,
} from '@/lib/opsExperiments';
import type { NewExperiment } from '@/lib/opsExperimentsApi';

export interface TechnicianOption {
  id: string;
  member_name: string | null;
  member_email: string;
}

interface Props {
  jobs: ExpJob[];
  technicians: TechnicianOption[];
  onSubmit: (input: NewExperiment) => Promise<void>;
  onCancel: () => void;
}

type Group = 'none' | 'treatment' | 'control';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

const unitSuffix = (m: MetricKey) => (METRICS[m].unit === 'pct' ? 'percentage points' : 'dollars');
const needsMaturity = (m: MetricKey | '') => m === 'ftf_rate' || m === 'callback_rate';

function SelectField({ label, helper, children, ...rest }: { label: string; helper?: string } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-text-primary">{label}</span>
      <select {...rest} className={selectClass}>
        {children}
      </select>
      {helper && <span className="mt-1.5 block text-xs text-text-secondary">{helper}</span>}
    </label>
  );
}

export function ExperimentForm({ jobs, technicians, onSubmit, onCancel }: Props) {
  const now = useMemo(() => new Date(), []);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<ExperimentCategory>('operations');
  const [hypothesis, setHypothesis] = useState('');
  const [intervention, setIntervention] = useState('');
  const [comparisonDesc, setComparisonDesc] = useState('');
  const [design, setDesign] = useState<DesignKind>('randomized');
  const [primary, setPrimary] = useState<MetricKey>('ftf_rate');
  const [mde, setMde] = useState('5');
  const [guardrail, setGuardrail] = useState<MetricKey | ''>('');
  const [tolerance, setTolerance] = useState('2');
  const [duration, setDuration] = useState('28');
  const [share, setShare] = useState('50');
  const [maturity, setMaturity] = useState('14');
  const [alpha, setAlpha] = useState<Alpha>(0.05);
  const [serviceTypes, setServiceTypes] = useState<string[]>([]);
  const [groups, setGroups] = useState<Record<string, Group>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const serviceOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const j of jobs) {
      const s = (j.service_type ?? '').trim();
      if (s && !set.has(s.toLowerCase())) set.set(s.toLowerCase(), s);
    }
    return [...set.values()].sort((a, b) => a.localeCompare(b));
  }, [jobs]);

  const treatmentIds = useMemo(() => technicians.filter((t) => groups[t.id] === 'treatment').map((t) => t.id), [technicians, groups]);
  const controlIds = useMemo(() => technicians.filter((t) => groups[t.id] === 'control').map((t) => t.id), [technicians, groups]);

  const mdeNum = Number(mde);
  const durationNum = Math.round(Number(duration));
  const shareNum = Math.round(Number(share));
  const maturityNum = needsMaturity(primary) || needsMaturity(guardrail) ? Math.round(Number(maturity)) : 14;

  const planner = useMemo(() => {
    if (!(mdeNum > 0) || !(durationNum > 0)) return null;
    const baseline = historicalBaseline(primary, jobs, serviceTypes, Number.isFinite(maturityNum) ? maturityNum : 14, now);
    const required = requiredPerArm(primary, design, baseline, fromDisplay(primary, mdeNum), alpha);
    let expected: number;
    if (design === 'randomized') {
      const fraction = Number.isFinite(shareNum) ? Math.min(shareNum, 100 - shareNum) / 100 : 0.5;
      expected = Math.floor(jobsPerDay(jobs, serviceTypes, now) * durationNum * fraction);
    } else {
      const t = jobsPerDay(jobs, serviceTypes, now, treatmentIds);
      const c = jobsPerDay(jobs, serviceTypes, now, controlIds);
      expected = Math.floor(Math.min(t, c) * durationNum);
    }
    return { baseline, required, expected };
  }, [mdeNum, durationNum, primary, jobs, serviceTypes, maturityNum, design, alpha, shareNum, treatmentIds, controlIds, now]);

  function applyTemplate(t: ExperimentTemplate) {
    setTitle(t.label);
    setCategory(t.category);
    setHypothesis(t.hypothesis);
    setIntervention(t.intervention);
    setComparisonDesc(t.comparison_desc);
    setDesign(t.design);
    setPrimary(t.primary_metric);
    setMde(String(t.min_detectable_effect));
    setGuardrail(t.guardrail_metric ?? '');
    setTolerance(String(t.guardrail_tolerance ?? 2));
    setDuration(String(t.duration_days));
    setErrors([]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const draft = {
      title,
      hypothesis,
      intervention,
      comparison_desc: comparisonDesc,
      design,
      primary_metric: primary,
      guardrail_metric: guardrail || null,
      guardrail_tolerance: guardrail ? Number(tolerance) : null,
      min_detectable_effect: mdeNum,
      duration_days: durationNum,
      treatment_share: design === 'randomized' ? shareNum : 50,
      maturity_days: maturityNum,
      treatmentTechnicians: treatmentIds,
      comparisonTechnicians: controlIds,
    };
    const problems = validateDraft(draft);
    if (!Number.isFinite(durationNum) || durationNum < 7 || durationNum > 180) problems.push('Duration must be between 7 and 180 days.');
    if (design === 'randomized' && (!Number.isFinite(shareNum) || shareNum < 10 || shareNum > 90)) problems.push('The intervention share must be between 10% and 90%.');
    if (!Number.isFinite(maturityNum) || maturityNum < 0 || maturityNum > 60) problems.push('The callback window must be between 0 and 60 days.');
    setErrors(problems);
    if (problems.length > 0) return;
    setSubmitting(true);
    try {
      await onSubmit({ ...draft, category, service_types: serviceTypes, alpha });
    } finally {
      setSubmitting(false);
    }
  }

  const feasible = planner && planner.required !== null ? planner.expected >= planner.required : null;

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-6" noValidate>
      <Card className="!p-5">
        <p className="text-xs font-semibold uppercase text-text-secondary">Start from a proven pattern</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {EXPERIMENT_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTemplate(t)}
              className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary hover:border-accent/40"
            >
              {t.label}
            </button>
          ))}
        </div>
      </Card>

      <Card className="!p-5">
        <h2 className="text-base font-semibold text-text-primary">1. Hypothesis and intervention</h2>
        <div className="mt-4 space-y-4">
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} required />
          <SelectField label="Area" value={category} onChange={(e) => setCategory(e.target.value as ExperimentCategory)}>
            {(Object.keys(CATEGORY_LABELS) as ExperimentCategory[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </SelectField>
          <Textarea
            label="Hypothesis"
            rows={2}
            maxLength={1000}
            value={hypothesis}
            onChange={(e) => setHypothesis(e.target.value)}
            helperText="Example: verifying parts before dispatch reduces callbacks."
            required
          />
          <Textarea label="Intervention (what changes for the treatment group)" rows={2} maxLength={1000} value={intervention} onChange={(e) => setIntervention(e.target.value)} required />
          <Textarea label="Comparison (what the control group gets)" rows={2} maxLength={1000} value={comparisonDesc} onChange={(e) => setComparisonDesc(e.target.value)} />
        </div>
      </Card>

      <Card className="!p-5">
        <h2 className="text-base font-semibold text-text-primary">2. Design</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Comparison method"
            value={design}
            onChange={(e) => setDesign(e.target.value as DesignKind)}
            helper={
              design === 'randomized'
                ? 'Jobs are randomly split by the system. The strongest evidence.'
                : 'Compare two technician groups before and after. Use when jobs cannot be split.'
            }
          >
            <option value="randomized">Randomized jobs</option>
            <option value="comparison">Technician groups (before / after)</option>
          </SelectField>
          <SelectField label="Service types in scope" value="" onChange={(e) => e.target.value && setServiceTypes((s) => (s.includes(e.target.value) ? s : [...s, e.target.value]))} helper="Leave empty to include every service type.">
            <option value="">Add a service type...</option>
            {serviceOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </SelectField>
        </div>
        {serviceTypes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {serviceTypes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setServiceTypes((list) => list.filter((x) => x !== s))}
                className="focus-ring rounded-full bg-accent/10 px-3 py-1 text-xs text-accent"
                aria-label={`Remove ${s}`}
              >
                {s} x
              </button>
            ))}
          </div>
        )}

        {design === 'comparison' && (
          <div className="mt-4">
            <p className="text-sm font-medium text-text-primary">Technician groups</p>
            {technicians.length < 2 ? (
              <p className="mt-2 text-sm text-text-secondary">At least two active technicians are needed for this method.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {technicians.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 rounded-xl bg-bg-primary px-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-text-primary">{t.member_name || t.member_email}</span>
                    <select
                      aria-label={`Group for ${t.member_name || t.member_email}`}
                      value={groups[t.id] ?? 'none'}
                      onChange={(e) => setGroups((g) => ({ ...g, [t.id]: e.target.value as Group }))}
                      className="focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-sm"
                    >
                      <option value="none">Not included</option>
                      <option value="treatment">Intervention group</option>
                      <option value="control">Comparison group</option>
                    </select>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card className="!p-5">
        <h2 className="text-base font-semibold text-text-primary">3. Outcome and guardrail</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <SelectField label="Primary outcome" value={primary} onChange={(e) => setPrimary(e.target.value as MetricKey)} helper={METRICS[primary].description}>
            {METRIC_KEYS.map((k) => (
              <option key={k} value={k}>
                {METRICS[k].label}
              </option>
            ))}
          </SelectField>
          <Input
            label={`Smallest effect worth detecting (${unitSuffix(primary)})`}
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={mde}
            onChange={(e) => setMde(e.target.value)}
            required
          />
          <SelectField label="Guardrail (must not get worse)" value={guardrail} onChange={(e) => setGuardrail(e.target.value as MetricKey | '')}>
            <option value="">None</option>
            {METRIC_KEYS.filter((k) => k !== primary).map((k) => (
              <option key={k} value={k}>
                {METRICS[k].label}
              </option>
            ))}
          </SelectField>
          {guardrail && (
            <Input
              label={`Guardrail may worsen by at most (${unitSuffix(guardrail)})`}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={tolerance}
              onChange={(e) => setTolerance(e.target.value)}
            />
          )}
          <Input label="Run for (days)" type="number" inputMode="numeric" min="7" max="180" value={duration} onChange={(e) => setDuration(e.target.value)} />
          {design === 'randomized' && (
            <Input label="Jobs getting the intervention (%)" type="number" inputMode="numeric" min="10" max="90" value={share} onChange={(e) => setShare(e.target.value)} />
          )}
          {(needsMaturity(primary) || needsMaturity(guardrail)) && (
            <Input
              label="Callback window (days)"
              type="number"
              inputMode="numeric"
              min="0"
              max="60"
              value={maturity}
              onChange={(e) => setMaturity(e.target.value)}
              helperText="Jobs only count once this many days have passed since completion."
            />
          )}
          <SelectField label="Confidence level" value={String(alpha)} onChange={(e) => setAlpha(Number(e.target.value) as Alpha)}>
            <option value="0.1">90%</option>
            <option value="0.05">95%</option>
            <option value="0.01">99%</option>
          </SelectField>
        </div>

        {planner && (
          <div
            className={`mt-5 flex gap-3 rounded-xl p-4 text-sm ${
              feasible === null ? 'bg-bg-tertiary text-text-secondary' : feasible ? 'bg-success-500/10 text-success-500' : 'bg-warning-500/10 text-warning-500'
            }`}
            role="status"
          >
            {feasible === null ? <Info size={18} className="mt-0.5 shrink-0" /> : feasible ? <CheckCircle2 size={18} className="mt-0.5 shrink-0" /> : <AlertTriangle size={18} className="mt-0.5 shrink-0" />}
            <div className="text-text-primary">
              {planner.required === null ? (
                <p>There is not enough recent history to size this test. You can still run it; the system will show how much evidence is collected.</p>
              ) : (
                <p>
                  Needs about <strong>{planner.required.toLocaleString('en-US')}</strong> jobs per group. At your recent volume you would get about{' '}
                  <strong>{planner.expected.toLocaleString('en-US')}</strong> in {durationNum || 0} days.
                  {feasible === false && ' Run it longer, include more service types, or accept a larger minimum effect.'}
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      {errors.length > 0 && (
        <div role="alert" className="rounded-xl bg-danger/10 p-4 text-sm text-danger">
          <ul className="list-inside list-disc space-y-1">
            {errors.map((er) => (
              <li key={er}>{er}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 size={16} className="animate-spin" />}
          Save as draft
        </Button>
      </div>
    </form>
  );
}
