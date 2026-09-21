import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';

export interface NotificationRow {
  [key: string]: unknown;
  id: string;
  user_id: string;
  type: 'emergency_call' | 'usage_alert' | 'ai_insight' | 'job_update' |   'warranty_alert' | 'quote_viewed' | 'system';
  title: string;
  message: string;
  is_read: boolean;
  action_url: string | null;
  created_at: string;
}

const PAGE_SIZE = 15;
const SOUND_PREF_KEY = 'vireek_notif_sound_enabled';
const DESKTOP_PREF_KEY = 'vireek_notif_desktop_enabled';

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

interface NotificationsContextValue {
  items: NotificationRow[];
  unreadCount: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadError: boolean;
  soundOn: boolean;
  desktopOn: boolean;
  loadNotifications: () => Promise<void>;
  loadMore: () => Promise<void>;
  markRead: (row: NotificationRow) => Promise<void>;
  markAllRead: () => Promise<void>;
  toggleRead: (row: NotificationRow) => Promise<void>;
  deleteOne: (row: NotificationRow) => Promise<void>;
  clearRead: () => Promise<void>;
  toggleSound: () => void;
  toggleDesktop: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextValue | undefined>(undefined);

/**
 * Single, app-wide source of truth for notifications: one realtime
 * subscription, one in-memory list, one unread count.
 *
 * This used to live inside <NotificationBell>, but that component is
 * rendered twice at once in <DashboardNav> (once for the desktop sidebar,
 * once for the mobile header — Tailwind only toggles which one is
 * *visible*, both stay mounted). Two mounted instances meant two
 * independent `supabase.channel('notifications-<id>')` subscriptions with
 * the exact same channel name, which Supabase's realtime client treats as
 * the same channel — the second instance's `.on('postgres_changes', ...)`
 * landed on a channel the first instance had already called `.subscribe()`
 * on, throwing "cannot add postgres_changes callbacks ... after
 * subscribe()" and breaking the whole dashboard. It also meant a single
 * new notification could play the chime / fire the desktop notification
 * twice.
 *
 * Fix: subscribe exactly once, here, and have every consumer (both bells,
 * and anything else that needs notification state) read from this context
 * instead of subscribing on its own.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { profile, isOwner, teamMember } = useAuth();
  const { toast } = useToast();

  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(SOUND_PREF_KEY) !== 'false');
  const [desktopOn, setDesktopOn] = useState(() => localStorage.getItem(DESKTOP_PREF_KEY) === 'true');

  // Lets callbacks (loadMore, markAllRead, clearRead) read the latest list
  // without needing `items` in their own dependency arrays.
  const itemsRef = useRef(items);
  itemsRef.current = items;

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

  const loadMore = useCallback(async () => {
    if (!accountOwnerId || loadingMore) return;
    setLoadingMore(true);
    const current = itemsRef.current;
    const { data, error, count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', accountOwnerId)
      .order('created_at', { ascending: false })
      .range(current.length, current.length + PAGE_SIZE - 1);
    if (!error) {
      const rows = (data ?? []) as NotificationRow[];
      setItems((prev) => [...prev, ...rows]);
      setHasMore(count != null ? count > current.length + rows.length : rows.length === PAGE_SIZE);
    }
    setLoadingMore(false);
  }, [accountOwnerId, loadingMore]);

  // ---------------------------------------------------------------------
  // Realtime: insert, update (cross-tab "mark as read") and delete all
  // stay in sync live instead of only on next mount. This is now the ONLY
  // place in the app that opens a realtime channel for notifications.
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

  const markRead = useCallback(
    async (row: NotificationRow) => {
      if (row.is_read) return;
      setItems((prev) => prev.map((n) => (n.id === row.id ? { ...n, is_read: true } : n)));
      setUnreadCount((prev) => Math.max(0, prev - 1));
      const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', row.id);
      if (error) toast('Could not mark that as read. Please try again.', 'error');
    },
    [toast]
  );

  const toggleRead = useCallback(
    async (row: NotificationRow) => {
      const nextRead = !row.is_read;
      setItems((prev) => prev.map((n) => (n.id === row.id ? { ...n, is_read: nextRead } : n)));
      setUnreadCount((prev) => Math.max(0, prev + (nextRead ? -1 : 1)));
      const { error } = await supabase.from('notifications').update({ is_read: nextRead }).eq('id', row.id);
      if (error) toast('Could not update that notification.', 'error');
    },
    [toast]
  );

  const deleteOne = useCallback(
    async (row: NotificationRow) => {
      setItems((prev) => prev.filter((n) => n.id !== row.id));
      if (!row.is_read) setUnreadCount((prev) => Math.max(0, prev - 1));
      const { error } = await supabase.from('notifications').delete().eq('id', row.id);
      if (error) {
        toast('Could not delete that notification.', 'error');
        loadNotifications();
      }
    },
    [toast, loadNotifications]
  );

  const markAllRead = useCallback(async () => {
    if (!accountOwnerId) return;
    const unreadIds = itemsRef.current.filter((n) => !n.is_read).map((n) => n.id);
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
  }, [accountOwnerId, toast, loadNotifications, loadUnreadCount]);

  const clearRead = useCallback(async () => {
    if (!accountOwnerId) return;
    const readIds = itemsRef.current.filter((n) => n.is_read).map((n) => n.id);
    if (readIds.length === 0) return;
    setItems((prev) => prev.filter((n) => !n.is_read));
    const { error } = await supabase.from('notifications').delete().in('id', readIds);
    if (error) {
      toast('Could not clear read notifications.', 'error');
      loadNotifications();
    }
  }, [accountOwnerId, toast, loadNotifications]);

  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      localStorage.setItem(SOUND_PREF_KEY, String(next));
      return next;
    });
  }, []);

  const toggleDesktop = useCallback(async () => {
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
  }, [desktopOn, toast]);

  return (
    <NotificationsContext.Provider
      value={{
        items,
        unreadCount,
        loading,
        loadingMore,
        hasMore,
        loadError,
        soundOn,
        desktopOn,
        loadNotifications,
        loadMore,
        markRead,
        markAllRead,
        toggleRead,
        deleteOne,
        clearRead,
        toggleSound,
        toggleDesktop,
      }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within a NotificationsProvider');
  }
  return ctx;
}
