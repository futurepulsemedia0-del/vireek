import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Info } from 'lucide-react';
import { ESTIMATE_DISCLAIMER, type DriverStatus, type Trend } from '@/lib/exitReadiness';

export const selectClass =
  'w-full rounded-xl border border-border bg-bg-secondary px-4 py-3 text-base text-text-primary focus-visible:border-accent focus-visible:outline-none';

export function EstimateBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 px-3 py-2.5 text-xs text-text-secondary">
      <Info size={14} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
      <p>
        <span className="font-semibold text-text-primary">Estimates, not valuations or advice. </span>
        {compact ? 'Based on your records and editable assumptions.' : ESTIMATE_DISCLAIMER}
      </p>
    </div>
  );
}

const STATUS_STYLE: Record<DriverStatus, string> = {
  strong: 'bg-success-500/10 text-success-500',
  ok: 'bg-warning-500/10 text-warning-500',
  weak: 'bg-danger/10 text-danger',
  nodata: 'bg-bg-tertiary text-text-secondary',
};
const STATUS_LABEL: Record<DriverStatus, string> = { strong: 'Strong', ok: 'Fair', weak: 'Needs work', nodata: 'No data' };

export function StatusPill({ status }: { status: DriverStatus }) {
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function TrendBadge({ trend }: { trend: Trend }) {
  if (trend.direction === 'none') return <span className="text-[11px] text-text-secondary">No prior month</span>;
  const Icon = trend.direction === 'up' ? ArrowUpRight : trend.direction === 'down' ? ArrowDownRight : ArrowRight;
  const tone = trend.direction === 'up' ? 'text-success-500' : trend.direction === 'down' ? 'text-danger' : 'text-text-secondary';
  const sign = (trend.delta ?? 0) > 0 ? '+' : '';
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${tone}`}>
      <Icon size={12} aria-hidden="true" />
      {sign}
      {trend.delta} pts vs last month
    </span>
  );
}

export function ScoreBar({ score }: { score: number | null }) {
  const pct = score === null ? 0 : Math.round(score);
  const tone = score === null ? 'bg-bg-tertiary' : score >= 75 ? 'bg-success-500' : score >= 45 ? 'bg-warning-500' : 'bg-danger';
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label="Driver score"
    >
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm">
      <input id={id} type="checkbox" className="mt-1 h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-text-primary">{label}</span>
        {hint && <span className="block text-xs text-text-secondary">{hint}</span>}
      </span>
    </label>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="text-xl font-bold text-text-primary">{value}</p>
      {sub && <p className="text-[11px] text-text-secondary">{sub}</p>}
    </div>
  );
}
