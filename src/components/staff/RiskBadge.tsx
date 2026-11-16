import { RISK_LABELS, type RiskLevel } from '@/lib/successTools';

const STYLES: Record<RiskLevel, string> = {
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning-subtle text-warning',
  low: 'bg-success-subtle text-success',
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
