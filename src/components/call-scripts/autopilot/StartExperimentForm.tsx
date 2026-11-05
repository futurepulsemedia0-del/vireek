import { useMemo, useState } from 'react';
import { FlaskConical, Loader2, Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAutopilotT } from '@/i18n/autopilotNamespace';
import type { CallScriptVersion } from '@/lib/callScripts';
import {
  PRIMARY_METRIC_IDS, feasibility, isAllowedDimension, lookThresholds, requiredSamplePerArm,
  type AutopilotSettings, type ExperimentDimension, type MetricId, type RegistrationInput,
} from '@/lib/voiceAutopilot';

interface Props {
  versions: CallScriptVersion[];
  activeVersionId: string | null;
  settings: AutopilotSettings;
  /** Current booking rate of the live version (fraction) and finished calls per day, for sizing. Null when unknown. */
  baselineRate: number | null;
  callsPerDay: number | null;
  busy: boolean;
  onStart: (challengerVersionId: string, pct: number, reg: RegistrationInput) => Promise<void>;
}

export function StartExperimentForm({ versions, activeVersionId, settings, baselineRate, callsPerDay, busy, onStart }: Props) {
  const { t } = useAutopilotT();
  const candidates = versions.filter((v) => v.id !== activeVersionId);
  const [challengerId, setChallengerId] = useState('');
  const [name, setName] = useState('');
  const [hypothesis, setHypothesis] = useState('');
  const [metric, setMetric] = useState<MetricId>('qualified_booking_rate');
  const [minPts, setMinPts] = useState(3);
  const [pct, setPct] = useState(Math.min(10, settings.max_traffic_pct));
  const [waiveLatency, setWaiveLatency] = useState(true);
  const [nOverride, setNOverride] = useState<number | null>(null);

  const chosen = candidates.find((v) => v.id === challengerId) ?? null;
  const dimension: ExperimentDimension | null = chosen && isAllowedDimension(chosen.dimension) ? chosen.dimension : null;
  const isRate = metric !== 'time_to_book_seconds' && metric !== 'customer_sentiment';
  const base = baselineRate ?? 0.3;

  const suggestedN = useMemo(() => (isRate ? requiredSamplePerArm(base, minPts / 100) : 400), [isRate, base, minPts]);
  const nMax = nOverride ?? (Number.isFinite(suggestedN) ? Math.min(100000, Math.max(120, suggestedN)) : 400);
  const perArmPerDay = callsPerDay !== null ? (callsPerDay * (pct / 100) > 0 ? Math.min(callsPerDay * (pct / 100), callsPerDay * (1 - pct / 100)) : 0) : null;
  const feas = perArmPerDay !== null && isRate ? feasibility(base, minPts / 100, perArmPerDay) : null;
  const looks = lookThresholds(nMax);
  const trafficOptions = [1, 5, 10, 20, 30, 50].filter((p) => p <= settings.max_traffic_pct);

  const canSubmit = !!chosen && !!dimension && name.trim().length >= 2 && !busy && minPts > 0;

  const submit = async () => {
    if (!chosen || !dimension) return;
    await onStart(chosen.id, pct, {
      dimension, name: name.trim(), hypothesis: hypothesis.trim(), primaryMetric: metric, nMaxPerArm: nMax, minEffect: isRate ? minPts / 100 : minPts,
      waived: waiveLatency ? ['latency_ms'] : [],
    });
  };

  return (
    <section aria-labelledby="start-exp-title" className="rounded-2xl border border-border bg-bg-secondary p-5">
      <h3 id="start-exp-title" className="text-base font-semibold text-text-primary">{t('start.title')}</h3>
      <p className="mt-1 text-sm text-text-secondary">{t('start.intro')} {t('dimensionHelp')}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="exp-challenger" className="mb-1.5 block text-sm font-medium text-text-primary">{t('start.variant')}</label>
          <select id="exp-challenger" value={challengerId} onChange={(e) => setChallengerId(e.target.value)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary" aria-describedby={chosen && !dimension ? 'exp-needtag' : undefined}>
            <option value="">{t('start.variantPlaceholder')}</option>
            {candidates.map((v) => (
              <option key={v.id} value={v.id}>
                {isAllowedDimension(v.dimension) ? t('start.variantTagged', { n: v.version_number, dimension: t(`dimension.${v.dimension}`) }) : t('start.variantUntagged', { n: v.version_number })}
              </option>
            ))}
          </select>
          {chosen && !dimension && <p id="exp-needtag" role="alert" className="mt-1 text-xs text-warning-500">{t('start.needTag')}</p>}
          {dimension === 'voice_pace' && <p className="mt-1 text-xs text-text-secondary">{t('pace.note')}</p>}
        </div>

        <div>
          <label htmlFor="exp-name" className="mb-1.5 block text-sm font-medium text-text-primary">{t('start.name')}</label>
          <input id="exp-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary" />
        </div>
        <div>
          <label htmlFor="exp-metric" className="mb-1.5 block text-sm font-medium text-text-primary">{t('start.primary')}</label>
          <select id="exp-metric" value={metric} onChange={(e) => setMetric(e.target.value as MetricId)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary" aria-describedby="exp-metric-note">
            {PRIMARY_METRIC_IDS.map((m) => (<option key={m} value={m}>{t(`metric.${m}`)}</option>))}
          </select>
          <p id="exp-metric-note" className="mt-1 text-xs text-text-secondary">{t(`metricNote.${metric}`, { defaultValue: '' })}</p>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="exp-hyp" className="mb-1.5 block text-sm font-medium text-text-primary">{t('start.hypothesis')}</label>
          <textarea id="exp-hyp" value={hypothesis} maxLength={400} rows={2} onChange={(e) => setHypothesis(e.target.value)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary" />
        </div>

        <div>
          <label htmlFor="exp-min" className="mb-1.5 block text-sm font-medium text-text-primary">{t('start.minEffect')}</label>
          <input id="exp-min" type="number" min={0.5} max={50} step={0.5} value={minPts} onChange={(e) => setMinPts(Number(e.target.value))} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary" />
        </div>
        <div>
          <label htmlFor="exp-n" className="mb-1.5 block text-sm font-medium text-text-primary">{t('start.maxN')}</label>
          <input id="exp-n" type="number" min={120} max={100000} step={10} value={nMax} onChange={(e) => setNOverride(Math.max(120, Math.round(Number(e.target.value) || 120)))} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary" aria-describedby="exp-n-hint" />
          {isRate && <p id="exp-n-hint" className="mt-1 text-xs text-text-secondary">{t('start.maxNSuggested', { n: Number.isFinite(suggestedN) ? suggestedN : '—', pts: minPts })}</p>}
        </div>

        <div className="sm:col-span-2">
          <p className="mb-1.5 text-sm font-medium text-text-primary" id="exp-traffic-label">{t('start.traffic')}</p>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="exp-traffic-label">
            {trafficOptions.map((p) => (
              <button key={p} type="button" aria-pressed={pct === p} onClick={() => setPct(p)} className={`focus-ring min-h-[44px] rounded-xl border px-4 text-sm font-medium transition-colors motion-reduce:transition-none ${pct === p ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'}`}>{p}%</button>
            ))}
          </div>
        </div>

        <div className="sm:col-span-2">
          <label className="flex min-h-[44px] items-start gap-3 text-sm text-text-primary">
            <input type="checkbox" checked={waiveLatency} onChange={(e) => setWaiveLatency(e.target.checked)} className="focus-ring mt-1 h-4 w-4" />
            <span>
              {t('start.waiveLatency')}
              <span className="block text-xs text-text-secondary">{t('start.waiveLatencyHint')} {t('metricNote.latency_ms')}</span>
            </span>
          </label>
        </div>
      </div>

      <p className="mt-4 flex items-start gap-2 text-xs text-text-secondary">
        <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{t('start.plan', { n: nMax, looks: looks.join(' / ') })}</span>
      </p>

      {feas && (
        <div role="status" className={`mt-3 rounded-xl border px-4 py-3 text-sm text-text-primary ${feas.feasible ? 'border-border bg-bg-tertiary' : 'border-warning-500/30 bg-warning-500/10'}`}>
          <p className="font-medium">{feas.feasible ? t('feasibility.ok', { days: feas.daysNeeded }) : t('feasibility.cannot')}</p>
          {!feas.feasible && <p className="mt-1 text-xs text-text-secondary">{t('feasibility.cannotBody', { pts: minPts, n: Number.isFinite(feas.nPerArm) ? feas.nPerArm : '—', max: 90 })}</p>}
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <Button type="button" onClick={submit} disabled={!canSubmit}>
          {busy ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <FlaskConical size={16} aria-hidden="true" />}
          {t('start.submit')}
        </Button>
      </div>
    </section>
  );
}
