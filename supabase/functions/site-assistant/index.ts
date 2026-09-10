import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { HelpCircle, X, Send, Sparkles } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  isError?: boolean;
}

const STARTER_PROMPTS = [
  'How much does Vireek cost?',
  'Which trades/industries do you support?',
  'How does emergency detection work?',
  'Is my business data secure?',
];

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-bg-tertiary px-4 py-3">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-secondary/60"
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </div>
  );
}

/**
 * Floating, site-wide "Ask Vireek" help widget — for any visitor stuck or
 * curious on a marketing page (pricing, features, industries, FAQ, etc.),
 * not just the homepage "Talk to Sarah" receptionist demo. No login
 * required; calls the public `site-assistant` Edge Function, which routes
 * through the Vireek AI Core (task: "general") grounded in
 * supabase/functions/_shared/ai-core/knowledge.ts.
 *
 * Mounted once, globally, in main.tsx (same pattern as
 * `AccessibilityWidget`) and hides itself on `/dashboard/*` routes, since
 * logged-in users already have the account-aware `AiAssistant` there —
 * this one only ever answers from public product knowledge, never
 * account data.
 *
 * Positioning: same bottom-right rail as `AiAssistant` (which never
 * renders here, since dashboard routes are excluded) — `bottom-[92px]`
 * for the button keeps a clear gap above `AccessibilityWidget`
 * (`bottom-5`, ~48px), matching that widget's own spacing convention.
 */
export function SiteAssistant() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  if (location.pathname.startsWith('/dashboard')) return null;

  const ask = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || thinking) return;

    const nextMessages: ChatMessage[] = [
      ...messages,
      { id: crypto.randomUUID(), role: 'user', text: trimmed },
    ];
    setMessages(nextMessages);
    setInput('');
    setThinking(true);

    try {
      const { data, error } = await supabase.functions.invoke('site-assistant', {
        body: {
          message: trimmed,
          history: nextMessages.slice(0, -1).map((m) => ({ role: m.role, content: m.text })),
        },
      });

      if (error) throw error;
      if (data?.error) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'assistant', text: data.error, isError: true },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'assistant', text: data?.reply ?? "Sorry, could you rephrase that?" },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: "I'm having trouble responding right now — please try again in a moment, or use the Contact page.",
          isError: true,
        },
      ]);
    } finally {
      setThinking(false);
    }
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
        className="fixed bottom-[92px] right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-accent to-cta text-white shadow-glow-accent print:hidden"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={open ? 'close' : 'open'}
            initial={{ opacity: 0, rotate: -45 }}
            animate={{ opacity: 1, rotate: 0 }}
            exit={{ opacity: 0, rotate: 45 }}
            transition={{ duration: 0.15 }}
          >
            {open ? <X size={22} /> : <HelpCircle size={22} />}
          </motion.span>
        </AnimatePresence>

        <AnimatePresence>
          {showTooltip && !open && (
            <motion.span
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.15 }}
              className="pointer-events-none absolute right-16 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg border border-border bg-bg-secondary/95 px-3 py-1.5 text-xs font-medium text-text-primary shadow-lg backdrop-blur-xl"
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
            className="fixed bottom-[164px] right-5 z-40 flex h-[520px] w-[380px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
            role="dialog"
            aria-modal="true"
            aria-label="Ask Vireek"
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ai/10 text-ai">
                <Sparkles size={16} />
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">Ask Vireek</p>
                <p className="text-xs text-text-secondary">Pricing, features, industries — anything about the product</p>
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-text-secondary">Stuck on something? Try asking:</p>
                  {STARTER_PROMPTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => ask(p)}
                      className="focus-ring block w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-left text-sm text-text-primary transition-colors hover:border-accent/30 hover:bg-accent/5"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}

              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      m.role === 'user'
                        ? 'rounded-br-sm bg-accent text-white'
                        : `rounded-bl-sm ${m.isError ? 'bg-danger/10 text-danger' : 'bg-bg-tertiary text-text-primary'}`
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}

              {thinking && (
                <div className="flex justify-start">
                  <TypingIndicator />
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
              className="flex items-center gap-2 border-t border-border p-3"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask anything about Vireek…"
                className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
              />
              <button
                type="submit"
                disabled={!input.trim() || thinking}
                aria-label="Send"
                className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition-opacity disabled:opacity-40"
              >
                <Send size={16} />
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
