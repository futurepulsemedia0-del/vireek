import { History } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { LoadError, useLoader } from '@/components/commissions/shared';
import { EVENT_LABEL, fetchEvents } from '@/lib/payrollSync';

export function ActivityTab({ ownerId }: { ownerId: string }) {
  const events = useLoader(() => fetchEvents(ownerId), [ownerId]);
  if (events.error) return <LoadError message={events.error} onRetry={events.reload} />;
  if (events.loading) return <SkeletonCardList count={3} rows={1} />;
  const rows = events.data ?? [];
  if (rows.length === 0) return <EmptyState icon={History} title="No activity yet" description="Connections, approvals and sends are recorded here." />;
  return (
    <Card className="divide-y divide-border p-0 hover:translate-y-0">
      {rows.map((r) => {
        const status = typeof r.detail?.status === 'string' ? r.detail.status : null;
        const note = typeof r.detail?.note === 'string' ? r.detail.note : typeof r.detail?.error === 'string' ? r.detail.error : null;
        return (
          <div key={r.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-text-primary">{EVENT_LABEL[r.event] ?? r.event}{status ? ` (${status})` : ''}{note ? <span className="text-text-secondary">: {note}</span> : null}</p>
            <time className="shrink-0 text-xs text-text-secondary" dateTime={r.created_at}>{new Date(r.created_at).toLocaleString()}</time>
          </div>
        );
      })}
    </Card>
  );
}
