import { RISK_LABELS, type RiskLevel } from '@/lib/successTools';

const STYLES: Record<RiskLevel, string> = {
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning-500/15 text-warning-500',
  low: 'bg-success-500/10 text-success-500',
  new: 'bg-accent/10 text-accent',
  churned: 'bg-bg-tertiary text-text-secondary',
};

export function RiskBadge({ level, score }: { level: RiskLevel; score: number | null }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${STYLES[level]}`}>
      {RISK_LABELS[level]}
      {score !== null && <span className="font-mono opacity-80">{score}</span>}
    </span>
  );
}
