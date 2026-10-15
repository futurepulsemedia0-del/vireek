import { useId, useState } from 'react';
import { formatUsd, type DailyCostPoint } from '@/lib/staffUsage';

const W = 720;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 52 };

/** Daily AI + voice cost as stacked bars. Hover/focus a bar for exact values; a hidden table mirrors the data. */
export function UsageCostChart({ points }: { points: DailyCostPoint[] }) {
  const uid = useId();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0.01, ...points.map((p) => p.totalUsd));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(1, points.length);
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const y = (v: number) => PAD.top + (1 - v / max) * innerH;
  const every = Math.max(1, Math.ceil(points.length / 8));
  const grid = [0, 0.5, 1].map((f) => f * max);
  const a = active !== null ? points[active] : null;

  return (
    <figure className="m-0">
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-text-secondary">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-accent" aria-hidden="true" /> AI</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-accent-secondary" aria-hidden="true" /> Voice (estimated)</span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-labelledby={`${uid}-t`} onMouseLeave={() => setActive(null)}>
          <title id={`${uid}-t`}>Daily AI and voice cost over the last {points.length} days</title>
          {grid.map((g) => (
            <g key={g}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(g)} y2={y(g)} stroke="rgb(var(--border-default))" strokeDasharray="3 4" />
              <text x={PAD.left - 8} y={y(g) + 4} textAnchor="end" fontSize="11" fill="currentColor" className="text-text-secondary">
                {formatUsd(g, { compact: true })}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const x = PAD.left + i * slot + (slot - barW) / 2;
            const aiH = (p.aiCostUsd / max) * innerH;
            const vH = (p.voiceCostUsd / max) * innerH;
            return (
              <g
                key={p.day}
                tabIndex={0}
                role="img"
                aria-label={`${p.day}: total ${formatUsd(p.totalUsd)}, AI ${formatUsd(p.aiCostUsd)}, voice ${formatUsd(p.voiceCostUsd)}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="outline-none"
              >
                <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={innerH} fill="transparent" />
                <rect x={x} y={PAD.top + innerH - aiH} width={barW} height={aiH} fill="rgb(var(--accent-primary))" opacity={active === null || active === i ? 1 : 0.55} rx="1.5" />
                <rect x={x} y={PAD.top + innerH - aiH - vH} width={barW} height={vH} fill="rgb(var(--accent-secondary))" opacity={active === null || active === i ? 1 : 0.55} rx="1.5" />
              </g>
            );
          })}
          {points.map((p, i) =>
            i % every === 0 ? (
              <text key={p.day} x={PAD.left + i * slot + slot / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="currentColor" className="text-text-secondary">
                {p.day.slice(5)}
              </text>
            ) : null,
          )}
        </svg>
        {a && (
          <div className="pointer-events-none absolute right-2 top-0 rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs shadow-card dark:shadow-card-dark" role="status">
            <div className="font-semibold text-text-primary">{a.day}</div>
            <div className="text-text-secondary">Total {formatUsd(a.totalUsd)}</div>
            <div className="text-text-secondary">AI {formatUsd(a.aiCostUsd)} · Voice {formatUsd(a.voiceCostUsd)}</div>
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>Daily cost</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">AI</th><th scope="col">Voice</th><th scope="col">Total</th></tr></thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.day}><td>{p.day}</td><td>{formatUsd(p.aiCostUsd)}</td><td>{formatUsd(p.voiceCostUsd)}</td><td>{formatUsd(p.totalUsd)}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
