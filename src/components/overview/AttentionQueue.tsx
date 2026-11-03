import { useTranslation } from 'react-i18next';
import { Panel } from '@/components/ui/Panel';
import { StatusDot, type StatusTone } from '@/components/ui/StatusDot';
import { EmptyNote } from '@/components/ui/EmptyNote';

export interface AttentionEntry {
  id: string;
  type: 'job' | 'call' | 'insight';
  priority: 'urgent' | 'warning' | 'info';
  title: string;
  description: string;
}

interface AttentionQueueProps {
  items: readonly AttentionEntry[];
  /** Called with the entry when its next-action button is used. */
  onAction: (entry: AttentionEntry) => void;
}

const TONE: Record<AttentionEntry['priority'], StatusTone> = {
  urgent: 'live',
  warning: 'warning',
  info: 'neutral',
};

/**
 * The Overview's primary list. Every row states what is wrong and offers the next action.
 * Rows are real buttons (keyboard + screen-reader friendly); no icon tiles, no coloured stripes.
 */
export function AttentionQueue({ items, onAction }: AttentionQueueProps) {
  const { t } = useTranslation('dashboard');
  const actionLabel = (e: AttentionEntry) =>
    e.type === 'job'
      ? t('overview.attention.openJob', 'Open jobs')
      : e.type === 'call'
        ? t('overview.attention.openCall', 'Open calls')
        : t('overview.attention.openInsight', 'Review');
  const priorityLabel = (p: AttentionEntry['priority']) =>
    p === 'urgent' ? t('overview.attention.urgent', 'Urgent') : p === 'warning' ? t('overview.attention.soon', 'Soon') : t('overview.attention.fyi', 'For review');

  return (
    <Panel
      title={t('overview.attention.title', 'Needs attention')}
      actions={items.length > 0 ? <span className="tabular-nums">{items.length}</span> : undefined}
      flush
    >
      {items.length === 0 ? (
        <div className="px-4">
          <EmptyNote>{t('overview.attention.clear', 'Nothing is waiting on you right now.')}</EmptyNote>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((e) => (
            <li key={e.id} className="group flex items-start gap-3 px-4 py-2.5 hover:bg-bg-tertiary/60">
              <StatusDot tone={TONE[e.priority]} label={priorityLabel(e.priority)} className="mt-0.5 w-20 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-text-primary">{e.title}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary">{e.description}</p>
              </div>
              <button
                type="button"
                onClick={() => onAction(e)}
                className="focus-ring shrink-0 rounded px-2 py-1 text-xs font-medium text-accent hover:bg-bg-tertiary"
              >
                {actionLabel(e)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
