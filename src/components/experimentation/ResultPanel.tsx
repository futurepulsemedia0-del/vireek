import { AlertTriangle, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import {
  EVIDENCE_LABELS,
  METRICS,
  RECOMMENDATION_LABELS,
  VERDICT_LABELS,
  formatEffect,
  formatMetricValue,
  formatP,
  type Alpha,
  type Analysis,
  type GuardrailStatus,
  type ResultSnapshot,
  type Verdict,
} from '@/lib/opsExperiments';

const VERDICT_STYLE: Record<Verdict, string> = {
  collecting: 'bg-accent/10 text-accent',
  win: 'bg-success-500/10 text-success-500',
  loss: 'bg-danger/10 text-danger',
  no_effect: 'bg-bg-tertiary text-text-secondary',
  inconclusive: 'bg-warning-500/10 text-warning-500',
  invalid: 'bg-danger/10 text-danger',
};

const GUARDRAIL_META: Record<GuardrailStatus, { label: string; style: string; Icon: typeof ShieldCheck }> = {
  ok: { label: 'Within tolerance', style: 'text-success-500', Icon: ShieldCheck },
  watch: { label: 'Cannot rule out harm yet', style: 'text-warning-500', Icon: ShieldQuestion },
  breached: { label: 'Breached', style: 'text-danger', Icon: ShieldAlert },
  unknown: { label: 'Not enough data yet', style: 'text-text-secondary', Icon: ShieldQuestion },
};

interface Props {
  snapshot: ResultSnapshot;
  alpha: Alpha;
  /** Present for live (running) experiments; concluded experiments show the frozen snapshot only. */
  analysis?: Analysis | null;
}

export function ResultPanel({ snapshot, alpha, analysis }: Props) {
  const metric = METRICS[snapshot.metric];
  const effect = snapshot.effect;
  const favourable = effect !== null && (metric.higherIsBetter ? effect > 0 : effect < 0);
  const interim = analysis ? analysis.informationFraction < 1 : false;
  const confidence = Math.round((1 - alpha) * 100);
  const progress = analysis?.plannedPerArm ? Math.round(Math.min(1, analysis.observedPerArm / analysis.plannedPerArm) * 100) : null;
  const guardrail = analysis?.guardrail ?? null;
  const est = analysis?.primary.estimate ?? null;

  return (
    <Card className="!p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${VERDICT_STYLE[snapshot.verdict]}`}>{VERDICT_LABELS[snapshot.verdict]}</span>
        <span className="rounded-full bg-bg-tertiary px-3 py-1 text-xs text-text-secondary">Evidence {EVIDENCE_LABELS[snapshot.evidence]}</span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs text-text-secondary">Causal effect on {metric.label.toLowerCase()}</p>
          <p className={`mt-1 text-3xl font-bold tabular-nums ${effect === null ? 'text-text-secondary' : favourable ? 'text-success-500' : effect === 0 ? 'text-text-primary' : 'text-danger'}`}>
            {effect === null ? '-' : formatEffect(snapshot.metric, effect)}
          </p>
          {snapshot.relativePct !== null && <p className="text-xs text-text-secondary">{snapshot.relativePct > 0 ? '+' : ''}{snapshot.relativePct.toFixed(1)}% versus the counterfactual</p>}
        </div>
        <div>
          <p className="text-xs text-text-secondary">{interim ? `${confidence}% interval (widened for early look)` : `${confidence}% interval`}</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-text-primary">
            {snapshot.ciLow === null || snapshot.ciHigh === null ? '-' : `${formatEffect(snapshot.metric, snapshot.ciLow)} to ${formatEffect(snapshot.metric, snapshot.ciHigh)}`}
          </p>
          <p className="text-xs text-text-secondary">p-value {snapshot.p === null ? '-' : formatP(snapshot.p)}</p>
        </div>
        <div>
          <p className="text-xs text-text-secondary">Observations</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-text-primary">
            {snapshot.nTreatment.toLocaleString('en-US')} intervention / {snapshot.nControl.toLocaleString('en-US')} comparison
          </p>
          {est && (
            <p className="text-xs text-text-secondary">
              {formatMetricValue(snapshot.metric, est.treatmentMean)} vs {formatMetricValue(snapshot.metric, est.counterfactual)} expected without it
            </p>
          )}
        </div>
      </div>

      {progress !== null && (
        <div className="mt-4">
          <div className="flex justify-between text-xs text-text-secondary">
            <span>Evidence collected</span>
            <span>
              {analysis?.observedPerArm.toLocaleString('en-US')} of {analysis?.plannedPerArm?.toLocaleString('en-US')} needed per group
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Evidence collected">
            <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
          </div>
          {interim && <p className="mt-2 text-xs text-text-secondary">Early results need stronger evidence to count, so a promising number can still read as "collecting".</p>}
        </div>
      )}

      {(guardrail || snapshot.guardrailMetric) && (
        <div className="mt-4 rounded-xl bg-bg-primary p-3 text-sm">
          {(() => {
            const status = (guardrail?.status ?? snapshot.guardrailStatus ?? 'unknown') as GuardrailStatus;
            const gm = guardrail?.metric ?? snapshot.guardrailMetric;
            const meta = GUARDRAIL_META[status];
            return (
              <p className={`flex flex-wrap items-center gap-2 ${meta.style}`}>
                <meta.Icon size={16} aria-hidden="true" />
                <span className="font-medium">Guardrail {gm ? METRICS[gm].label.toLowerCase() : ''}:</span>
                <span>{meta.label}</span>
                {guardrail?.estimate && gm && <span className="text-text-secondary">({formatEffect(gm, guardrail.estimate.effect)} change)</span>}
              </p>
            );
          })()}
        </div>
      )}

      {analysis && analysis.warnings.length > 0 && (
        <ul className="mt-4 space-y-2" aria-label="Warnings">
          {analysis.warnings.map((w) => (
            <li key={w} className="flex gap-2 rounded-xl bg-warning-500/10 p-3 text-sm text-text-primary">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
              {w}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-sm text-text-primary">
        <span className="font-semibold">Recommendation:</span> {RECOMMENDATION_LABELS[snapshot.recommendation]}
      </p>
    </Card>
  );
}
