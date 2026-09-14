import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { MessageCircle, X, Send, Mail } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { ensureVisitorSession, formatMessageTime, SupportConversation, SupportMessage } from '@/lib/supportChat';
import { getSupportStatus, SUPPORT_HOURS_LABEL } from '@/lib/supportHours';
import { useRealtimeSubscription } from '@/lib/realtime';
import { OnlineDot } from '@/components/chat/ChatVisuals';

export function LiveChatWidget() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(() => getSupportStatus());
  const [conversation, setConversation] = useState<SupportConversation | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [visitorId, setVisitorId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const openHandler = () => setOpen(true);
    window.addEventListener('vireek:open-live-chat', openHandler);
    return () => window.removeEventListener('vireek:open-live-chat', openHandler);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setStatus(getSupportStatus()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!open || visitorId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const uid = await ensureVisitorSession();
        if (cancelled) return;
        setVisitorId(uid);

        const { data: existing } = await supabase
          .from('support_conversations')
          .select('*')
          .eq('visitor_id', uid)
          .neq('status', 'closed')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existing) {
          setConversation(existing as SupportConversation);
          const { data: history } = await supabase
            .from('support_messages')
            .select('*')
            .eq('conversation_id', existing.id)
            .order('created_at', { ascending: true });
          setMessages((history as SupportMessage[]) || []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, visitorId]);

  useRealtimeSubscription<SupportMessage>({
    channelName: `support-messages-${conversation?.id ?? 'none'}`,
    table: 'support_messages',
    event: 'INSERT',
    filter: conversation ? `conversation_id=eq.${conversation.id}` : undefined,
    enabled: !!conversation,
    onChange: (payload) => {
      const row = payload.new as SupportMessage;
      setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
    },
  });

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setSending(true);
      setInput('');

      try {
        let convo = conversation;
        const uid = visitorId ?? (await ensureVisitorSession());

        if (!convo) {
          const { data, error } = await supabase
            .from('support_conversations')
            .insert({
              visitor_id: uid,
              visitor_name: name.trim() || null,
              visitor_email: email.trim() || null,
              page_path: location.pathname,
            })
            .select('*')
            .single();
          if (error || !data) throw error;
          convo = data as SupportConversation;
          setConversation(convo);
        }

        const { data: msg, error: msgError } = await supabase
          .from('support_messages')
          .insert({ conversation_id: convo.id, sender_type: 'visitor', sender_id: uid, body: trimmed })
          .select('*')
          .single();
        if (msgError) throw msgError;
        setMessages((prev) => [...prev, msg as SupportMessage]);
      } catch {
        setInput(trimmed);
      } finally {
        setSending(false);
      }
    },
    [conversation, visitorId, name, email, location.pathname, sending],
  );

  if (location.pathname.startsWith('/dashboard') || location.pathname.startsWith('/staff')) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.97 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-5 right-5 z-50 flex h-[min(560px,calc(100dvh-120px))] min-h-[320px] w-[384px] max-w-[92vw] flex-col overflow-hidden rounded-3xl border border-border bg-bg-secondary/95 shadow-card-hover backdrop-blur-xl dark:shadow-card-hover-dark"
          role="dialog"
          aria-modal="true"
          aria-label="Chat with our team"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border/80 bg-gradient-to-b from-bg-secondary to-bg-secondary/60 px-5 py-4">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                Vireek team
                <OnlineDot online={status.online} />
              </p>
              <p className="truncate text-xs text-text-secondary">
                {status.online ? 'A real person, online now' : `Offline — back ${SUPPORT_HOURS_LABEL}`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {loading ? (
              <div className="space-y-2">
                <div className="h-10 w-2/3 animate-pulse rounded-2xl bg-bg-tertiary" />
                <div className="ml-auto h-10 w-1/2 animate-pulse rounded-2xl bg-bg-tertiary" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex items-start gap-2.5 text-sm text-text-secondary">
                <MessageCircle size={16} className="mt-0.5 shrink-0 text-accent" />
                <p>
                  {status.online
                    ? "Hi! Tell us what you need help with and someone on our team will jump in."
                    : `We're offline right now (${SUPPORT_HOURS_LABEL}) — leave a message and we'll reply by email.`}
                </p>
              </div>
            ) : null}

            {messages.map((m) => {
              const isVisitor = m.sender_type === 'visitor';
              return (
                <div key={m.id} className={`flex ${isVisitor ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                      isVisitor
                        ? 'rounded-br-sm bg-gradient-to-br from-accent to-accent-600 text-white'
                        : 'rounded-bl-sm border border-border/70 bg-bg-tertiary text-text-primary'
                    }`}
                  >
                    {m.body}
                    <span className={`mt-1 block text-[10px] ${isVisitor ? 'text-white/70' : 'text-text-secondary'}`}>
                      {formatMessageTime(m.created_at)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {!conversation && !status.online && (
            <div className="border-t border-border/80 px-4 pt-3">
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <Mail size={12} />
                <span>Leave your details so we can reply</span>
              </div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              />
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 border-t border-border/80 p-3"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={status.online ? 'Type a message…' : 'Leave a message…'}
              className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
            />
            <button
              type="submit"
              disabled={!input.trim() || sending}
              aria-label="Send"
              className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/30 bg-gradient-to-br from-[#3448E8] to-[#D6582A] text-white transition-opacity disabled:opacity-40"
            >
              <Send size={16} />
            </button>
          </form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
