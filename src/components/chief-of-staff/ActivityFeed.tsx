// Recreated: verify against original intent
import { Activity } from 'lucide-react';
import { Panel } from '@/components/ui/Panel';
import { EmptyState } from '@/components/EmptyState';
import { useChiefT } from '@/i18n/chiefOfStaffNamespace';
import type { FeedEvent } from '@/lib/chiefOfStaff';

interface Props {
  events: FeedEvent[];
}

/** Payload values are untrusted free text: only a plain string slug is ever shown, and only as text. */
function slugOf(payload: Record<string, unknown>): string {
  const v = payload?.slug ?? payload?.action_slug;
  return typeof v === 'string' ? v.slice(0, 80) : '';
}

export function ActivityFeed({ events }: Props) {
  const { t, language } = useChiefT();
  const stamp = new Intl.DateTimeFormat(language, { timeStyle: 'short', dateStyle: 'short' });

  const describe = (e: FeedEvent): string => {
    const key = `feed.event.${e.event_type}`;
    const known = t(key, { slug: slugOf(e.payload), defaultValue: '' });
    return known || t('feed.event.unknown', { type: e.event_type });
  };

  return (
    <Panel title={t('feed.title')} aria-label={t('feed.title')}>
      {events.length === 0 ? (
        <EmptyState compact icon={Activity} title={t('feed.empty.title')} description={t('feed.empty.body')} />
      ) : (
        <ol className="space-y-3">
          {events.map((e) => {
            const when = new Date(e.occurred_at);
            return (
              <li key={e.id} className="text-sm">
                <p className="text-text-primary">{describe(e)}</p>
                <p className="text-xs text-text-secondary">
                  {t('feed.by', { source: e.source })} ·{' '}
                  <time dateTime={e.occurred_at}>{Number.isNaN(when.getTime()) ? e.occurred_at : stamp.format(when)}</time>
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
