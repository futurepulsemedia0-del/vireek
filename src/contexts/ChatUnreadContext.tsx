import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { fetchPeople, fetchUnreadCounts } from '@/lib/teamChatApi';
import { previewText, titleWithUnread, totalUnread, type ChatMessage } from '@/lib/teamChat';

interface ChatUnreadValue {
  counts: Map<string, number>;
  total: number;
  /** Re-reads unread counts (call after marking a channel read). */
  refresh: () => void;
  /** The chat page tells the provider which conversation is on screen (no toast / no double count). */
  setActiveChannel: (id: string | null) => void;
}

const NOOP: ChatUnreadValue = { counts: new Map(), total: 0, refresh: () => undefined, setActiveChannel: () => undefined };
const ChatUnreadContext = createContext<ChatUnreadValue>(NOOP);

/**
 * One realtime subscription for the whole dashboard: powers the nav badge, the tab title,
 * the app-icon badge and in-app toasts. Safe to omit — consumers fall back to zero.
 */
export function ChatUnreadProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const activeRef = useRef<string | null>(null);
  const peopleRef = useRef<Map<string, string> | null>(null);
  const timerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);
  const userId = user?.id;

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const next = await fetchUnreadCounts();
      if (aliveRef.current) setCounts(next);
    } catch {
      /* badge is best-effort; the chat page surfaces real errors */
    }
  }, [userId]);

  const refresh = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void load(), 250);
  }, [load]);

  useEffect(() => {
    aliveRef.current = true;
    if (!userId) {
      setCounts(new Map());
      return;
    }
    void load();
    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [userId, load]);

  const announce = useCallback(
    async (m: ChatMessage) => {
      if (document.visibilityState !== 'visible') return; // push covers background tabs
      if (activeRef.current === m.channel_id) return;
      if (!peopleRef.current) {
        try {
          peopleRef.current = new Map((await fetchPeople()).map((p) => [p.user_id, p.name]));
        } catch {
          peopleRef.current = new Map();
        }
      }
      const who = peopleRef.current.get(m.sender_id) ?? 'New message';
      toast(`${who}: ${previewText(m.kind, m.body, null, !!m.deleted_at)}`, 'info');
    },
    [toast],
  );

  useRealtimeSubscription<Record<string, unknown>>({
    channelName: `chat-unread-msgs-${userId ?? 'anon'}`,
    table: 'chat_messages',
    event: 'INSERT',
    enabled: Boolean(userId),
    onChange: (payload) => {
      const m = payload.new as unknown as ChatMessage;
      if (!m?.id || m.sender_id === userId || m.kind === 'system') return;
      refresh();
      void announce(m);
    },
  });

  // Own read markers moving on another device (or this one) -> recount.
  useRealtimeSubscription<Record<string, unknown>>({
    channelName: `chat-unread-members-${userId ?? 'anon'}`,
    table: 'chat_members',
    event: 'UPDATE',
    enabled: Boolean(userId),
    onChange: (payload) => {
      const row = payload.new as { user_id?: string };
      if (row?.user_id === userId) refresh();
    },
  });

  const total = useMemo(() => totalUnread(counts), [counts]);

  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\)\s/, '');
    document.title = titleWithUnread(base, total);
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (total > 0) void nav.setAppBadge?.(total)?.catch?.(() => undefined);
    else void nav.clearAppBadge?.()?.catch?.(() => undefined);
    return () => {
      document.title = document.title.replace(/^\(\d+\+?\)\s/, '');
    };
  }, [total]);

  const value = useMemo<ChatUnreadValue>(
    () => ({
      counts,
      total,
      refresh,
      setActiveChannel: (id) => {
        activeRef.current = id;
      },
    }),
    [counts, total, refresh],
  );

  return <ChatUnreadContext.Provider value={value}>{children}</ChatUnreadContext.Provider>;
}

export function useChatUnread(): ChatUnreadValue {
  return useContext(ChatUnreadContext);
}
