import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Phone, Send, Sparkles } from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { SARAH_PHONE } from '@/lib/site';
import { streamAiChat } from '@/lib/aiStream';
import { VoiceDemoWidget } from '@/components/VoiceDemoWidget';
import { MessageBubble, OnlineDot, TypingIndicator } from '@/components/chat/ChatVisuals';

const PHONE_DISPLAY = '+1 (650) 910-6703';

const STARTER_PROMPTS = [
  'My water heater is leaking everywhere!',
  'Can you book me in for Tuesday afternoon?',
  'What are your hours and service area?',
];

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

const OPENING_MESSAGE: ChatMessage = {
  id: 'opening',
  role: 'assistant',
  content: "Hi, this is Sarah! Type what you'd say if you were calling in — I'll answer just like I would on a real call.",
};

export function LiveDemo() {
  const { t } = useTranslation('common');
  const [messages, setMessages] = useState<ChatMessage[]>([OPENING_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: trimmed }]);
    setInput('');
    setError(null);
    setLoading(true);

    const assistantId = crypto.randomUUID();
    let started = false;
    const controller = new AbortController();
    abortRef.current = controller;

    await streamAiChat({
      functionName: 'demo-chat',
      message: trimmed,
      history,
      signal: controller.signal,
      onDelta: (delta) => {
        if (!started) {
          started = true;
          setLoading(false);
          setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: delta, streaming: true }]);
        } else {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m)),
          );
        }
      },
      onDone: () => {
        setLoading(false);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
      },
      onError: (message) => {
        setLoading(false);
        if (started) {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
        }
        setError(message);
      },
    });
  }

  return (
    <section id="demo" className="py-16 sm:py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>Live demo — not a script</p>
          <h2 className={sectionHeadingClass()}>Talk to Sarah Right Now</h2>
        </motion.div>

        <div className="mt-10 grid gap-4 sm:mt-14 sm:gap-6 lg:grid-cols-3">
          {/* Live in-browser voice demo — the flagship option, click and talk */}
          <VoiceDemoWidget />

          {/* Phone demo */}
          <motion.a
            href={SARAH_PHONE}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="focus-ring group flex flex-col items-start justify-center rounded-2xl border border-border bg-bg-secondary p-6 shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-glow-accent dark:shadow-card-dark sm:p-8"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent transition-colors group-hover:bg-accent group-hover:text-white sm:h-14 sm:w-14">
              <Phone size={20} className="sm:size-6" />
            </span>
            <span className="mt-5 text-xs font-medium uppercase tracking-[0.15em] text-text-secondary sm:mt-6 sm:text-sm sm:tracking-[0.18em]">
              Call Sarah
            </span>
            <span className="mt-2 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl md:text-4xl">
              {PHONE_DISPLAY}
            </span>
            <span className="mt-3 text-sm text-text-secondary sm:text-base">
              Tap to call from your phone. She answers in seconds.
            </span>
          </motion.a>

          {/* Live typed chat with the real AI — streams token-by-token */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
            className="group/card relative rounded-[27px] bg-gradient-to-br from-accent/50 via-border to-cta/50 p-px shadow-card dark:shadow-card-dark"
          >
            <div className="flex h-[440px] flex-col overflow-hidden rounded-[26px] bg-bg-tertiary sm:h-[520px]">
              <div className="relative flex items-center gap-2.5 overflow-hidden border-b border-border bg-bg-secondary px-4 py-3.5 sm:px-5 sm:py-4">
                <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
                <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-cta text-white shadow-sm sm:h-8 sm:w-8">
                  <Sparkles size={13} strokeWidth={2.25} className="sm:size-[15px]" />
                </span>
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-text-secondary sm:text-sm sm:tracking-[0.18em]">
                  No account, no phone call — just type
                  <OnlineDot />
                </p>
              </div>

              <p className="border-b border-border bg-bg-secondary/60 px-4 py-1.5 text-center text-[10px] font-medium text-text-secondary sm:px-5">
                {t('aiDisclosure.chatNotice')}
              </p>
              <div ref={scrollRef} aria-live="polite" className="flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:space-y-4 sm:px-5 sm:py-5">
                {messages.map((msg) => (
                  <MessageBubble key={msg.id} role={msg.role} streaming={msg.streaming}>
                    {msg.content}
                  </MessageBubble>
                ))}
                {loading && <TypingIndicator />}
                {error && <p className="text-center text-xs font-medium text-danger">{error}</p>}
              </div>

              {messages.length <= 1 && (
                <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3 sm:px-5">
                  {STARTER_PROMPTS.map((p) => (
                    <motion.button
                      key={p}
                      type="button"
                      onClick={() => sendMessage(p)}
                      whileHover={{ y: -1 }}
                      whileTap={{ scale: 0.97 }}
                      className="focus-ring rounded-full border border-border bg-bg-secondary px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary sm:py-1.5"
                    >
                      {p}
                    </motion.button>
                  ))}
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendMessage(input);
                }}
                className="flex items-center gap-2 border-t border-border bg-bg-secondary p-3"
              >
                <label htmlFor="live-demo-input" className="sr-only">
                  Type a message to Sarah
                </label>
                <input
                  id="live-demo-input"
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type what you'd say to a receptionist…"
                  maxLength={400}
                  disabled={loading}
                  className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3.5 py-3 text-sm text-text-primary placeholder:text-text-secondary/60 transition-shadow focus:shadow-glow-accent sm:px-4 sm:py-2.5"
                />
                <motion.button
                  type="submit"
                  disabled={loading || !input.trim()}
                  aria-label="Send message"
                  whileHover={!loading && input.trim() ? { scale: 1.06 } : undefined}
                  whileTap={!loading && input.trim() ? { scale: 0.94 } : undefined}
                  className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-cta text-white transition-opacity disabled:opacity-40"
                >
                  <Send size={16} />
                </motion.button>
              </form>
            </div>
          </motion.div>
        </div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-5 text-xs text-text-secondary sm:mt-6 sm:text-sm"
        >
          This is the real AI, typing back live — not a canned transcript. On an actual phone
          call, Sarah understands context, urgency, and trade-specific terminology the same way.
        </motion.p>
      </div>
    </section>
  );
}
