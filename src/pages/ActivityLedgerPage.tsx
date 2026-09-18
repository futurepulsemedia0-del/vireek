/**
 * Business Activity Ledger — /dashboard/activity-ledger
 *
 * A live, immutable, replayable record of everything that happens on
 * the account — calls, leads, jobs, quotes, payments, reviews — each
 * row appended automatically by a database trigger the instant it
 * happens (see supabase/migrations/20260928000000_business_activity_ledger.sql
 * and src/lib/activityLedger.ts). Unlike the Event Bus, nothing here can
 * be lost to a failed webhook delivery: this page reads straight from
 * the system of record.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  History,
  PhoneCall,
  UserPlus,
  Wrench,
  FileText,
  DollarSign,
  Star,
  Loader2,
  RefreshCw,
  Activity,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  activityEventLabel,
  AGGREGATE_LABELS,
  fetchActivityFeed,
  type ActivityEvent,
  type AggregateType,
} from '@/lib/activityLedger';

const AGGREGATE_ICONS: Record<AggregateType, typeof PhoneCall> = {
  call: PhoneCall,
  lead: UserPlus,
  job: Wrench,
  quote: FileText,
  payment: DollarSign,
  review: Star,
};

const FILTERS: { key: AggregateType | 'all'; label: string }[] = [
  { key: 'all', label: 'All activity' },
  { key: 'call', label: 'Calls' },
  { key: 'lead', label: 'Leads' },
  { key: 'job', label: 'Jobs' },
  { key: 'quote', label: 'Quotes' },
  { key: 'payment', label: 'Payments' },
  { key: 'review', label: 'Reviews' },
];

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function EventRow({ event }: { event: ActivityEvent }) {
  const Icon = AGGREGATE_ICONS[event.aggregate_type as AggregateType] ?? Activity;
  const aggregateLabel = AGGREGATE_LABELS[event.aggregate_type as AggregateType] ?? event.aggregate_type;

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-4"
    >
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-text-primary">{activityEventLabel(event.event_type)}</p>
          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
            {aggregateLabel} v{event.aggregate_version}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-text-secondary">
          {relativeTime(event.occurred_at)} · {event.actor_type}
        </p>
      </div>
    </motion.div>
  );
}

export function ActivityLedgerPage() {
  const { user } = useAuth();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [filter, setFilter] = useState<AggregateType | 'all'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchActivityFeed({
        limit: 50,
        aggregateType: filter === 'all' ? undefined : filter,
      });
      setEvents(rows);
      setHasMore(rows.length === 50);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (events.length === 0) return;
    setLoadingMore(true);
    try {
      const rows = await fetchActivityFeed({
        limit: 50,
        before: events[events.length - 1].id,
        aggregateType: filter === 'all' ? undefined : filter,
      });
      setEvents((prev) => [...prev, ...rows]);
      setHasMore(rows.length === 50);
    } finally {
      setLoadingMore(false);
    }
  };

  // Live tail: new rows appended by any trigger appear at the top instantly.
  useRealtimeSubscription<ActivityEvent>({
    channelName: `activity-ledger-${user?.id ?? 'anon'}`,
    table: 'business_activity_events',
    event: 'INSERT',
    enabled: !!user,
    onChange: (payload) => {
      const row = payload.new as ActivityEvent;
      if (filter !== 'all' && row.aggregate_type !== filter) return;
      setEvents((prev) => [row, ...prev]);
    },
  });

  return (
    <DashboardLayout activeLabel="Activity Ledger">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <History size={22} className="text-accent" /> Business Activity Ledger
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              An immutable, ordered record of everything that's happened on your account — appended
              automatically, in real time, straight from the database.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center">
            <Activity className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="text-sm text-text-secondary">No activity recorded yet for this filter.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        )}

        {!loading && hasMore && events.length > 0 && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="focus-ring mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-border py-2.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            {loadingMore ? <Loader2 size={13} className="animate-spin" /> : null}
            Load older activity
          </button>
        )}
      </div>
    </DashboardLayout>
  );
}
