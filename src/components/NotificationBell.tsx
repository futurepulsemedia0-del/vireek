import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bell,
  PhoneCall,
  Gauge,
  Lightbulb,
  Wrench,
  Info,
  CheckCheck,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtimeSubscription } from '@/lib/realtime';

export interface NotificationRow {
  id: string;
  user_id: string;
  type: 'emergency_call' | 'usage_alert' | 'ai_insight' | 'job_update' | 'system';
  title: string;
  message: string;
  is_read: boolean;
  action_url: string | null;
  created_at: string;
}

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

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.round(diffMs / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function NotificationSkeleton() {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-bg-tertiary" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 w-2/3 animate-pulse rounded bg-bg-tertiary" />
        <div className="h-3 w-full animate-pulse rounded bg-bg-tertiary" />
      </div>
    </div>
  );
}

export function NotificationBell() {
  const { profile, isOwner, teamMember } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const loadNotifications = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    if (!error) {
      const rows = (data ?? []) as NotificationRow[];
      setItems(rows);
      setUnreadCount(rows.filter((r) => !r.is_read).length);
    }
    setLoading(false);
  }, [accountOwnerId]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  // Live updates: new notifications appear instantly (ties into step 11's
  // realtime infrastructure, per step 13's requirement).
  useRealtimeSubscription<NotificationRow>({
    channelName: `notifications-${accountOwnerId ?? 'anon'}`,
    table: 'notifications',
    event: 'INSERT',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId,
    onChange: (payload) => {
      const row = payload.new as NotificationRow;
      setItems((prev) => [row, ...prev].slice(0, 20));
      setUnreadCount((prev) => prev + 1);
    },
  });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const markRead = async (row: NotificationRow) => {
    if (!row.is_read) {
      setItems((prev) => prev.map((n) => (n.id === row.id ? { ...n, is_read: true } : n)));
      setUnreadCount((prev) => Math.max(0, prev - 1));
      await supabase.from('notifications').update({ is_read: true }).eq('id', row.id);
    }
    setOpen(false);
    if (row.action_url) navigate(row.action_url);
  };

  const markAllRead = async () => {
    const unreadIds = items.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);
    await supabase.from('notifications').update({ is_read: true }).in('id', unreadIds);
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        aria-expanded={open}
        className="focus-ring relative flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-primary text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4.5 min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 z-50 mt-2 w-[340px] max-w-[90vw] overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-sm font-semibold text-text-primary">Notifications</p>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                >
                  <CheckCheck size={13} />
                  Mark all as read
                </button>
              )}
            </div>

            <div className="max-h-[360px] overflow-y-auto">
              {loading ? (
                <>
                  <NotificationSkeleton />
                  <NotificationSkeleton />
                  <NotificationSkeleton />
                </>
              ) : items.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-sm text-text-secondary">You're all caught up.</p>
                </div>
              ) : (
                items.map((n) => {
                  const Icon = TYPE_ICON[n.type] ?? Info;
                  return (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => markRead(n)}
                      className={`focus-ring flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-tertiary ${
                        !n.is_read ? 'bg-accent/5' : ''
                      }`}
                    >
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TYPE_COLOR[n.type] ?? TYPE_COLOR.system}`}>
                        <Icon size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className={`truncate text-sm ${!n.is_read ? 'font-semibold text-text-primary' : 'font-medium text-text-secondary'}`}>
                            {n.title}
                          </span>
                          {!n.is_read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-text-secondary">{n.message}</span>
                        <span className="mt-0.5 block text-[11px] text-text-secondary/60">{timeAgo(n.created_at)}</span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            <div className="border-t border-border px-4 py-2.5">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate('/dashboard/notifications');
                }}
                className="focus-ring w-full rounded-lg py-1.5 text-center text-xs font-medium text-text-secondary hover:text-accent"
              >
                View all notifications
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
