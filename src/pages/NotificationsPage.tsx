import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, PhoneCall, Gauge, Lightbulb, Wrench, Info, CheckCheck, Trash2, AlertCircle, RotateCw } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import type { NotificationRow } from '@/components/NotificationBell';

const TYPE_ICON: Record<NotificationRow['type'], typeof Bell> = {
  emergency_call: PhoneCall,
  usage_alert: Gauge,
  ai_insight: Lightbulb,
  job_update: Wrench,
  system: Info,
};

const TYPE_COLOR: Record<NotificationRow['type'], string> = {
  emergency_call: 'bg-danger/10 text-danger',
  usage_alert: 'bg-warning-500/10 text-warning-500',
  ai_insight: 'bg-ai/10 text-ai',
  job_update: 'bg-accent/10 text-accent',
  system: 'bg-bg-tertiary text-text-secondary',
};

const TYPE_LABEL: Record<NotificationRow['type'], string> = {
  emergency_call: 'Emergency call',
  usage_alert: 'Usage alert',
  ai_insight: 'AI insight',
  job_update: 'Job update',
  system: 'System',
};

const PAGE_SIZE = 30;
type TypeFilter = 'all' | NotificationRow['type'];

export function NotificationsPage() {
  const navigate = useNavigate();
  const { profile, isOwner, teamMember } = useAuth();
  const { toast } = useToast();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [readFilter, setReadFilter] = useState<'all' | 'unread'>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  const load = useCallback(
    async (offset: number) => {
      if (!accountOwnerId) return { rows: [] as NotificationRow[], error: null as string | null };
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', accountOwnerId)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) return { rows: [], error: error.message };
      return { rows: (data ?? []) as NotificationRow[], error: null };
    },
    [accountOwnerId]
  );

  useEffect(() => {
    if (!accountOwnerId) return;
    (async () => {
      setLoading(true);
      setLoadError(false);
      const { rows, error } = await load(0);
      if (error) {
        setLoadError(true);
      } else {
        setItems(rows);
        setHasMore(rows.length === PAGE_SIZE);
      }
      setLoading(false);
    })();
  }, [load, accountOwnerId]);

  const loadMore = async () => {
    setLoadingMore(true);
    const { rows, error } = await load(items.length);
    if (error) {
      toast('Could not load more notifications.', 'error');
    } else {
      setItems((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
    }
    setLoadingMore(false);
  };

  const markAllRead = async () => {
    if (!accountOwnerId) return;
    const unreadIds = items.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', accountOwnerId)
      .eq('is_read', false);
    if (error) toast('Could not mark everything as read.', 'error');
  };

  const handleClick = async (n: NotificationRow) => {
    if (!n.is_read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', n.id);
      if (error) toast('Could not mark that as read.', 'error');
    }
    if (n.action_url) navigate(n.action_url);
  };

  const deleteOne = async (n: NotificationRow, e: React.MouseEvent) => {
    e.stopPropagation();
    setItems((prev) => prev.filter((x) => x.id !== n.id));
    const { error } = await supabase.from('notifications').delete().eq('id', n.id);
    if (error) toast('Could not delete that notification.', 'error');
  };

  const visibleItems = useMemo(() => {
    return items
      .filter((n) => (readFilter === 'unread' ? !n.is_read : true))
      .filter((n) => (typeFilter === 'all' ? true : n.type === typeFilter));
  }, [items, readFilter, typeFilter]);

  const unreadCount = items.filter((n) => !n.is_read).length;

  return (
    <DashboardLayout activeLabel="Notifications">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Bell size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Notifications</h1>
            <p className="mt-1 text-sm text-text-secondary">Everything Vireek has flagged for your account.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={markAllRead}
          disabled={unreadCount === 0}
          className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CheckCheck size={15} />
          Mark all as read
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-bg-tertiary p-0.5">
          {(['all', 'unread'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setReadFilter(f)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                readFilter === f ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {f === 'all' ? 'All' : `Unread (${unreadCount})`}
            </button>
          ))}
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
          className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-primary"
        >
          <option value="all">All types</option>
          {(Object.keys(TYPE_LABEL) as NotificationRow['type'][]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
        {loading ? (
          <div className="space-y-0">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-start gap-3 border-b border-border/60 px-5 py-4 last:border-0">
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-bg-tertiary" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/3 animate-pulse rounded bg-bg-tertiary" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-bg-tertiary" />
                </div>
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <AlertCircle size={24} className="text-danger" />
            <p className="text-sm text-text-secondary">Couldn't load notifications.</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary"
            >
              <RotateCw size={14} />
              Retry
            </button>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
              <Bell size={22} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">
              {readFilter === 'unread' || typeFilter !== 'all' ? 'No matching notifications' : 'No notifications yet'}
            </h3>
            <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
              You'll see emergency calls, usage alerts, AI insights, and job updates here as they happen.
            </p>
          </div>
        ) : (
          visibleItems.map((n) => {
            const Icon = TYPE_ICON[n.type] ?? Info;
            return (
              <div
                key={n.id}
                role="button"
                tabIndex={0}
                onClick={() => handleClick(n)}
                onKeyDown={(e) => e.key === 'Enter' && handleClick(n)}
                className={`group flex w-full items-start gap-3 border-b border-border/60 px-5 py-4 text-left transition-colors last:border-0 hover:bg-bg-tertiary ${
                  !n.is_read ? 'bg-accent/5' : ''
                }`}
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${TYPE_COLOR[n.type] ?? TYPE_COLOR.system}`}>
                  <Icon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm ${!n.is_read ? 'font-semibold text-text-primary' : 'font-medium text-text-secondary'}`}>
                      {n.title}
                    </span>
                    {!n.is_read && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                    <span className="text-xs text-text-secondary/60">{new Date(n.created_at).toLocaleString()}</span>
                  </span>
                  <span className="mt-0.5 block text-sm text-text-secondary">{n.message}</span>
                </span>
                <button
                  type="button"
                  onClick={(e) => deleteOne(n, e)}
                  aria-label="Delete notification"
                  title="Delete"
                  className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary opacity-0 transition-opacity hover:bg-bg-secondary hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {hasMore && !loading && !loadError && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="focus-ring rounded-xl border border-border bg-bg-secondary px-5 py-2.5 text-sm font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </DashboardLayout>
  );
}
