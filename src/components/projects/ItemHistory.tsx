import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { EmptyStateInline } from '@/components/EmptyState';
import { fetchItemEvents } from '@/lib/submittalsApi';
import { formatDateTime, type ItemEvent } from '@/lib/projectItemsCore';
import { SUBMITTAL_ACTION_LABEL } from '@/lib/submittals';
import { PUNCH_ACTION_LABEL } from '@/lib/punchList';

function actionLabel(e: ItemEvent): string {
  const map = (e.item_type === 'submittal' ? SUBMITTAL_ACTION_LABEL : PUNCH_ACTION_LABEL) as Record<string, string>;
  const label = map[e.action] ?? e.action;
  return e.item_type === 'submittal' && e.revision_number !== null ? `${label} · Rev ${e.revision_number}` : label;
}

/** Append-only audit trail of an item (loaded on demand). `refreshKey` reloads after a workflow step. */
export function ItemHistory({ ownerId, itemType, itemId, refreshKey }: { ownerId: string; itemType: 'submittal' | 'punch'; itemId: string; refreshKey: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ItemEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFailed(false);
    fetchItemEvents(ownerId, itemType, itemId)
      .then((rows) => { if (!cancelled) setEvents(rows); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, ownerId, itemType, itemId, refreshKey]);

  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-text-secondary hover:text-text-primary">
        <History size={14} aria-hidden="true" /> {open ? 'Hide history' : 'Show history'}
      </button>
      {open && (
        <div className="mt-2">
          {failed ? (
            <p role="alert" className="text-sm text-danger-500">Could not load the history.</p>
          ) : events === null ? (
            <p className="text-sm text-text-secondary" aria-busy="true">Loading…</p>
          ) : events.length === 0 ? (
            <EmptyStateInline text="Nothing has happened here yet." />
          ) : (
            <ol className="space-y-2 border-l border-border pl-4">
              {events.map((e) => (
                <li key={e.id} className="text-sm">
                  <p className="font-medium text-text-primary">{actionLabel(e)}</p>
                  <p className="text-xs text-text-secondary">{e.actor_name ?? 'Someone'} · {formatDateTime(e.created_at)}</p>
                  {e.note && <p className="mt-0.5 whitespace-pre-wrap text-text-secondary">{e.note}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
