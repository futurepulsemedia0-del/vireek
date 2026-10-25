import type { Provenance } from '../../../supabase/functions/_shared/ovb/logic';
import { DIMENSIONS, DIMENSION_LABELS, type Dimension } from '../../../supabase/functions/_shared/ovb/logic';
import { PROVENANCE_BADGE, fmtScore, type TrendPoint } from '@/lib/openVoiceBenchmark';

const TONE: Record<'accent' | 'success' | 'warn', string> = {
  accent: 'border-accent/40 bg-accent/10 text-accent',
  success: 'border-success/40 bg-success/10 text-success',
  warn: 'border-warning-500/40 bg-warning-500/10 text-warning-500',
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const b = PROVENANCE_BADGE[provenance];
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[b.tone]}`}>{b.label}</span>;
}

export function ScoreBadge({ score, label }: { score: number | null | undefined; label?: string }) {
  const tone = typeof score !== 'number' ? 'text-text-secondary' : score >= 85 ? 'text-success' : score >= 70 ? 'text-warning-500' : 'text-danger';
  return (
    <span className={`font-semibold tabular-nums ${tone}`} aria-label={label ? `${label}: ${fmtScore(score)}` : undefined}>
      {fmtScore(score)}
    </span>
  );
}

export function DimensionBars({ dimensions }: { dimensions: Partial<Record<Dimension, { score: number | null } | number>> }) {
  return (
    <ul className="space-y-2">
      {DIMENSIONS.map((d) => {
        const raw = dimensions[d];
        const v = typeof raw === 'number' ? raw : raw?.score ?? null;
        return (
          <li key={d} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3 text-sm">
            <span className="text-text-secondary">{DIMENSION_LABELS[d]}</span>
            <span className="h-2 overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`${DIMENSION_LABELS[d]} ${fmtScore(v)} out of 100`}>
              <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, v ?? 0))}%` }} />
            </span>
            <ScoreBadge score={v} />
          </li>
        );
      })}
    </ul>
  );
}

/** Dependency-free SVG trend: overall (solid) and held-out (dashed) per published Vireek version. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const W = 640, H = 220, P = 32;
  if (points.length === 0) return null;
  const sx = (i: number) => (points.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (points.length - 1));
  const sy = (v: number) => H - P - (v / 100) * (H - 2 * P);
  const line = (sel: (p: TrendPoint) => number | null) => points.map((p, i) => ({ p, i, v: sel(p) })).filter((q) => q.v !== null)
    .map((q, k) => `${k ? 'L' : 'M'}${sx(q.i).toFixed(1)},${sy(q.v as number).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Vireek benchmark score history by version">
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={P} x2={W - P} y1={sy(g)} y2={sy(g)} className="stroke-border" strokeWidth={1} />
          <text x={4} y={sy(g) + 4} className="fill-text-secondary text-[10px]">{g}</text>
        </g>
      ))}
      <path d={line((p) => p.overall)} className="fill-none stroke-accent" strokeWidth={2.5} />
      <path d={line((p) => p.heldOut)} className="fill-none stroke-text-secondary" strokeWidth={2} strokeDasharray="5 4" />
      {points.map((p, i) => (
        <g key={p.label + i}>
          <circle cx={sx(i)} cy={sy(p.overall)} r={4} className={p.retracted ? 'fill-danger' : 'fill-accent'}>
            <title>{`${p.label}: ${fmtScore(p.overall)}${p.retracted ? ' (retracted)' : ''}`}</title>
          </circle>
        </g>
      ))}
    </svg>
  );
}
