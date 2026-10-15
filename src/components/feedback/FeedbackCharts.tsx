import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { Summary, TrendPoint } from '@/lib/feedbackAnalytics';

export const npsTone = (nps: number | null) =>
  nps === null ? 'text-text-secondary' : nps >= 50 ? 'text-success' : nps >= 0 ? 'text-amber-600' : 'text-danger';

export function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="text-xs text-text-secondary" title="Needs at least 5 responses in both periods">—</span>;
  const Icon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus;
  const tone = delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-text-secondary';
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums ${tone}`}>
      <Icon size={13} aria-hidden="true" /> {delta > 0 ? '+' : ''}{delta}
      <span className="sr-only"> points versus the previous period</span>
    </span>
  );
}

/** Promoters / passives / detractors as one proportional bar. */
export function DistributionBar({ summary }: { summary: Summary }) {
  if (summary.n === 0) return <div className="h-2.5 rounded-full bg-bg-tertiary" aria-hidden="true" />;
  const pct = (n: number) => (n / summary.n) * 100;
  return (
    <div>
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-bg-tertiary"
        role="img"
        aria-label={`${summary.promoters} promoters, ${summary.passives} passives, ${summary.detractors} detractors`}
      >
        <div className="bg-success" style={{ width: `${pct(summary.promoters)}%` }} />
        <div className="bg-amber-400" style={{ width: `${pct(summary.passives)}%` }} />
        <div className="bg-danger" style={{ width: `${pct(summary.detractors)}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-text-secondary">
        <span><span className="text-success">●</span> {Math.round(pct(summary.promoters))}% promoters</span>
        <span><span className="text-amber-500">●</span> {Math.round(pct(summary.passives))}% passive</span>
        <span><span className="text-danger">●</span> {Math.round(pct(summary.detractors))}% detractors</span>
      </div>
    </div>
  );
}

/** Tiny NPS line for a table row; buckets with no responses break the line instead of faking a value. */
export function Sparkline({ points, label }: { points: TrendPoint[]; label: string }) {
  const W = 96, H = 28;
  const known = points.filter((p) => p.summary.nps !== null);
  if (known.length < 2) return <span className="text-xs text-text-secondary">Not enough data</span>;
  const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (nps: number) => H - ((nps + 100) / 200) * H;
  let path = '';
  let pen = false;
  points.forEach((p, i) => {
    if (p.summary.nps === null) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.summary.nps).toFixed(1)} `;
    pen = true;
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-7 w-24" role="img" aria-label={label}>
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="stroke-border" strokeDasharray="2 3" />
      <path d={path} fill="none" className="stroke-accent" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** NPS over time (line, −100…100) with response volume as bars underneath. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const W = 640, H = 220, padL = 34, padR = 8, padT = 10, padB = 26, barH = 36;
  const plotH = H - padT - padB - barH - 8;
  const innerW = W - padL - padR;
  const step = points.length > 0 ? innerW / points.length : innerW;
  const cx = (i: number) => padL + step * i + step / 2;
  const y = (nps: number) => padT + plotH - ((nps + 100) / 200) * plotH;
  const maxN = Math.max(1, ...points.map((p) => p.summary.n));
  const baseY = H - padB;

  let path = '';
  let pen = false;
  points.forEach((p, i) => {
    if (p.summary.nps === null) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)},${y(p.summary.nps).toFixed(1)} `;
    pen = true;
  });
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const withData = points.filter((p) => p.summary.nps !== null);
  const aria = withData.length
    ? `NPS trend: ${withData.map((p) => `${p.label} ${p.summary.nps} (${p.summary.n} responses)`).join('; ')}`
    : 'No responses in this period';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={aria}>
      {[-100, -50, 0, 50, 100].map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-text-secondary/40' : 'stroke-border'} strokeDasharray={v === 0 ? undefined : '3 4'} />
          <text x={padL - 6} y={y(v) + 3} textAnchor="end" className="fill-text-secondary text-[10px]">{v}</text>
        </g>
      ))}
      {points.map((p, i) => (
        <rect key={p.start} x={cx(i) - Math.min(14, step / 2 - 2)} width={Math.min(28, step - 4)} y={baseY - (p.summary.n / maxN) * barH} height={(p.summary.n / maxN) * barH} rx="2" className="fill-accent/20">
          <title>{`${p.label}: ${p.summary.n} responses`}</title>
        </rect>
      ))}
      <path d={path} fill="none" className="stroke-accent" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) =>
        p.summary.nps === null ? null : (
          <circle key={p.start} cx={cx(i)} cy={y(p.summary.nps)} r="3.5" className="fill-bg-secondary stroke-accent" strokeWidth="2">
            <title>{`${p.label}: NPS ${p.summary.nps}, CSAT ${p.summary.csat}% (${p.summary.n} responses)`}</title>
          </circle>
        ),
      )}
      {points.map((p, i) =>
        i % labelEvery === 0 ? <text key={p.start} x={cx(i)} y={H - 8} textAnchor="middle" className="fill-text-secondary text-[10px]">{p.label}</text> : null,
      )}
    </svg>
  );
}
