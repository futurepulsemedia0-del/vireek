import { useId, type ReactNode } from 'react';

/** Axis-less sparkline. Decorative companion to the number; the number carries the information. */
export function Sparkline({ values, className = '' }: { values: readonly number[]; className?: string }) {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return null;
  const w = 80;
  const h = 24;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (pts.length - 1)) * w).toFixed(1)} ${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false" className={`overflow-visible ${className}`}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface StatProps {
  label: string;
  /** Pre-formatted with @/lib/format (never toLocaleString). */
  value: string;
  /** Usually <DeltaBadge/>; omit when comparison is off. */
  delta?: ReactNode;
  sparkline?: readonly number[];
  /** Plain-language definition, exposed on hover/focus and to screen readers. */
  definition?: string;
  loading?: boolean;
  className?: string;
}

/** KPI without an icon: label, tabular value, tiny delta, sparkline. */
export function Stat({ label, value, delta, sparkline, definition, loading = false, className = '' }: StatProps) {
  const defId = useId();
  return (
    <div
      aria-busy={loading || undefined}
      tabIndex={definition ? 0 : undefined}
      aria-describedby={definition ? defId : undefined}
      title={definition}
      className={`focus-ring rounded-lg border border-border bg-bg-secondary px-4 py-3 transition-opacity duration-fast motion-reduce:transition-none ${loading ? 'opacity-60' : ''} ${className}`}
    >
      <p className="text-xs text-text-secondary">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-3">
        <p className="text-2xl font-semibold leading-none tabular-nums tracking-tight text-text-primary">{value}</p>
        {sparkline && <Sparkline values={sparkline} className="text-text-muted" />}
      </div>
      {delta && <div className="mt-2 text-xs">{delta}</div>}
      {definition && <span id={defId} className="sr-only">{definition}</span>}
    </div>
  );
}
