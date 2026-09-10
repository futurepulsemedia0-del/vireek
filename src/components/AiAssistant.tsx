import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MessageCircle, X, Send } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { MessageBubble, OnlineDot, StarterPromptChip, TypingIndicator } from '@/components/chat/ChatVisuals';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  rows?: Record<string, unknown>[];
  columns?: string[];
  isError?: boolean;
}

const STARTER_PROMPTS = [
  'How many calls did I get this week?',
  'Which service type gets the most emergency calls?',
  "Show me leads that haven't been contacted yet",
  'What jobs are scheduled today?',
];

function ResultTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  if (!rows.length) return null;
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-border/80">
      <table className="w-full text-left text-xs">
        <thead className="bg-bg-tertiary/60">
          <tr>
            {columns.map((c) => (
              <th key={c} className="whitespace-nowrap px-2.5 py-1.5 font-semibold text-text-secondary">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((row, i) => (
            <tr key={i} className="border-t border-border/60">
              {columns.map((c) => (
                <td key={c} className="whitespace-nowrap px-2.5 py-1.5 text-text-primary">
                  {String(row[c] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Floating AI Assistant — rendered once from DashboardLayout so it appears
 * consistently on every /dashboard/* page without every page needing to
 * know about it.
 *
 * Visuals come from `@/components/chat/ChatVisuals` — the same avatar,
 * bubble, and typing-indicator language used by the site-wide `SiteAssistant`
 * and the "Talk to Sarah" demo, so every chat surface on the site reads as
 * one considered system rather than three different widgets.
 *
 * Positioning note: `AccessibilityWidget` (mounted globally in main.tsx) is
 * also a fixed bottom-right button, at `bottom-5 right-5` (48px). This
 * button used to sit at `bottom-6 right-6` (56px) — nearly the exact same
 * spot — so on every dashboard page the two buttons rendered stacked
 * directly on top of each other. This version sits higher up the same
 * right-hand rail, aligned to the same right edge (`right-5`) with a clear
 * ~24px gap above the accessibility button, and gets its own tooltip so
 * it reads as a deliberate stack rather than a collision. If the
 * accessibility button's offsets ever change, keep this one's `bottom`
 * value at least (accessibility button height + gap) above it.
 */
export function AiAssistant() {
  const [open, setOpen] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const ask = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || thinking) return;

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text: trimmed }]);
    setInput('');
    setThinking(true);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const { data, error } = await supabase.functions.invoke('ai-assistant-query', {
        body: { question: trimmed },
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      if (error) throw error;

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: data?.answer ?? "I couldn't find an answer to that — try rephrasing.",
          rows: data?.rows ?? [],
          columns: data?.columns ?? [],
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: "I couldn't find an answer to that — try rephrasing.",
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
        aria-label={open ? 'Close AI Assistant' : 'Open AI Assistant'}
        aria-expanded={open}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
        className="fixed bottom-[92px] right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-accent to-cta text-white shadow-glow-accent print:hidden"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={open ? 'close' : 'open'}
            initial={{ opacity: 0, rotate: -90, scale: 0.6 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 90, scale: 0.6 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            {open ? <X size={22} /> : <MessageCircle size={22} />}
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
              Ask your data
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
            className="fixed bottom-[164px] right-5 z-40 flex h-[560px] w-[390px] max-w-[92vw] flex-col overflow-hidden rounded-3xl border border-border bg-bg-secondary/95 shadow-card-hover backdrop-blur-xl dark:shadow-card-hover-dark"
            role="dialog"
            aria-modal="true"
            aria-label="AI Assistant"
          >
            <div className="flex items-center gap-3 border-b border-border/80 bg-gradient-to-b from-bg-secondary to-bg-secondary/60 px-5 py-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-cta text-white shadow-sm">
                <MessageCircle size={17} strokeWidth={2.25} />
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                  Ask your data
                  <OnlineDot />
                </p>
                <p className="truncate text-xs text-text-secondary">Answers come from your own account only</p>
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              {messages.length === 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-text-secondary">Try asking:</p>
                  {STARTER_PROMPTS.map((p) => (
                    <StarterPromptChip key={p} label={p} onClick={() => ask(p)} />
                  ))}
                </div>
              )}

              {messages.map((m) => (
                <MessageBubble key={m.id} role={m.role} isError={m.isError}>
                  {m.text}
                  {m.columns && m.rows && <ResultTable columns={m.columns} rows={m.rows} />}
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
                placeholder="Ask about your calls, leads, jobs…"
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
