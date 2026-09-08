import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MessageCircle, X, Send, Sparkles } from 'lucide-react';
import { supabase } from '@/lib/supabase';

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
 * Floating AI Assistant — rendered once from DashboardLayout so it appears
 * consistently on every /dashboard/* page without every page needing to
 * know about it.
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

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
            className="fixed bottom-[164px] right-5 z-40 flex h-[520px] w-[380px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
            role="dialog"
            aria-modal="true"
            aria-label="AI Assistant"
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ai/10 text-ai">
                <Sparkles size={16} />
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">Ask your data</p>
                <p className="text-xs text-text-secondary">Answers come from your own account only</p>
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-text-secondary">Try asking:</p>
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
                    {m.columns && m.rows && <ResultTable columns={m.columns} rows={m.rows} />}
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
                placeholder="Ask about your calls, leads, jobs…"
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
