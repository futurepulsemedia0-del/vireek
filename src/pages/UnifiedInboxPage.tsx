import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Send, Inbox as InboxIcon, MessageSquare, Phone as PhoneIcon, Mail, MessageCircle, ExternalLink } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  Channel,
  UnifiedConversation,
  UnifiedMessage,
  fetchConversations,
  fetchMessages,
  findLinkedCustomerId,
  formatMessageTime,
  messagesTableFor,
  sendReply,
} from '@/lib/unifiedInbox';

const CHANNEL_META: Record<Channel, { label: string; icon: typeof MessageSquare }> = {
  whatsapp: { label: 'WhatsApp', icon: MessageCircle },
  instagram: { label: 'Instagram', icon: MessageCircle },
  sms: { label: 'SMS', icon: PhoneIcon },
  email: { label: 'Email', icon: Mail },
  chat: { label: 'Site chat', icon: MessageSquare },
};

const FILTER_TABS: Array<{ key: 'all' | Channel; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'sms', label: 'SMS' },
  { key: 'email', label: 'Email' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'chat', label: 'Site chat' },
];

export function UnifiedInboxPage() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<UnifiedConversation[]>([]);
  const [filter, setFilter] = useState<'all' | Channel>('all');
  const [selected, setSelected] = useState<UnifiedConversation | null>(null);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [linkedCustomerId, setLinkedCustomerId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setConversations(await fetchConversations());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A new message on any channel can only ever change the conversation
  // list's ordering/unread state, never its shape — so every channel's
  // realtime event just triggers the same lightweight refetch. Four
  // explicit calls (not a loop) since hooks must run the same number of
  // times, in the same order, on every render.
  useRealtimeSubscription({ channelName: 'unified-inbox-dm', table: 'dm_messages', event: 'INSERT', onChange: () => load() });
  useRealtimeSubscription({ channelName: 'unified-inbox-sms', table: 'sms_messages', event: 'INSERT', onChange: () => load() });
  useRealtimeSubscription({ channelName: 'unified-inbox-email', table: 'email_messages', event: 'INSERT', onChange: () => load() });
  useRealtimeSubscription({ channelName: 'unified-inbox-chat', table: 'support_messages', event: 'INSERT', onChange: () => load() });

  const filtered = useMemo(
    () => (filter === 'all' ? conversations : conversations.filter((c) => c.channel === filter)),
    [conversations, filter],
  );

  const openConversation = async (conversation: UnifiedConversation) => {
    setSelected(conversation);
    setSendError(null);
    setLinkedCustomerId(null);
    setMessages(await fetchMessages(conversation.channel, conversation.id));
    setLinkedCustomerId(await findLinkedCustomerId(conversation.customerContact));
    setConversations((prev) => prev.map((c) => (c.id === conversation.id ? { ...c, unread: false } : c)));
  };

  useRealtimeSubscription({
    channelName: `unified-inbox-thread-${selected?.id ?? 'none'}`,
    table: selected ? messagesTableFor(selected.channel) : 'dm_messages',
    event: 'INSERT',
    filter: selected ? `conversation_id=eq.${selected.id}` : undefined,
    enabled: !!selected,
    onChange: async () => {
      if (selected) setMessages(await fetchMessages(selected.channel, selected.id));
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || !selected || !user || sending) return;
    setSending(true);
    setSendError(null);
    const result = await sendReply(selected.channel, selected.id, trimmed, user.id);
    if (result.ok) {
      setInput('');
      setMessages(await fetchMessages(selected.channel, selected.id));
    } else {
      setSendError(result.error ?? 'Send failed');
    }
    setSending(false);
  };

  const canReply = selected && selected.channel !== 'whatsapp' && selected.channel !== 'instagram';

  return (
    <DashboardLayout activeLabel="Inbox">
      <div className="flex h-[calc(100vh-4rem)] bg-bg-primary">
        <aside className="w-80 shrink-0 overflow-y-auto border-r border-border">
          <div className="flex items-center gap-2 border-b border-border px-4 py-4">
            <InboxIcon size={16} className="text-accent" />
            <h1 className="text-sm font-semibold text-text-primary">Inbox</h1>
          </div>
          <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2.5">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilter(tab.key)}
                className={`focus-ring rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                  filter === tab.key ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary hover:text-text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {filtered.length === 0 ? (
            <p className="p-4 text-sm text-text-secondary">No conversations here yet.</p>
          ) : (
            filtered.map((c) => {
              const Icon = CHANNEL_META[c.channel].icon;
              return (
                <button
                  key={`${c.channel}-${c.id}`}
                  type="button"
                  onClick={() => openConversation(c)}
                  className={`block w-full border-b border-border/60 px-4 py-3 text-left transition-colors ${
                    selected?.id === c.id ? 'bg-accent/10' : 'hover:bg-bg-secondary'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-text-primary">{c.customerLabel}</p>
                    {c.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
                  </div>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-text-secondary">
                    <Icon size={12} /> {CHANNEL_META[c.channel].label}
                    {c.subject ? ` · ${c.subject}` : ''}
                  </p>
                  <p className="mt-0.5 text-[11px] text-text-secondary/70">{formatMessageTime(c.lastMessageAt)}</p>
                </button>
              );
            })
          )}
        </aside>

        <main className="flex flex-1 flex-col">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">Select a conversation</div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <div>
                  <p className="text-sm font-semibold text-text-primary">{selected.customerLabel}</p>
                  <p className="text-xs text-text-secondary">
                    {CHANNEL_META[selected.channel].label} · {selected.customerContact}
                  </p>
                </div>
                {linkedCustomerId && (
                  <Link
                    to={`/dashboard/customers/${linkedCustomerId}`}
                    className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
                  >
                    View customer <ExternalLink size={13} />
                  </Link>
                )}
              </div>

              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === 'inbound' ? 'justify-start' : 'justify-end'}`}>
                    <div
                      className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                        m.direction === 'inbound'
                          ? 'rounded-bl-sm border border-border/70 bg-bg-tertiary text-text-primary'
                          : 'rounded-br-sm bg-gradient-to-br from-accent to-accent-600 text-white'
                      }`}
                    >
                      {m.body}
                      <span className={`mt-1 block text-[10px] ${m.direction === 'inbound' ? 'text-text-secondary' : 'text-white/70'}`}>
                        {formatMessageTime(m.createdAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {sendError && <p className="px-5 pb-1 text-xs text-red-500">{sendError}</p>}

              {canReply ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSend();
                  }}
                  className="flex items-center gap-2 border-t border-border p-3"
                >
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Reply…"
                    className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
                  />
                  <button
                    type="submit"
                    disabled={!input.trim() || sending}
                    className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white disabled:opacity-40"
                  >
                    <Send size={16} />
                  </button>
                </form>
              ) : (
                <p className="border-t border-border p-3 text-center text-xs text-text-secondary">
                  Replying from the inbox isn't available for this channel yet.
                </p>
              )}
            </>
          )}
        </main>
      </div>
    </DashboardLayout>
  );
}
