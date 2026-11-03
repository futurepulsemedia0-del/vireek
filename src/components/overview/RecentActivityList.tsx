import { useTranslation } from 'react-i18next';
import { Panel } from '@/components/ui/Panel';
import { EmptyNote } from '@/components/ui/EmptyNote';
import { formatDateTime, formatRelativeTime } from '@/lib/format';

export interface ActivityEntry {
  id: string;
  type: 'call' | 'job' | 'lead';
  title: string;
  description: string;
  timestamp: string;
}

interface RecentActivityListProps {
  items: readonly ActivityEntry[];
  /** Row to emphasise for a moment after a realtime insert (background only, no motion). */
  highlightId?: string | null;
}

/** Activity as a dense table-like list: kind, what happened, when. Time is exact on hover. */
export function RecentActivityList({ items, highlightId }: RecentActivityListProps) {
  const { t } = useTranslation('dashboard');
  const kind = (k: ActivityEntry['type']) =>
    k === 'call' ? t('overview.activity.call', 'Call') : k === 'job' ? t('overview.activity.job', 'Job') : t('overview.activity.lead', 'Lead');

  return (
    <Panel title={t('overview.activity.title', 'Recent activity')} flush>
      {items.length === 0 ? (
        <div className="px-4">
          <EmptyNote>{t('overview.activity.empty', 'Calls, jobs and leads show up here as they come in.')}</EmptyNote>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((it) => (
            <li
              key={it.id}
              className={`grid grid-cols-[3.5rem_1fr_auto] items-baseline gap-3 px-4 py-2 hover:bg-bg-tertiary/60 ${highlightId === it.id ? 'bg-accent/5' : ''}`}
            >
              <span className="text-xs text-text-secondary">{kind(it.type)}</span>
              <div className="min-w-0">
                <p className="truncate text-[13px] text-text-primary">{it.title}</p>
                <p className="truncate text-xs text-text-secondary">{it.description}</p>
              </div>
              <time dateTime={it.timestamp} title={formatDateTime(it.timestamp)} className="shrink-0 text-xs tabular-nums text-text-secondary">
                {formatRelativeTime(it.timestamp)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
