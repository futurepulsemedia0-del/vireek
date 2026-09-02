import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, PhoneCall, Gauge, Lightbulb, Wrench, Info, CheckCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';
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

const PAGE_SIZE = 30;

export function NotificationsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(async (offset: number) => {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) return [];
    return (data ?? []) as NotificationRow[];
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const rows = await load(0);
      setItems(rows);
      setHasMore(rows.length === PAGE_SIZE);
      setLoading(false);
    })();
  }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    const rows = await load(items.length);
    setItems((prev) => [...prev, ...rows]);
    setHasMore(rows.length === PAGE_SIZE);
    setLoadingMore(false);
  };

  const markAllRead = async () => {
    const unreadIds = items.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    await supabase.from('notifications').update({ is_read: true }).in('id', unreadIds);
  };

  const handleClick = async (n: NotificationRow) => {
    if (!n.is_read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      await supabase.from('notifications').update({ is_read: true }).eq('id', n.id);
    }
    if (n.action_url) navigate(n.action_url);
  };

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
          className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary"
        >
          <CheckCheck size={15} />
          Mark all as read
        </button>
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
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
              <Bell size={22} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">No notifications yet</h3>
            <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
              You'll see emergency calls, usage alerts, AI insights, and job updates here as they happen.
            </p>
          </div>
        ) : (
          items.map((n) => {
            const Icon = TYPE_ICON[n.type] ?? Info;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => handleClick(n)}
                className={`focus-ring flex w-full items-start gap-3 border-b border-border/60 px-5 py-4 text-left transition-colors last:border-0 hover:bg-bg-tertiary ${
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
                    <span className="text-xs text-text-secondary/60">
                      {new Date(n.created_at).toLocaleString()}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-sm text-text-secondary">{n.message}</span>
                </span>
              </button>
            );
          })
        )}
      </div>

      {hasMore && !loading && (
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
