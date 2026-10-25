import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import {
  KIND_LABELS,
  gradeOf,
  type FindingKind,
  type Severity,
  type TrendStat,
  type WeekPoint,
} from '@/lib/callQuality';

export const scoreTone = (score: number | null) =>
  score === null ? 'text-text-secondary' : score >= 85 ? 'text-success' : score >= 70 ? 'text-warning-500' : 'text-danger';

export function ScoreBadge({ score, size = 'md' }: { score: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const grade = gradeOf(score);
  const dim = size === 'lg' ? 'h-16 w-16 text-2xl' : size === 'sm' ? 'h-8 w-8 text-xs' : 'h-11 w-11 text-sm';
  return (
    <span
      title={score === null ? 'Not enough data to score' : `${score}/100`}
      className={`inline-flex shrink-0 flex-col items-center justify-center rounded-xl border border-border bg-bg-primary font-bold tabular-nums ${dim} ${scoreTone(score)}`}
    >
      {score === null ? '—' : score}
      {grade && size === 'lg' && <span className="-mt-1 text-[10px] font-semibold opacity-70">Grade {grade}</span>}
    </span>
  );
}

const SEV_STYLE: Record<Severity, string> = {
  low: 'border-border text-text-secondary',
  medium: 'border-warning-500/40 bg-warning-500/10 text-warning-500',
  high: 'border-danger/40 bg-danger/10 text-danger',
  critical: 'border-danger bg-danger text-white',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${SEV_STYLE[severity]}`}>{severity}</span>;
}

export function KindBadge({ kind }: { kind: FindingKind }) {
  return <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">{KIND_LABELS[kind]}</span>;
}

export function DeltaPill({ stat }: { stat: TrendStat }) {
  if (stat.delta === null) {
    return <span className="text-xs text-text-secondary/70" title="Needs at least 5 reviews in both periods">not enough data</span>;
  }
  const Icon = stat.direction === 'up' ? ArrowUpRight : stat.direction === 'down' ? ArrowDownRight : ArrowRight;
  const tone = stat.direction === 'up' ? 'text-success' : stat.direction === 'down' ? 'text-danger' : 'text-text-secondary';
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${tone}`}>
      <Icon size={14} />
      {stat.delta > 0 ? '+' : ''}
      {stat.delta}
    </span>
  );
}

export function Sparkline({ weeks }: { weeks: WeekPoint[] }) {
  const w = 320;
  const h = 72;
  const pts = weeks.map((p, i) => ({ x: (i / Math.max(weeks.length - 1, 1)) * w, y: p.avg === null ? null : h - 6 - (p.avg / 100) * (h - 12), n: p.n }));
  const segments: string[] = [];
  let cur = '';
  for (const p of pts) {
    if (p.y === null) { if (cur) segments.push(cur); cur = ''; continue; }
    cur += `${cur ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
  }
  if (cur) segments.push(cur);
  const any = pts.some((p) => p.y !== null);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Weekly average quality score" className="h-20 w-full">
      <line x1="0" x2={w} y1={h - 6 - 0.85 * (h - 12)} y2={h - 6 - 0.85 * (h - 12)} stroke="currentColor" strokeDasharray="3 4" className="text-border" />
      {segments.map((d, i) => <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent" />)}
      {pts.map((p, i) => p.y !== null && <circle key={i} cx={p.x} cy={p.y} r="3" className="fill-accent" />)}
      {!any && <text x={w / 2} y={h / 2} textAnchor="middle" className="fill-text-secondary text-[11px]">Trend appears after the first reviews</text>}
    </svg>
  );
}

export function DimensionBar({ label, score }: { label: string; score: number | null }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary">{label}</span>
        <span className={`font-semibold tabular-nums ${scoreTone(score)}`}>{score === null ? 'n/a' : score}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
        <div className={`h-full rounded-full ${score === null ? '' : score >= 85 ? 'bg-success' : score >= 70 ? 'bg-warning-500' : 'bg-danger'}`} style={{ width: `${score ?? 0}%` }} />
      </div>
    </div>
  );
}

export const btnPrimary = 'focus-ring inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
export const btnGhost = 'focus-ring inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50';
export const inputCls = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

export const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
