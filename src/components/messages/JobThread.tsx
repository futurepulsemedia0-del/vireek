import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, MessageSquare, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useRealtimeSubscription } from '@/lib/realtime';
import { LiveIndicator } from '@/components/LiveIndicator';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { MessageBubble, type DeliveryState } from '@/components/messages/MessageBubble';
import { MessageComposer } from '@/components/messages/MessageComposer';
import type { RecordedClip } from '@/hooks/useVoiceRecorder';
import {
  dayLabel, fetchMessages, getSignedUrls, markThreadRead, mergeMessages, newClientId, sendAudioMessage,
  sendPhotoMessage, sendTextMessage, shouldShowDayDivider, validatePhoto, type JobMessage, type SenderRole,
} from '@/lib/jobMessages';

interface Props {
  jobId: string;
  viewer: SenderRole;
}

type LoadState = 'loading' | 'ready' | 'error';

export function JobThread({ jobId, viewer }: Props) {
  const [messages, setMessages] = useState<JobMessage[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [unseen, setUnseen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<Map<string, () => Promise<JobMessage>>>(new Map());
  const requestedUrls = useRef<Set<string>>(new Set());
  const stickRef = useRef(true);
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = userId;

  const isNearBottom = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setUnseen(false);
  }, []);

  const load = useCallback(async () => {
    try {
      const [{ messages: page, hasMore: more }, owner, auth] = await Promise.all([
        fetchMessages(jobId),
        supabase.rpc('get_account_owner_id'),
        supabase.auth.getUser(),
      ]);
      setOwnerId((owner.data as string | null) ?? null);
      setUserId(auth.data.user?.id ?? null);
      setMessages((prev) => {
        if (prev.length === 0) setHasMore(more);
        return mergeMessages(prev, page);
      });
      setLoadState('ready');
      void markThreadRead(jobId);
    } catch {
      setLoadState((s) => (s === 'ready' ? s : 'error'));
    }
  }, [jobId]);

  useEffect(() => {
    setLoadState('loading');
    setMessages([]);
    requestedUrls.current = new Set();
    void load();
  }, [load]);

  // Realtime: append incoming rows; refetch after a dropped connection to close any gap.
  const wasDropped = useRef(false);
  const status = useRealtimeSubscription<Record<string, unknown>>({
    channelName: `job-messages-${jobId}`,
    table: 'job_messages',
    event: 'INSERT',
    filter: `job_id=eq.${jobId}`,
    enabled: loadState === 'ready',
    onChange: (payload) => {
      const row = payload.new as unknown as JobMessage;
      if (!row?.id) return;
      stickRef.current = isNearBottom();
      setMessages((prev) => mergeMessages(prev, [row]));
      if (row.sender_user_id !== userIdRef.current) {
        void markThreadRead(jobId);
        if (!stickRef.current) setUnseen(true);
      }
    },
  });
  useEffect(() => {
    if (status === 'live' && wasDropped.current) void load();
    wasDropped.current = status === 'reconnecting';
  }, [status, load]);

  // Signed URLs for any media we haven't resolved yet.
  useEffect(() => {
    const missing = messages.map((m) => m.media_path).filter((p): p is string => !!p && !requestedUrls.current.has(p) && !p.startsWith('local:'));
    if (missing.length === 0) return;
    missing.forEach((p) => requestedUrls.current.add(p));
    getSignedUrls(missing)
      .then((map) => setUrls((prev) => ({ ...prev, ...map })))
      .catch(() => missing.forEach((p) => requestedUrls.current.delete(p)));
  }, [messages]);

  // Keep pinned to the newest message when appropriate.
  useEffect(() => {
    if (loadState === 'ready' && stickRef.current) scrollToBottom(messages.length > 1);
  }, [messages, loadState, scrollToBottom]);

  // ----- sending (optimistic, retryable, idempotent via client_id) -----
  function track(clientId: string, optimistic: JobMessage, run: () => Promise<JobMessage>) {
    stickRef.current = true;
    retryRef.current.set(clientId, run);
    setFailed((s) => { const n = new Set(s); n.delete(clientId); return n; });
    setPending((s) => new Set(s).add(clientId));
    setMessages((prev) => mergeMessages(prev, [optimistic]));
    run()
      .then((saved) => {
        retryRef.current.delete(clientId);
        setMessages((prev) => mergeMessages(prev, [saved]));
      })
      .catch(() => setFailed((s) => new Set(s).add(clientId)))
      .finally(() => setPending((s) => { const n = new Set(s); n.delete(clientId); return n; }));
  }

  function optimisticBase(clientId: string, kind: JobMessage['kind']): JobMessage {
    return {
      id: `local-${clientId}`, job_id: jobId, sender_user_id: userId ?? '', sender_role: viewer, kind,
      body: null, media_path: null, media_mime: null, media_duration_ms: null, client_id: clientId,
      created_at: new Date().toISOString(),
    };
  }

  function handleText(body: string) {
    const id = newClientId();
    track(id, { ...optimisticBase(id, 'text'), body }, () => sendTextMessage(jobId, body, id));
  }

  function handlePhoto(file: File) {
    const problem = validatePhoto(file);
    if (problem) return setNotice(problem);
    if (!ownerId) return setNotice('Still connecting — try again in a moment.');
    const id = newClientId();
    const preview = URL.createObjectURL(file);
    setUrls((u) => ({ ...u, [`local:${id}`]: preview }));
    track(id, { ...optimisticBase(id, 'photo'), media_path: `local:${id}` }, () => sendPhotoMessage(ownerId, jobId, file, id));
  }

  function handleAudio(clip: RecordedClip) {
    if (!ownerId) return setNotice('Still connecting — try again in a moment.');
    const id = newClientId();
    const preview = URL.createObjectURL(clip.blob);
    setUrls((u) => ({ ...u, [`local:${id}`]: preview }));
    track(id, { ...optimisticBase(id, 'audio'), media_path: `local:${id}`, media_duration_ms: clip.durationMs },
      () => sendAudioMessage(ownerId, jobId, clip.blob, clip.durationMs, id));
  }

  function handleRetry(clientId: string) {
    const run = retryRef.current.get(clientId);
    const base = messages.find((m) => m.client_id === clientId);
    if (run && base) track(clientId, base, run);
  }

  async function loadOlder() {
    if (!messages.length) return;
    const oldest = messages.find((m) => !m.id.startsWith('local-'));
    if (!oldest) return;
    setLoadingMore(true);
    stickRef.current = false;
    try {
      const { messages: older, hasMore: more } = await fetchMessages(jobId, oldest.created_at);
      setMessages((prev) => mergeMessages(prev, older));
      setHasMore(more);
    } catch {
      setNotice('Could not load earlier messages.');
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setLightbox(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const deliveryOf = (m: JobMessage): DeliveryState =>
    m.client_id && failed.has(m.client_id) ? 'failed' : m.id.startsWith('local-') || (m.client_id && pending.has(m.client_id)) ? 'sending' : 'sent';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-end px-4 pt-2"><LiveIndicator status={status} /></div>

      <div
        ref={scrollRef}
        onScroll={() => { stickRef.current = isNearBottom(); if (stickRef.current) setUnseen(false); }}
        className="relative min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3"
        role="log"
        aria-live="polite"
        aria-label="Job messages"
      >
        {loadState === 'loading' && (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="ml-auto h-10 w-1/2" />
            <Skeleton className="h-24 w-3/4" />
          </div>
        )}

        {loadState === 'error' && (
          <EmptyState
            icon={MessageSquare}
            title="Couldn't load messages"
            description="Check your connection and try again."
            action={{ label: 'Retry', onClick: () => { setLoadState('loading'); void load(); } }}
          />
        )}

        {loadState === 'ready' && messages.length === 0 && (
          <EmptyState icon={MessageSquare} title="Start the conversation" description="Send a message, photo, or voice note — the office sees it instantly." />
        )}

        {loadState === 'ready' && hasMore && (
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" onClick={loadOlder} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load earlier messages'}</Button>
          </div>
        )}

        {loadState === 'ready' && messages.map((m, i) => (
          <div key={m.client_id ?? m.id}>
            {shouldShowDayDivider(messages[i - 1], m) && (
              <div className="my-2 text-center text-[11px] font-medium uppercase tracking-wide text-text-secondary">{dayLabel(m.created_at)}</div>
            )}
            <MessageBubble
              message={m}
              viewer={viewer}
              mediaUrl={m.media_path ? urls[m.media_path] : undefined}
              delivery={deliveryOf(m)}
              onOpenPhoto={setLightbox}
              onRetry={handleRetry}
            />
          </div>
        ))}
      </div>

      {unseen && (
        <button
          type="button"
          onClick={() => { stickRef.current = true; scrollToBottom(); }}
          className="focus-ring mx-auto -mt-10 mb-2 inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" /> New messages
        </button>
      )}

      {notice && <p role="alert" className="px-4 pb-1 text-xs text-danger">{notice}</p>}

      <MessageComposer disabled={loadState !== 'ready'} onSendText={handleText} onSendPhoto={handlePhoto} onSendAudio={handleAudio} />

      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" role="dialog" aria-modal="true" aria-label="Photo" onClick={() => setLightbox(null)}>
          <button type="button" className="focus-ring absolute right-4 top-[max(1rem,env(safe-area-inset-top))] rounded-full bg-white/10 p-2 text-white" onClick={() => setLightbox(null)} aria-label="Close photo">
            <X className="h-6 w-6" />
          </button>
          <img src={lightbox} alt="Job photo, full size" className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </div>
  );
}
