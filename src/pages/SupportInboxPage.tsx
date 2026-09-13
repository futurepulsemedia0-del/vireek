import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Inbox, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { useRealtimeSubscription } from '@/lib/realtime';
import { formatMessageTime, SupportConversation, SupportMessage } from '@/lib/supportChat';

export function SupportInboxPage() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<SupportConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  const loadConversations = useCallback(async () => {
    const { data } = await supabase
      .from('support_conversations')
      .select('*')
      .neq('status', 'closed')
      .order('last_message_at', { ascending: false });
    setConversations((data as SupportConversation[]) || []);
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useRealtimeSubscription<SupportConversation>({
    channelName: 'staff-support-conversations',
    table: 'support_conversations',
    event: '*',
    onChange: () => loadConversations(),
  });

  useEffect(() => {
    if (!selectedId) return;
    supabase
      .from('support_messages')
      .select('*')
      .eq('conversation_id', selectedId)
      .order('created_at', { ascending: true })
      .then(({ data }) => setMessages((data as SupportMessage[]) || []));
  }, [selectedId]);

  useRealtimeSubscription<SupportMessage>({
    channelName: `staff-messages-${selectedId ?? 'none'}`,
    table: 'support_messages',
    event: 'INSERT',
    filter: selectedId ? `conversation_id=eq.${selectedId}` : undefined,
    enabled: !!selectedId,
    onChange: (payload) => {
      const row = payload.new as SupportMessage;
      setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || !selected || !user || sending) return;
    setSending(true);
    setInput('');

    await supabase.from('support_conversations').update({ status: 'active', assigned_staff_id: user.id }).eq('id', selected.id);
    const { data } = await supabase
      .from('support_messages')
      .insert({ conversation_id: selected.id, sender_type: 'staff', sender_id: user.id, body: trimmed })
      .select('*')
      .single();
    if (data) setMessages((prev) => [...prev, data as SupportMessage]);
    setSending(false);
  };

  const handleClose = async () => {
    if (!selected) return;
    await supabase.from('support_conversations').update({ status: 'closed' }).eq('id', selected.id);
    setSelectedId(null);
  };

  return (
    <div className="flex h-screen bg-bg-primary">
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-4">
          <Inbox size={16} className="text-accent" />
          <h1 className="text-sm font-semibold text-text-primary">Live chat inbox</h1>
        </div>
        {conversations.length === 0 ? (
          <p className="p-4 text-sm text-text-secondary">No open conversations right now.</p>
        ) : (
          conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedId(c.id)}
              className={`block w-full border-b border-border/60 px-4 py-3 text-left transition-colors ${
                selectedId === c.id ? 'bg-accent/10' : 'hover:bg-bg-secondary'
              }`}
            >
              <p className="text-sm font-medium text-text-primary">{c.visitor_name || c.visitor_email || 'Anonymous visitor'}</p>
              <p className="mt-0.5 truncate text-xs text-text-secondary">{c.page_path || '—'}</p>
              <p className="mt-0.5 text-[11px] text-text-secondary/70">
                {c.status === 'open' ? 'Waiting' : 'In progress'} · {new Date(c.last_message_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </p>
            </button>
          ))
        )}
      </aside>

      <main className="flex flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">Select a conversation</div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <p className="text-sm font-semibold text-text-primary">{selected.visitor_name || selected.visitor_email || 'Anonymous visitor'}</p>
                <p className="text-xs text-text-secondary">{selected.visitor_email || 'No email provided'} · {selected.page_path}</p>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
              >
                <CheckCircle2 size={14} /> Close conversation
              </button>
            </div>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {messages.map((m) => {
                const isVisitor = m.sender_type === 'visitor';
                return (
                  <div key={m.id} className={`flex ${isVisitor ? 'justify-start' : 'justify-end'}`}>
                    <div
                      className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                        isVisitor
                          ? 'rounded-bl-sm border border-border/70 bg-bg-tertiary text-text-primary'
                          : 'rounded-br-sm bg-gradient-to-br from-accent to-accent-600 text-white'
                      }`}
                    >
                      {m.body}
                      <span className={`mt-1 block text-[10px] ${isVisitor ? 'text-text-secondary' : 'text-white/70'}`}>
                        {formatMessageTime(m.created_at)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

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
          </>
        )}
      </main>
    </div>
  );
}
