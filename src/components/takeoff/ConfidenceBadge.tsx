import { BadgeCheck } from 'lucide-react';
import { confidenceBand, type TakeoffItem } from '@/lib/takeoff';

const BAND_CLASS = {
  high: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-danger/10 text-danger',
} as const;

const BAND_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

/** Per-line AI confidence. A line a person confirmed or corrected shows as Verified. */
export function ConfidenceBadge({
  confidence,
  reviewStatus,
}: {
  confidence: number;
  reviewStatus?: TakeoffItem['review_status'];
}) {
  if (reviewStatus === 'confirmed' || reviewStatus === 'edited') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent"
        title={`AI confidence was ${Math.round(confidence * 100)}%. A person has verified this line.`}
      >
        <BadgeCheck size={12} aria-hidden /> Verified
      </span>
    );
  }
  const band = confidenceBand(confidence);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${BAND_CLASS[band]}`}
      title={`AI confidence ${Math.round(confidence * 100)}% (${BAND_LABEL[band].toLowerCase()})`}
    >
      {Math.round(confidence * 100)}% · {BAND_LABEL[band]}
    </span>
  );
}
