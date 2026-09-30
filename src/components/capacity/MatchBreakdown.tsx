import { SCORE_FACTORS, topFactors, type ScoreBreakdown } from '@/lib/capacityLiquidity';

/** Explains a match score factor by factor. Renders nothing for pre-v2 matches. */
export function MatchBreakdown({ breakdown }: { breakdown: ScoreBreakdown | null | undefined }) {
  if (!breakdown || Object.keys(breakdown).length === 0) return null;
  const top = topFactors(breakdown);

  return (
    <details className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs">
      <summary className="focus-ring cursor-pointer select-none font-medium text-text-primary">
        Why you were matched{top.length > 0 ? ` — strong on ${top.join(', ').toLowerCase()}` : ''}
      </summary>
      <ul className="mt-2 space-y-1.5">
        {SCORE_FACTORS.map((f) => {
          const v = breakdown[f.key] ?? 0;
          const pct = Math.max(0, Math.min(100, Math.round((v / f.max) * 100)));
          return (
            <li key={f.key} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-text-secondary">{f.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden="true">
                <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
              <span className="w-14 shrink-0 text-right tabular-nums text-text-secondary">
                {v.toFixed(1)} / {f.max}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
