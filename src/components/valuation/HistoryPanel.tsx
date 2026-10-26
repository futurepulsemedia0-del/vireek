import { History } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { BandBadge } from '@/components/valuation/ValuationUi';
import { formatMoney, type ValuationSnapshot } from '@/lib/valuation';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function HistoryPanel({ snapshots, onGoOverview }: { snapshots: ValuationSnapshot[]; onGoOverview: () => void }) {
  if (snapshots.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No snapshots yet"
        description="Save a snapshot from the Overview to start a record. Buyers and lenders like to see readiness improving over time."
        action={{ label: 'Go to overview', onClick: onGoOverview }}
      />
    );
  }

  return (
    <ul className="space-y-3" aria-label="Saved snapshots">
      {snapshots.map((s, i) => {
        const previous = snapshots[i + 1];
        const delta = s.readiness_score != null && previous?.readiness_score != null ? s.readiness_score - previous.readiness_score : null;
        return (
          <li key={s.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text-primary">{s.label || 'Snapshot'}</p>
                <p className="text-xs text-text-secondary">{formatDate(s.created_at)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-text-primary">{s.readiness_score ?? '—'}</span>
                {delta != null && delta !== 0 && (
                  <span className={`text-xs font-semibold ${delta > 0 ? 'text-success' : 'text-danger'}`} aria-label={`${delta > 0 ? 'Up' : 'Down'} ${Math.abs(delta)} points since the previous snapshot`}>
                    {delta > 0 ? '+' : '−'}{Math.abs(delta)}
                  </span>
                )}
                <BandBadge score={s.readiness_score} />
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-text-secondary">Estimated value</dt>
                <dd className="font-medium text-text-primary">{s.value_mid == null ? '—' : formatMoney(s.value_mid, { compact: true })}</dd>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <dt className="text-xs text-text-secondary">Range</dt>
                <dd className="font-medium text-text-primary">
                  {s.value_low == null || s.value_high == null ? '—' : `${formatMoney(s.value_low, { compact: true })} – ${formatMoney(s.value_high, { compact: true })}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-text-secondary">Questionnaire</dt>
                <dd className="font-medium text-text-primary">{s.assessment_score ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-text-secondary">Data room</dt>
                <dd className="font-medium text-text-primary">{s.data_room_score ?? '—'}</dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
