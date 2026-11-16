import { BAND_LABELS, type HealthBand } from '@/lib/staffCustomers';

const STYLES: Record<HealthBand, string> = {
  healthy: 'bg-success-subtle text-success',
  watch: 'bg-warning-subtle text-warning',
  at_risk: 'bg-warning-subtle text-warning',
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
