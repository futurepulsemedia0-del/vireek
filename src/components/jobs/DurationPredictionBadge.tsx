import { Clock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatMinutes, formatRange, slotMinutesFor, type Confidence } from '@/lib/durationModel';
import { useDurationPrediction, type DurationPredictionInput } from '@/hooks/useDurationPrediction';

interface Props {
  input: DurationPredictionInput;
  /** The duration currently chosen in the form / on the job. */
  currentMinutes: number | null;
  /** Called with the suggested slot length when the user taps "Use". */
  onApply?: (minutes: number) => void;
  className?: string;
}

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: 'bg-success/10 text-success',
  medium: 'bg-accent/10 text-accent',
  low: 'bg-bg-secondary text-text-secondary',
};

/**
 * Compact "what will this actually take?" readout for job forms and drawers:
 * predicted range, confidence, how it compares to the existing estimate, and a
 * one-tap way to adopt the recommended slot length.
 */
export function DurationPredictionBadge({ input, currentMinutes, onApply, className = '' }: Props) {
  const { prediction: p, settings, loading, failed } = useDurationPrediction(input);

  if (failed) return null;
  if (loading && !p) {
    return <p className={`text-xs text-text-secondary ${className}`} aria-live="polite">Estimating duration…</p>;
  }
  if (!p) return null;

  const learned = p.source !== 'prior';
  const slot = settings ? slotMinutesFor(p, settings.slotPolicy) : slotMinutesFor(p, 'balanced');
  const canApply = !!onApply && slot !== null && slot !== currentMinutes;
  const deltaPct = Math.round(p.deltaVsExistingPct * 100);

  return (
    <div className={`rounded-xl border border-border bg-bg-primary p-3 ${className}`} role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
          {learned ? <Sparkles size={14} className="text-accent" aria-hidden="true" /> : <Clock size={14} className="text-text-secondary" aria-hidden="true" />}
          {learned ? `Likely ${formatMinutes(p.minutes)}` : `Using your estimate · ${formatMinutes(p.existing.minutes)}`}
        </span>
        {learned && (
          <span className="text-xs tabular-nums text-text-secondary">
            {Math.round(p.intervalLevel * 100)}% range {formatRange(p.low, p.high)}
          </span>
        )}
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CONFIDENCE_STYLE[p.confidence]}`}>{p.confidence} confidence</span>
      </div>

      <p className="mt-1 text-xs text-text-secondary">
        {learned
          ? `Learned from ${p.sampleSize} similar job${p.sampleSize === 1 ? '' : 's'}${p.agreement === 'aligned' ? ' — in line with your estimate.' : ` — ${Math.abs(deltaPct)}% ${p.agreement} than your ${formatMinutes(p.existing.minutes)} estimate.`}`
          : 'Not enough completed jobs of this type yet. It starts learning as jobs are timed on site.'}
      </p>

      {learned && p.factors.length > 1 && (
        <p className="mt-1 text-[11px] text-text-secondary">
          {p.factors
            .filter((f) => f.id !== 'start' && f.id !== 'type')
            .slice(0, 3)
            .map((f) => `${f.label} ${f.minutes >= 0 ? '+' : ''}${f.minutes}m`)
            .join(' · ')}
        </p>
      )}

      {canApply && (
        <Button type="button" size="sm" className="mt-2" onClick={() => onApply?.(slot as number)}>
          Use {formatMinutes(slot as number)}
        </Button>
      )}
    </div>
  );
}
