import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowLeft, Bell, BellOff, Briefcase, Loader2, MessagesSquare } from 'lucide-react';
import { ChatComposer } from '@/components/teamchat/ChatComposer';
import { ChatLightbox } from '@/components/teamchat/ChatLightbox';
import { ChatMessageBubble } from '@/components/teamchat/ChatMessageBubble';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Skeleton } from '@/components/Skeleton';
import { useChatThread } from '@/hooks/useTeamChat';
import { getSignedUrls } from '@/lib/teamChatApi';
import { buildThread, channelTitle, receiptFor, type ChatChannel, type ChatMessage, type ChatPerson } from '@/lib/teamChat';

interface Props {
  channel: ChatChannel;
  me: string;
  peopleById: Map<string, ChatPerson>;
  /** Technicians open the field job page; office opens the dashboard one. */
  jobHref: (jobId: string) => string;
  onBack: () => void;
  onRead: () => void;
}

const NEAR_BOTTOM_PX = 96;

/** Signed URLs for every attachment in view (one batched call; refreshed when new media arrives). */
function useMediaUrls(messages: ChatMessage[]): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const key = useMemo(
    () =>
      messages
        .filter((m) => m.attachment_path && !m.deleted_at && !m.localUrl)
        .map((m) => m.attachment_path)
        .join('|'),
    [messages],
  );
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const load = () =>
      getSignedUrls(key.split('|'))
        .then((m) => alive && setUrls((prev) => new Map([...prev, ...m])))
        .catch(() => undefined);
    void load();
    const id = window.setInterval(load, 25 * 60_000); // signed for 60 min; renew well before expiry
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [key]);
  return urls;
}

export function ChatThreadPanel({ channel, me, peopleById, jobHref, onBack, onRead }: Props) {
  const thread = useChatThread({ channel, me, onRead });
  const urls = useMediaUrls(thread.messages);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const prevHeightRef = useRef(0);
  const prevLenRef = useRef(0);
  const [newBelow, setNewBelow] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ChatMessage | null>(null);

  const names = useMemo(() => new Map([...peopleById].map(([id, p]) => [id, p.name])), [peopleById]);
  const items = useMemo(() => buildThread(thread.messages), [thread.messages]);
  const title = channelTitle(channel, me, peopleById);
  const isDirect = channel.kind === 'direct';

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottomRef.current = true;
    setNewBelow(0);
  }, []);

  // New conversation -> jump to the end once it has loaded.
  useLayoutEffect(() => {
    prevLenRef.current = 0;
    atBottomRef.current = true;
    setNewBelow(0);
  }, [channel.id]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grewAtTop = thread.messages.length > prevLenRef.current && prevHeightRef.current > 0 && !atBottomRef.current && thread.loadingOlder === false;
    const last = thread.messages[thread.messages.length - 1];
    const added = thread.messages.length - prevLenRef.current;

    if (prevLenRef.current === 0 && thread.messages.length > 0) {
      scrollToBottom();
    } else if (added > 0 && last && (last.sender_id === me || atBottomRef.current)) {
      scrollToBottom(true);
    } else if (added > 0 && last && last.sender_id !== me && !atBottomRef.current && el.scrollHeight - prevHeightRef.current > 0 && !grewAtTop) {
      // paging older messages keeps the viewport anchored; a live message from someone else shows the pill
      const firstNew = thread.messages.length - added;
      if (firstNew > 0 && new Date(last.created_at).getTime() >= new Date(thread.messages[firstNew]?.created_at ?? 0).getTime()) {
        setNewBelow((n) => n + 1);
      }
    }
    prevLenRef.current = thread.messages.length;
    prevHeightRef.current = el.scrollHeight;
  }, [thread.messages, me, scrollToBottom, thread.loadingOlder]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (atBottomRef.current) setNewBelow(0);
  };

  const loadOlder = async () => {
    const el = scrollRef.current;
    const before = el?.scrollHeight ?? 0;
    await thread.loadOlder();
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - before;
    });
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-primary" aria-label={`Conversation: ${title}`}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-3 sm:px-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to conversations"
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary lg:hidden"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-text-primary">{title}</h2>
          <p className="truncate text-xs text-text-secondary">{isDirect ? 'Direct message' : 'Job chat · office & assigned technician'}</p>
        </div>
        <LiveIndicator status={thread.status} />
        {channel.kind === 'job' && channel.job_id && (
          <Link
            to={jobHref(channel.job_id)}
            className="focus-ring inline-flex h-10 items-center gap-1.5 rounded-xl border border-border px-3 text-sm font-medium text-text-primary hover:bg-bg-tertiary"
          >
            <Briefcase size={16} aria-hidden="true" /> <span className="hidden sm:inline">Open job</span>
            <span className="sr-only sm:hidden">Open job</span>
          </Link>
        )}
        <button
          type="button"
          onClick={() => void thread.toggleMute()}
          aria-pressed={thread.muted}
          aria-label={thread.muted ? 'Unmute notifications for this chat' : 'Mute notifications for this chat'}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary"
        >
          {thread.muted ? <BellOff size={18} /> : <Bell size={18} />}
        </button>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Messages"
          className="h-full overflow-y-auto overscroll-contain px-3 py-4 sm:px-5"
        >
          {thread.loading ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-10 w-2/3" />
              <Skeleton className="ml-auto h-10 w-1/2" />
              <Skeleton className="h-16 w-3/5" />
            </div>
          ) : thread.messages.length === 0 ? (
            <EmptyState
              icon={MessagesSquare}
              title="No messages yet"
              description={isDirect ? 'Say hello — they will be notified.' : 'Share updates, photos or a voice note about this job.'}
            />
          ) : (
            <>
              {thread.hasMore && (
                <div className="mb-3 flex justify-center">
                  <button
                    type="button"
                    onClick={() => void loadOlder()}
                    disabled={thread.loadingOlder}
                    className="focus-ring inline-flex items-center gap-2 rounded-full border border-border px-4 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary disabled:opacity-60"
                  >
                    {thread.loadingOlder && <Loader2 size={14} className="animate-spin" />} Load earlier messages
                  </button>
                </div>
              )}
              {items.map((it) =>
                it.type === 'day' ? (
                  <div key={it.key} className="my-4 flex justify-center">
                    <span className="rounded-full bg-bg-tertiary px-3 py-1 text-xs font-medium text-text-secondary">{it.label}</span>
                  </div>
                ) : (
                  <ChatMessageBubble
                    key={it.key}
                    message={it.message}
                    own={it.message.sender_id === me}
                    senderName={peopleById.get(it.message.sender_id)?.name ?? 'Former teammate'}
                    showSender={it.showSender}
                    endsGroup={it.endsGroup}
                    mediaUrl={it.message.attachment_path ? (urls.get(it.message.attachment_path) ?? null) : null}
                    receipt={it.message.sender_id === me ? receiptFor(it.message, thread.members) : null}
                    isDirect={isDirect}
                    names={names}
                    onOpenImage={setLightbox}
                    onRetry={thread.retry}
                    onDiscard={thread.discard}
                    onEdit={thread.edit}
                    onDelete={setToDelete}
                  />
                ),
              )}
            </>
          )}
        </div>

        {newBelow > 0 && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            className="focus-ring absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white shadow-lg"
          >
            <ArrowDown size={14} /> {newBelow} new {newBelow === 1 ? 'message' : 'messages'}
          </button>
        )}
      </div>

      {thread.error && (
        <div role="alert" className="flex items-center justify-between gap-3 bg-danger/10 px-4 py-2 text-sm text-danger">
          <span>{thread.error}</span>
          <button type="button" onClick={thread.clearError} className="focus-ring font-semibold underline">
            Dismiss
          </button>
        </div>
      )}

      <ChatComposer
        channelId={channel.id}
        disabled={thread.loading}
        onSendText={thread.send}
        onSendImage={thread.sendImage}
        onSendVoice={thread.sendVoice}
      />

      <ChatLightbox url={lightbox} onClose={() => setLightbox(null)} />
      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this message?"
        description="It will be removed for everyone in this conversation. This cannot be undone."
        confirmLabel="Delete message"
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          const target = toDelete;
          setToDelete(null);
          if (target) await thread.remove(target);
        }}
      />
    </section>
  );
}
