import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { HelpCircle, X, Send } from 'lucide-react';
import { streamAiChat } from '@/lib/aiStream';
import { ChatAvatar, MessageBubble, OnlineDot, StarterPromptChip, TypingIndicator } from '@/components/chat/ChatVisuals';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  isError?: boolean;
  streaming?: boolean;
}

const STARTER_PROMPTS = [
  'How much does Vireek cost?',
  'Which trades/industries do you support?',
  'How does emergency detection work?',
  'Is my business data secure?',
];

/**
 * Floating, site-wide "Ask Vireek" help widget — for any visitor stuck or
 * curious on a marketing page (pricing, features, industries, FAQ, etc.),
 * not just the homepage "Talk to Sarah" receptionist demo. No login
 * required; calls the public `site-assistant` Edge Function, which routes
 * through the Vireek AI Core (task: "general") grounded in
 * supabase/functions/_shared/ai-core/knowledge.ts.
 *
 * The reply streams in live (see `@/lib/aiStream`) — tokens land in the
 * bubble as the model produces them, with a blinking caret at the end,
 * instead of the widget sitting idle until a full answer is ready.
 *
 * Visuals come from `@/components/chat/ChatVisuals` — the same avatar,
 * bubble, and thinking/streaming language used by `AiAssistant` (dashboard)
 * and the "Talk to Sarah" demo, so every chat surface on the site reads
 * as one considered system instead of three different widgets.
 *
 * Mounted once, globally, in main.tsx (same pattern as
 * `AccessibilityWidget`) and hides itself on `/dashboard/*` routes, since
 * logged-in users already have the account-aware `AiAssistant` there —
 * this one only ever answers from public product knowledge, never
 * account data.
 *
 * Positioning + sizing: same bottom-right rail as `AccessibilityWidget`
 * and `AiAssistant` — the 48px / rounded-2xl launcher below matches
 * `AccessibilityWidget`'s own button exactly (h-12 w-12, rounded-2xl,
 * 20px icon) instead of the old oversized 56px circular one, so the two
 * stacked buttons read as one deliberate size system rather than two
 * different components. `bottom-[84px]` keeps a clean ~16px gap above
 * `AccessibilityWidget` (`bottom-5`, 48px tall → top edge at 68px).
 */
export function SiteAssistant() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (location.pathname.startsWith('/dashboard')) return null;

  const ask = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || thinking) return;

    const history = messages.map((m) => ({ role: m.role, content: m.text }));

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text: trimmed }]);
    setInput('');
    setThinking(true);

    const assistantId = crypto.randomUUID();
    let started = false;
    const controller = new AbortController();
    abortRef.current = controller;

    await streamAiChat({
      functionName: 'site-assistant',
      message: trimmed,
      history,
      signal: controller.signal,
      onDelta: (delta) => {
        if (!started) {
          started = true;
          setThinking(false);
          setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', text: delta, streaming: true }]);
        } else {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m)),
          );
        }
      },
      onDone: () => {
        setThinking(false);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
      },
      onError: (message) => {
        setThinking(false);
        setMessages((prev) => {
          if (started) {
            return prev.map((m) => (m.id === assistantId ? { ...m, text: message, isError: true, streaming: false } : m));
          }
          return [...prev, { id: assistantId, role: 'assistant', text: message, isError: true }];
        });
      },
    });
  };

  return (
    <>
      <motion.button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        aria-label={open ? 'Close help assistant' : 'Ask Vireek a question'}
        aria-expanded={open}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className="fixed bottom-[84px] right-5 z-40 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-accent to-cta text-white shadow-lg shadow-accent/30 transition-all duration-200 hover:shadow-xl hover:shadow-accent/40 hover:brightness-110 print:hidden"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={open ? 'close' : 'open'}
            initial={{ opacity: 0, rotate: -90, scale: 0.6 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 90, scale: 0.6 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center justify-center"
          >
            {open ? <X size={20} /> : <HelpCircle size={20} />}
          </motion.span>
        </AnimatePresence>

        {!open && (
          <span className="absolute right-0.5 top-0.5 flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cta opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full border-2 border-white bg-cta" />
          </span>
        )}

        <AnimatePresence>
          {showTooltip && !open && (
            <motion.span
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.15 }}
              className="pointer-events-none absolute right-14 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg border border-black/10 bg-[#15161c] px-3 py-1.5 text-xs font-medium text-white shadow-lg shadow-black/30 dark:border-white/10 dark:bg-[#0a0a0d]"
            >
              Ask Vireek
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed bottom-[144px] right-5 z-40 flex h-[min(560px,calc(100dvh-240px))] min-h-[320px] w-[384px] max-w-[92vw] flex-col overflow-hidden rounded-3xl border border-border bg-bg-secondary/95 shadow-card-hover backdrop-blur-xl dark:shadow-card-hover-dark"
            role="dialog"
            aria-modal="true"
            aria-label="Ask Vireek"
          >
            <div className="flex items-center gap-3 border-b border-border/80 bg-gradient-to-b from-bg-secondary to-bg-secondary/60 px-5 py-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-cta text-white shadow-sm">
                <HelpCircle size={17} strokeWidth={2.25} />
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                  Ask Vireek
                  <OnlineDot />
                </p>
                <p className="truncate text-xs text-text-secondary">Pricing, features, industries — anything</p>
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              {messages.length === 0 && (
                <div className="space-y-2.5">
                  <div className="flex items-end gap-2.5">
                    <ChatAvatar role="assistant" />
                    <div className="max-w-[78%] rounded-2xl rounded-bl-sm border border-border/70 bg-bg-tertiary px-4 py-2.5 text-sm leading-relaxed text-text-primary">
                      Hi! I'm the Vireek help assistant — ask me anything about pricing, features, or how it works.
                    </div>
                  </div>
                  <p className="pl-11 text-xs font-medium text-text-secondary">Try asking:</p>
                  <div className="space-y-2 pl-11">
                    {STARTER_PROMPTS.map((p) => (
                      <StarterPromptChip key={p} label={p} onClick={() => ask(p)} />
                    ))}
                  </div>
                </div>
              )}

              {messages.map((m) => (
                <MessageBubble key={m.id} role={m.role} isError={m.isError} streaming={m.streaming}>
                  {m.text}
                </MessageBubble>
              ))}

              {thinking && <TypingIndicator />}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
              className="flex items-center gap-2 border-t border-border/80 p-3"
            >
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask anything about Vireek…"
                className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
              />
              <motion.button
                type="submit"
                disabled={!input.trim() || thinking}
                aria-label="Send"
                whileHover={input.trim() && !thinking ? { scale: 1.06 } : undefined}
                whileTap={input.trim() && !thinking ? { scale: 0.94 } : undefined}
                className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-cta text-white transition-opacity disabled:opacity-40"
              >
                <Send size={16} />
              </motion.button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
