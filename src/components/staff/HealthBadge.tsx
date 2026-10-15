import { BAND_LABELS, type HealthBand } from '@/lib/staffCustomers';

const STYLES: Record<HealthBand, string> = {
  healthy: 'bg-success-500/10 text-success-500',
  watch: 'bg-warning-500/10 text-warning-500',
  at_risk: 'bg-warning-500/15 text-warning-500',
  critical: 'bg-danger/10 text-danger',
  new: 'bg-accent/10 text-accent',
  churned: 'bg-bg-tertiary text-text-secondary',
};

export function HealthBadge({ band, score }: { band: HealthBand; score: number }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${STYLES[band]}`}>
      {BAND_LABELS[band]}
      <span className="font-mono opacity-80">{score}</span>
    </span>
  );
}
