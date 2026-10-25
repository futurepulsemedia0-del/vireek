import { Card } from '@/components/ui/Card';
import { ADOPTION_LEVEL_LABELS, STATUS_LABELS, type AdoptionResult, type FeatureStatus } from '@/lib/successTools';

const CHIP: Record<FeatureStatus, string> = {
  active: 'bg-success-500/10 text-success-500',
  lapsed: 'bg-warning-500/10 text-warning-500',
  unused: 'bg-bg-tertiary text-text-secondary',
  unmeasured: 'bg-bg-tertiary text-text-secondary/60',
};

const R = 44;
const C = 2 * Math.PI * R;

/** Account feature-adoption score with a per-feature breakdown. */
export function AdoptionScoreCard({ adoption }: { adoption: AdoptionResult }) {
  const { score, level, items, counts } = adoption;
  const measured = items.filter((i) => i.status !== 'unmeasured');
  const tone = score === null ? 'text-text-secondary' : score >= 75 ? 'text-success-500' : score >= 50 ? 'text-accent' : 'text-warning-500';
  return (
    <Card className="space-y-5 p-5 hover:translate-y-0">
      <div className="flex items-center gap-5">
        <div className="relative h-24 w-24 shrink-0" role="img" aria-label={score === null ? 'Adoption score unavailable' : `Adoption score ${score} out of 100`}>
          <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden="true">
            <circle cx="50" cy="50" r={R} fill="none" strokeWidth="9" className="stroke-bg-tertiary" />
            {score !== null && (
              <circle cx="50" cy="50" r={R} fill="none" strokeWidth="9" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - score / 100)} className={`stroke-current ${tone} transition-[stroke-dashoffset] duration-700`} />
            )}
          </svg>
          <span className={`absolute inset-0 flex items-center justify-center text-2xl font-bold ${tone}`}>{score ?? '—'}</span>
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-bold text-text-primary">Feature adoption</h2>
          <p className={`text-sm font-semibold ${tone}`}>{ADOPTION_LEVEL_LABELS[level]}</p>
          <p className="mt-1 text-xs text-text-secondary">
            {counts.active} in use · {counts.lapsed} lapsed · {counts.unused} not started
            {counts.unmeasured > 0 ? ` · ${counts.unmeasured} not measured` : ''}
          </p>
          <p className="mt-1 text-[11px] text-text-secondary">Weighted by how much each feature matters to a service business. Lapsed features count half.</p>
        </div>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {measured.map((i) => (
          <li key={i.key} className="flex items-center justify-between gap-2 rounded-xl bg-bg-primary px-3 py-2 text-xs">
            <span className="min-w-0 truncate font-medium text-text-primary">{i.label}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${CHIP[i.status]}`}>{STATUS_LABELS[i.status]}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
