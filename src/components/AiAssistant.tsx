import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MessageCircle, X, Send } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { MessageBubble, OnlineDot, StarterPromptChip, TypingIndicator } from '@/components/chat/ChatVisuals';
import { useShortcutHandlers } from '@/lib/shortcuts/useShortcuts';
import { OPEN_ACCESSIBILITY_EVENT, OPEN_ASK_DATA_EVENT } from '@/lib/uiEvents';

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
 * "Ask your data" — the dashboard AI assistant panel, rendered once from
 * DashboardLayout. There is deliberately NO floating launcher: it opens from the
 * sidebar "Ask your data" button (DashboardNav), the `a d` shortcut, or
 * openAskData() from lib/uiEvents. Opening it closes the Accessibility Center and
 * vice versa, so two panels never stack.
 *
 * Visuals come from `@/components/chat/ChatVisuals` — the same language as the
 * other chat surfaces.
 */
export function AiAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const openPanel = () => {
    if (!wasOpenRef.current) {
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    setOpen(true);
    inputRef.current?.focus();
  };
  const openPanelRef = useRef(openPanel);
  openPanelRef.current = openPanel;

  useEffect(() => {
    const onOpen = () => openPanelRef.current();
    const onOtherPanel = () => setOpen(false);
    window.addEventListener(OPEN_ASK_DATA_EVENT, onOpen);
    window.addEventListener(OPEN_ACCESSIBILITY_EVENT, onOtherPanel);
    return () => {
      window.removeEventListener(OPEN_ASK_DATA_EVENT, onOpen);
      window.removeEventListener(OPEN_ACCESSIBILITY_EVENT, onOtherPanel);
    };
  }, []);

  useShortcutHandlers({ 'assistant.ask': openPanel });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    if (wasOpenRef.current && !open) {
      const el = returnFocusRef.current;
      if (el?.isConnected) el.focus();
      returnFocusRef.current = null;
    }
    wasOpenRef.current = open;
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
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.97 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-[calc(1.25rem_+_var(--vk-bottom-nav-h,0px)_+_var(--vk-consent-lift,0px))] right-5 z-overlay flex h-[min(560px,calc(100dvh_-_6rem_-_var(--vk-bottom-nav-h,0px)))] w-[min(390px,calc(100vw_-_2.5rem))] flex-col overflow-hidden rounded-3xl border border-border bg-bg-secondary/95 shadow-card-hover backdrop-blur-xl print:hidden dark:shadow-card-hover-dark"
          role="dialog"
          aria-modal="false"
          aria-label="Ask your data"
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
          }}
        >
          <div className="flex items-center gap-3 border-b border-border/80 bg-gradient-to-b from-bg-secondary to-bg-secondary/60 px-5 py-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-on-accent shadow-sm">
              <MessageCircle size={17} strokeWidth={2.25} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                Ask your data
                <OnlineDot />
              </p>
              <p className="truncate text-xs text-text-secondary">Answers come from your own account only</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close Ask your data"
              className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>

          <div ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions" className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
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
              aria-label="Your question"
              className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
            />
            <motion.button
              type="submit"
              disabled={!input.trim() || thinking}
              aria-label="Send"
              whileHover={input.trim() && !thinking ? { scale: 1.06 } : undefined}
              whileTap={input.trim() && !thinking ? { scale: 0.94 } : undefined}
              className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent transition-opacity disabled:opacity-40"
            >
              <Send size={16} aria-hidden="true" />
            </motion.button>
          </form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
