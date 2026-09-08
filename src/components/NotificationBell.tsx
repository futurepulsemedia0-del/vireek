import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Settings,
  Trash2,
  X,
  Volume2,
  VolumeX,
  RotateCw,
  AlertCircle,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';

export interface NotificationRow {
  [key: string]: unknown;
  id: string;
  user_id: string;
  type: 'emergency_call' | 'usage_alert' | 'ai_insight' | 'job_update' | 'system';
  title: string;
  message: string;
  is_read: boolean;
  action_url: string | null;
  created_at: string;
}

const PAGE_SIZE = 15;
const SOUND_PREF_KEY = 'vireek_notif_sound_enabled';
const DESKTOP_PREF_KEY = 'vireek_notif_desktop_enabled';

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

/** Short two-tone beep via WebAudio — no external asset to ship/host. */
function playChime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.09);
      gain.gain.linearRampToValueAtTime(0.15, now + i * 0.09 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.2);
    });
    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio isn't critical — fail silently if the browser blocks it.
  }
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
  const { toast } = useToast();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(SOUND_PREF_KEY) !== 'false');
  const [desktopOn, setDesktopOn] = useState(() => localStorage.getItem(DESKTOP_PREF_KEY) === 'true');

  const containerRef = useRef<HTMLDivElement>(null);
  const hasLoadedOnce = useRef(false);

  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  // ---------------------------------------------------------------------
  // Load (first page). Filters explicitly by user_id in addition to RLS —
  // relying on RLS alone meant a misconfigured policy or an edge-case in
  // get_account_owner_id() (e.g. a profile row that hasn't finished
  // provisioning yet) could return zero rows, or a query error, with the
  // UI never surfacing anything to explain why the bell looked "broken".
  // ---------------------------------------------------------------------
  const loadNotifications = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoading(true);
    setLoadError(false);
    const { data, error, count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', accountOwnerId)
      .order('created_at', { ascending: false })
      .range(0, PAGE_SIZE - 1);

    if (error) {
      setLoadError(true);
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as NotificationRow[];
    setItems(rows);
    setHasMore(count != null ? count > rows.length : rows.length === PAGE_SIZE);
    setLoading(false);
    hasLoadedOnce.current = true;
  }, [accountOwnerId]);

  // Separate, lightweight unread-count query so the badge is accurate even
  // beyond whatever page of rows happens to be loaded in the dropdown.
  const loadUnreadCount = useCallback(async () => {
    if (!accountOwnerId) return;
    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', accountOwnerId)
      .eq('is_read', false);
    if (!error && count != null) setUnreadCount(count);
  }, [accountOwnerId]);

  useEffect(() => {
    loadNotifications();
    loadUnreadCount();
  }, [loadNotifications, loadUnreadCount]);

  const loadMore = async () => {
    if (!accountOwnerId || loadingMore) return;
    setLoadingMore(true);
    const { data, error, count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', accountOwnerId)
      .order('created_at', { ascending: false })
      .range(items.length, items.length + PAGE_SIZE - 1);
    if (!error) {
      const rows = (data ?? []) as NotificationRow[];
      setItems((prev) => [...prev, ...rows]);
      setHasMore(count != null ? count > items.length + rows.length : rows.length === PAGE_SIZE);
    }
    setLoadingMore(false);
  };

  // ---------------------------------------------------------------------
  // Realtime: insert, update (cross-tab "mark as read") and delete all
  // stay in sync live instead of only on next mount.
  // ---------------------------------------------------------------------
  useRealtimeSubscription<NotificationRow>({
    channelName: `notifications-${accountOwnerId ?? 'anon'}`,
    table: 'notifications',
    event: '*',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId,
    onChange: (payload) => {
      if (payload.eventType === 'INSERT') {
        const row = payload.new as NotificationRow;
        setItems((prev) => (prev.some((n) => n.id === row.id) ? prev : [row, ...prev].slice(0, PAGE_SIZE)));
        setUnreadCount((prev) => prev + 1);
        if (soundOn) playChime();
        if (desktopOn && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(row.title, { body: row.message, tag: row.id });
        }
        if (row.type === 'emergency_call') {
          toast(`${row.title}: ${row.message}`, 'error');
        }
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new as NotificationRow;
        setItems((prev) => prev.map((n) => (n.id === row.id ? row : n)));
        loadUnreadCount();
      } else if (payload.eventType === 'DELETE') {
        const oldRow = payload.old as Partial<NotificationRow>;
        setItems((prev) => prev.filter((n) => n.id !== oldRow.id));
        loadUnreadCount();
      }
    },
  });

  // Click outside + Escape to close.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const markRead = async (row: NotificationRow) => {
    if (!row.is_read) {
      setItems((prev) => prev.map((n) => (n.id === row.id ? { ...n, is_read: true } : n)));
      setUnreadCount((prev) => Math.max(0, prev - 1));
      const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', row.id);
      if (error) toast('Could not mark that as read. Please try again.', 'error');
    }
    setOpen(false);
    if (row.action_url) navigate(row.action_url);
  };

  const toggleRead = async (row: NotificationRow, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextRead = !row.is_read;
    setItems((prev) => prev.map((n) => (n.id === row.id ? { ...n, is_read: nextRead } : n)));
    setUnreadCount((prev) => Math.max(0, prev + (nextRead ? -1 : 1)));
    const { error } = await supabase.from('notifications').update({ is_read: nextRead }).eq('id', row.id);
    if (error) toast('Could not update that notification.', 'error');
  };

  const deleteOne = async (row: NotificationRow, e: React.MouseEvent) => {
    e.stopPropagation();
    setItems((prev) => prev.filter((n) => n.id !== row.id));
    if (!row.is_read) setUnreadCount((prev) => Math.max(0, prev - 1));
    const { error } = await supabase.from('notifications').delete().eq('id', row.id);
    if (error) {
      toast('Could not delete that notification.', 'error');
      loadNotifications();
    }
  };

  const markAllRead = async () => {
    if (!accountOwnerId) return;
    const unreadIds = items.filter((n) => !n.is_read).map((n) => n.id);
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);
    // Scoped to this account so it also clears unread rows beyond the
    // currently-loaded page, not just what happens to be on screen.
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', accountOwnerId)
      .eq('is_read', false);
    if (error) {
      toast('Could not mark everything as read.', 'error');
      loadNotifications();
      loadUnreadCount();
    } else if (unreadIds.length === 0) {
      // Covers unread rows that existed beyond the loaded page.
      loadUnreadCount();
    }
  };

  const clearRead = async () => {
    if (!accountOwnerId) return;
    const readIds = items.filter((n) => n.is_read).map((n) => n.id);
    if (readIds.length === 0) return;
    setItems((prev) => prev.filter((n) => !n.is_read));
    const { error } = await supabase.from('notifications').delete().in('id', readIds);
    if (error) {
      toast('Could not clear read notifications.', 'error');
      loadNotifications();
    }
  };

  const toggleSound = () => {
    setSoundOn((prev) => {
      const next = !prev;
      localStorage.setItem(SOUND_PREF_KEY, String(next));
      return next;
    });
  };

  const toggleDesktop = async () => {
    if (!desktopOn) {
      if (typeof Notification === 'undefined') {
        toast('This browser does not support desktop notifications.', 'info');
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast('Enable notifications in your browser settings to use this.', 'info');
        return;
      }
    }
    setDesktopOn((prev) => {
      const next = !prev;
      localStorage.setItem(DESKTOP_PREF_KEY, String(next));
      return next;
    });
  };

  const visibleItems = useMemo(
    () => (filter === 'unread' ? items.filter((n) => !n.is_read) : items),
    [items, filter]
  );
  const hasReadItems = items.some((n) => n.is_read);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
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
            className="absolute right-0 z-50 mt-2 w-[360px] max-w-[92vw] overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <p className="text-sm font-semibold text-text-primary">Notifications</p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={toggleSound}
                  aria-label={soundOn ? 'Mute notification sound' : 'Enable notification sound'}
                  aria-pressed={soundOn}
                  title={soundOn ? 'Sound on' : 'Sound off'}
                  className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                >
                  {soundOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
                </button>
                <button
                  type="button"
                  onClick={toggleDesktop}
                  aria-pressed={desktopOn}
                  title={desktopOn ? 'Desktop alerts on' : 'Enable desktop alerts'}
                  className={`focus-ring flex h-7 w-7 items-center justify-center rounded-lg hover:bg-bg-tertiary ${
                    desktopOn ? 'text-accent' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <Bell size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate('/dashboard/settings');
                  }}
                  aria-label="Notification settings"
                  title="Notification settings"
                  className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                >
                  <Settings size={14} />
                </button>
              </div>
            </div>

            {/* Filter tabs + mark all read */}
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
              <div className="flex items-center gap-1 rounded-lg bg-bg-tertiary p-0.5">
                {(['all', 'unread'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      filter === f ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {f === 'all' ? 'All' : `Unread${unreadCount > 0 ? ` (${unreadCount})` : ''}`}
                  </button>
                ))}
              </div>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                >
                  <CheckCheck size={13} />
                  Mark all read
                </button>
              )}
            </div>

            {/* List */}
            <div className="max-h-[360px] overflow-y-auto">
              {loading ? (
                <>
                  <NotificationSkeleton />
                  <NotificationSkeleton />
                  <NotificationSkeleton />
                </>
              ) : loadError ? (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <AlertCircle size={22} className="text-danger" />
                  <p className="text-sm text-text-secondary">Couldn't load notifications.</p>
                  <button
                    type="button"
                    onClick={loadNotifications}
                    className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                  >
                    <RotateCw size={12} />
                    Retry
                  </button>
                </div>
              ) : visibleItems.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-sm text-text-secondary">
                    {filter === 'unread' ? "No unread notifications." : "You're all caught up."}
                  </p>
                </div>
              ) : (
                <>
                  {visibleItems.map((n) => {
                    const Icon = TYPE_ICON[n.type] ?? Info;
                    return (
                      <div
                        key={n.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => markRead(n)}
                        onKeyDown={(e) => e.key === 'Enter' && markRead(n)}
                        className={`group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-tertiary ${
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
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-secondary/60">
                            {timeAgo(n.created_at)}
                            <span aria-hidden="true">·</span>
                            {TYPE_LABEL[n.type] ?? 'System'}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={(e) => toggleRead(n, e)}
                            aria-label={n.is_read ? 'Mark as unread' : 'Mark as read'}
                            title={n.is_read ? 'Mark as unread' : 'Mark as read'}
                            className="focus-ring flex h-6 w-6 items-center justify-center rounded-md text-text-secondary hover:bg-bg-secondary hover:text-accent"
                          >
                            <span className={`block h-2 w-2 rounded-full ${n.is_read ? 'border border-text-secondary' : 'bg-accent'}`} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => deleteOne(n, e)}
                            aria-label="Delete notification"
                            title="Delete"
                            className="focus-ring flex h-6 w-6 items-center justify-center rounded-md text-text-secondary hover:bg-bg-secondary hover:text-danger"
                          >
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </div>
                    );
                  })}

                  {filter === 'all' && hasMore && (
                    <div className="px-4 py-2.5 text-center">
                      <button
                        type="button"
                        onClick={loadMore}
                        disabled={loadingMore}
                        className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-60"
                      >
                        {loadingMore ? 'Loading…' : 'Load older'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
              {hasReadItems ? (
                <button
                  type="button"
                  onClick={clearRead}
                  className="focus-ring flex items-center gap-1 rounded-lg px-1.5 py-1 text-xs font-medium text-text-secondary hover:text-danger"
                >
                  <X size={12} />
                  Clear read
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate('/dashboard/notifications');
                }}
                className="focus-ring rounded-lg py-1.5 text-center text-xs font-medium text-text-secondary hover:text-accent"
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
