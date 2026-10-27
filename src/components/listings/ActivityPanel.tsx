import { History } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { LISTING_PLATFORM_LABEL, describeEvent, timeAgo, type ListingEvent, type ListingsOverview } from '@/lib/listings';

const OUTCOME_CLASS: Record<ListingEvent['outcome'], string> = {
  ok: 'bg-success/10 text-success',
  drift: 'bg-warning-500/10 text-warning-500',
  blocked: 'bg-bg-tertiary text-text-secondary',
  error: 'bg-danger/10 text-danger',
};
const OUTCOME_LABEL: Record<ListingEvent['outcome'], string> = { ok: 'OK', drift: 'Mismatch', blocked: 'Blocked', error: 'Error' };

export function ActivityPanel({ data }: { data: ListingsOverview }) {
  if (data.events.length === 0) {
    return <EmptyState icon={History} title="No activity yet" description="Every update, daily check and manual confirmation is recorded here, so you can always see what changed and when." />;
  }

  const nameOf = (id: string | null) => data.locations.find((l) => l.id === id)?.name ?? 'Removed location';

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="mb-3 text-lg font-semibold text-text-primary">Recent activity</h2>
      <ul className="divide-y divide-border">
        {data.events.map((e) => (
          <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium text-text-primary">
                {LISTING_PLATFORM_LABEL[e.platform]} · {nameOf(e.location_id)}
              </p>
              <p className="mt-0.5 break-words text-xs text-text-secondary">{describeEvent(e)}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${OUTCOME_CLASS[e.outcome]}`}>{OUTCOME_LABEL[e.outcome]}</span>
              <span className="text-xs text-text-secondary">{timeAgo(e.created_at)}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
