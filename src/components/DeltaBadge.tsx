import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { describeDelta, formatDelta, type Delta } from '@/lib/dateRange';

const TONE: Record<Delta['sentiment'], string> = {
  good: 'bg-success-500/10 text-success-500',
  bad: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

interface DeltaBadgeProps {
  /** Pass null when comparison is switched off — nothing renders. */
  delta: Delta | null;
  /** Shown after "versus" for screen readers, e.g. "Sep 11 – Oct 10". */
  versus?: string;
  /** Formats the previous value for the tooltip (e.g. currency). Defaults to the raw number. */
  format?: (n: number) => string;
  className?: string;
}

/**
 * Compact "▲ +12.5%" chip. Colour reflects whether the change is GOOD or BAD
 * for the business (so a drop in missed calls is green), while the arrow
 * always shows the raw direction. Never colour-only: the arrow, the text and
 * a screen-reader sentence all carry the meaning.
 */
export function DeltaBadge({ delta, versus, format, className = '' }: DeltaBadgeProps) {
  if (!delta) return null;

  const Icon =
    delta.direction === 'up' || delta.direction === 'new'
      ? ArrowUpRight
      : delta.direction === 'down'
        ? ArrowDownRight
        : Minus;
  const sentence = describeDelta(delta, versus);
  const previousText =
    delta.previous == null ? null : format ? format(delta.previous) : String(delta.previous);
  const title = previousText ? `${sentence} (previous: ${previousText})` : sentence;
  const muted = delta.direction === 'none';

  return (
    <span
      data-testid="delta-badge"
      data-direction={delta.direction}
      data-sentiment={delta.sentiment}
      title={title}
      className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
        muted ? 'bg-bg-tertiary text-text-secondary/70' : TONE[delta.sentiment]
      } ${className}`}
    >
      {!muted && <Icon size={12} aria-hidden="true" />}
      <span aria-hidden="true">{formatDelta(delta)}</span>
      <span className="sr-only">{sentence}</span>
    </span>
  );
}
