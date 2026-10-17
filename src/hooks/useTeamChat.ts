import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRealtimeSubscription, type RealtimeStatus } from '@/lib/realtime';
import {
  ChatError,
  PAGE_SIZE,
  deleteMessage,
  editMessage,
  fetchChannel,
  fetchChannels,
  fetchMembers,
  fetchMessages,
  fetchMessagesAfter,
  fetchPeople,
  markRead,
  sendMedia,
  sendText,
  setMuted,
} from '@/lib/teamChatApi';
import { prepareImage } from '@/lib/chatMedia';
import {
  latestForeignCreatedAt,
  mergeMessages,
  newClientId,
  sortChannels,
  validateAttachment,
  validateText,
  type ChatChannel,
  type ChatMember,
  type ChatMessage,
  type ChatPerson,
} from '@/lib/teamChat';
import type { VoiceResult } from '@/hooks/useVoiceRecorder';

const errText = (e: unknown, fallback: string) => (e instanceof ChatError ? e.message : fallback);

/** Conversation list + people directory, kept fresh by realtime. */
export function useChatInbox(userId: string | undefined) {
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [people, setPeople] = useState<ChatPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([fetchChannels(), fetchPeople()]);
      if (!aliveRef.current) return;
      setChannels(sortChannels(c));
      setPeople(p);
      setError(null);
    } catch (e) {
      if (aliveRef.current) setError(errText(e, 'Could not load conversations.'));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  const reload = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void load(), 300);
  }, [load]);

  useEffect(() => {
    aliveRef.current = true;
    if (userId) void load();
    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [userId, load]);

  const status = useRealtimeSubscription<Record<string, unknown>>({
    channelName: `chat-inbox-${userId ?? 'anon'}`,
    table: 'chat_channels',
    event: '*',
    enabled: Boolean(userId),
    onChange: reload,
  });

  const peopleById = useMemo(() => new Map(people.map((p) => [p.user_id, p])), [people]);

  /** Adds a channel opened via RPC immediately (realtime will confirm it). */
  const ensureChannel = useCallback(async (id: string): Promise<ChatChannel | null> => {
    const c = await fetchChannel(id);
    if (c) setChannels((prev) => sortChannels([c, ...prev.filter((x) => x.id !== c.id)]));
    return c;
  }, []);

  return { channels, people, peopleById, loading, error, status, reload, ensureChannel };
}

interface PendingSend {
  kind: 'text' | 'image' | 'voice';
  text?: string;
  blob?: Blob;
  mime?: string;
  durationMs?: number;
  path?: string;
}

/** One open conversation: paging, optimistic sends with retry, realtime, receipts. */
export function useChatThread(args: { channel: ChatChannel | null; me: string; onRead?: () => void }) {
  const { channel, me, onRead } = args;
  const channelId = channel?.id ?? null;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleTick, setVisibleTick] = useState(0);

  const pendingRef = useRef(new Map<string, PendingSend>());
  const lastMarkedRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const instance = useRef(newClientId().slice(0, 8));
  const reqRef = useRef(0);
  const prevStatus = useRef<RealtimeStatus>('connecting');

  const revoke = (m?: ChatMessage) => {
    if (m?.localUrl) URL.revokeObjectURL(m.localUrl);
  };

  // ---- load on channel change
  useEffect(() => {
    pendingRef.current.clear();
    lastMarkedRef.current = 0;
    setMessages([]);
    setMembers([]);
    setHasMore(false);
    setError(null);
    if (!channelId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const req = ++reqRef.current;
    Promise.all([fetchMessages(channelId), fetchMembers(channelId)])
      .then(([page, mem]) => {
        if (req !== reqRef.current) return;
        setMessages(page.messages);
        setHasMore(page.hasMore);
        setMembers(mem);
      })
      .catch((e) => req === reqRef.current && setError(errText(e, 'Could not load messages.')))
      .finally(() => req === reqRef.current && setLoading(false));
    return () => {
      messagesRef.current.forEach(revoke);
    };
  }, [channelId]);

  const upsert = useCallback((rows: ChatMessage[]) => setMessages((prev) => mergeMessages(prev, rows)), []);

  // ---- realtime
  const msgStatus = useRealtimeSubscription<Record<string, unknown>>({
    channelName: `chat-thread-msgs-${channelId}-${instance.current}`,
    table: 'chat_messages',
    event: '*',
    filter: channelId ? `channel_id=eq.${channelId}` : undefined,
    enabled: Boolean(channelId),
    onChange: (payload) => {
      const row = payload.new as unknown as ChatMessage;
      if (row?.id) upsert([row]);
    },
  });

  useRealtimeSubscription<Record<string, unknown>>({
    channelName: `chat-thread-members-${channelId}-${instance.current}`,
    table: 'chat_members',
    event: '*',
    filter: channelId ? `channel_id=eq.${channelId}` : undefined,
    enabled: Boolean(channelId),
    onChange: (payload) => {
      const row = payload.new as unknown as ChatMember;
      if (!row?.user_id) return;
      setMembers((prev) => [...prev.filter((m) => m.user_id !== row.user_id), row]);
    },
  });

  // ---- catch up after reconnect / tab wake / coming back online
  const catchUp = useCallback(async () => {
    if (!channelId) return;
    const confirmed = messagesRef.current.filter((m) => !m.status);
    const last = confirmed[confirmed.length - 1];
    try {
      const rows = last ? await fetchMessagesAfter(channelId, last.created_at) : (await fetchMessages(channelId)).messages;
      if (rows.length) upsert(rows);
      setMembers(await fetchMembers(channelId));
    } catch {
      /* realtime will retry; surfacing every blip would be noise */
    }
  }, [channelId, upsert]);

  useEffect(() => {
    if (prevStatus.current === 'reconnecting' && msgStatus === 'live') void catchUp();
    prevStatus.current = msgStatus;
  }, [msgStatus, catchUp]);

  useEffect(() => {
    const wake = () => {
      setVisibleTick((n) => n + 1);
      if (document.visibilityState === 'visible') void catchUp();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, [catchUp]);

  // ---- read receipts: mark read up to the newest message from someone else
  useEffect(() => {
    if (!channelId || loading) return;
    const latest = latestForeignCreatedAt(messages, me);
    if (!latest) return;
    const ms = new Date(latest).getTime();
    if (ms <= lastMarkedRef.current || document.visibilityState !== 'visible') return;
    const t = window.setTimeout(() => {
      markRead(channelId, latest)
        .then(() => {
          lastMarkedRef.current = Math.max(lastMarkedRef.current, ms);
          onReadRef.current?.();
        })
        .catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(t);
  }, [messages, channelId, me, loading, visibleTick]);

  // ---- paging
  const loadOlder = useCallback(async () => {
    if (!channelId || loadingOlder || !hasMore) return;
    const first = messagesRef.current.find((m) => !m.status);
    if (!first) return;
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(channelId, first);
      upsert(page.messages);
      setHasMore(page.hasMore);
    } catch (e) {
      setError(errText(e, 'Could not load earlier messages.'));
    } finally {
      setLoadingOlder(false);
    }
  }, [channelId, hasMore, loadingOlder, upsert]);

  // ---- sending (optimistic + idempotent retry)
  const optimistic = useCallback(
    (clientId: string, partial: Partial<ChatMessage> & Pick<ChatMessage, 'kind'>): ChatMessage => ({
      id: `local-${clientId}`,
      channel_id: channelId as string,
      sender_id: me,
      body: null,
      attachment_path: null,
      attachment_mime: null,
      attachment_bytes: null,
      voice_duration_ms: null,
      client_id: clientId,
      edited_at: null,
      deleted_at: null,
      created_at: new Date().toISOString(),
      status: 'sending',
      ...partial,
    }),
    [channelId, me],
  );

  const run = useCallback(
    async (clientId: string) => {
      const pending = pendingRef.current.get(clientId);
      if (!pending || !channel) return;
      setMessages((prev) => prev.map((m) => (m.client_id === clientId && m.sender_id === me ? { ...m, status: 'sending' } : m)));
      try {
        const saved =
          pending.kind === 'text'
            ? await sendText({ channelId: channel.id, text: pending.text ?? '', clientId, senderId: me })
            : await sendMedia({
                channel,
                senderId: me,
                kind: pending.kind,
                blob: pending.blob as Blob,
                mime: pending.mime as string,
                durationMs: pending.durationMs,
                clientId,
                path: pending.path,
              });
        pendingRef.current.delete(clientId);
        setMessages((prev) => {
          prev.filter((m) => m.client_id === clientId).forEach(revoke);
          return mergeMessages(prev, [saved]);
        });
      } catch (e) {
        setMessages((prev) => prev.map((m) => (m.client_id === clientId && m.sender_id === me ? { ...m, status: 'failed' } : m)));
        setError(errText(e, 'Message not sent.'));
      }
    },
    [channel, me],
  );

  const send = useCallback(
    (raw: string): string | null => {
      const checked = validateText(raw);
      if (!checked.ok) return checked.error;
      if (!channelId) return 'Choose a conversation first.';
      const clientId = newClientId();
      pendingRef.current.set(clientId, { kind: 'text', text: checked.text });
      setError(null);
      upsert([optimistic(clientId, { kind: 'text', body: checked.text })]);
      void run(clientId);
      return null;
    },
    [channelId, optimistic, run, upsert],
  );

  const sendImage = useCallback(
    async (file: File): Promise<string | null> => {
      if (!channel) return 'Choose a conversation first.';
      const invalid = validateAttachment(file, 'image');
      if (invalid) return invalid;
      const clientId = newClientId();
      const { blob, mime } = await prepareImage(file);
      const tooBig = validateAttachment({ type: mime, size: blob.size }, 'image');
      if (tooBig) return tooBig;
      pendingRef.current.set(clientId, { kind: 'image', blob, mime });
      setError(null);
      upsert([optimistic(clientId, { kind: 'image', attachment_mime: mime, attachment_bytes: blob.size, localUrl: URL.createObjectURL(blob) })]);
      void run(clientId);
      return null;
    },
    [channel, optimistic, run, upsert],
  );

  const sendVoice = useCallback(
    (v: VoiceResult): string | null => {
      if (!channel) return 'Choose a conversation first.';
      const invalid = validateAttachment({ type: v.mime, size: v.blob.size }, 'voice');
      if (invalid) return invalid;
      const clientId = newClientId();
      pendingRef.current.set(clientId, { kind: 'voice', blob: v.blob, mime: v.mime, durationMs: v.durationMs });
      setError(null);
      upsert([
        optimistic(clientId, {
          kind: 'voice',
          attachment_mime: v.mime,
          attachment_bytes: v.blob.size,
          voice_duration_ms: v.durationMs,
          localUrl: URL.createObjectURL(v.blob),
        }),
      ]);
      void run(clientId);
      return null;
    },
    [channel, optimistic, run, upsert],
  );

  const retry = useCallback((clientId: string) => void run(clientId), [run]);

  const discard = useCallback((clientId: string) => {
    pendingRef.current.delete(clientId);
    setMessages((prev) => {
      prev.filter((m) => m.client_id === clientId && m.status).forEach(revoke);
      return prev.filter((m) => !(m.client_id === clientId && m.status));
    });
  }, []);

  const edit = useCallback(
    async (id: string, text: string): Promise<string | null> => {
      try {
        upsert([await editMessage(id, text)]);
        return null;
      } catch (e) {
        return errText(e, 'Could not edit the message.');
      }
    },
    [upsert],
  );

  const remove = useCallback(
    async (m: ChatMessage): Promise<string | null> => {
      try {
        upsert([await deleteMessage(m)]);
        return null;
      } catch (e) {
        return errText(e, 'Could not delete the message.');
      }
    },
    [upsert],
  );

  const myMember = members.find((m) => m.user_id === me);
  const muted = Boolean(myMember?.muted);
  const toggleMute = useCallback(async () => {
    if (!channelId) return;
    const next = !muted;
    setMembers((prev) => {
      const has = prev.some((m) => m.user_id === me);
      return has
        ? prev.map((m) => (m.user_id === me ? { ...m, muted: next } : m))
        : [...prev, { channel_id: channelId, user_id: me, last_read_at: new Date(0).toISOString(), muted: next }];
    });
    try {
      await setMuted(channelId, next);
    } catch (e) {
      setMembers((prev) => prev.map((m) => (m.user_id === me ? { ...m, muted: !next } : m)));
      setError(errText(e, 'Could not change notification settings.'));
    }
  }, [channelId, me, muted]);

  useEffect(
    () => () => {
      pendingRef.current.clear();
    },
    [],
  );

  return {
    messages,
    members,
    loading,
    loadingOlder,
    hasMore,
    error,
    clearError: () => setError(null),
    status: msgStatus,
    muted,
    send,
    sendImage,
    sendVoice,
    retry,
    discard,
    edit,
    remove,
    loadOlder,
    toggleMute,
    pageSize: PAGE_SIZE,
  };
}
