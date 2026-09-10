import { motion } from 'framer-motion';
import { Sparkles, User } from 'lucide-react';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------
// Shared visual language for every chat surface on the site — the
// dashboard "Ask your data" panel (AiAssistant), the site-wide "Ask
// Vireek" help widget (SiteAssistant), and the homepage "Talk to Sarah"
// typed demo (LiveDemo). One place to define what a message, an avatar,
// and "typing…" look like, so the three never visually drift apart.
// Deliberately tiny and unopinionated about layout — each panel keeps
// its own header/composer/positioning, this file only owns the pieces
// that repeat.
// ---------------------------------------------------------------------

/** Small gradient avatar for the assistant, a quiet neutral one for the visitor. */
export function ChatAvatar({ role }: { role: 'user' | 'assistant' }) {
  if (role === 'assistant') {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-cta text-white shadow-sm">
        <Sparkles size={14} strokeWidth={2.25} />
      </span>
    );
  }
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-bg-tertiary text-text-secondary">
      <User size={14} strokeWidth={2.25} />
    </span>
  );
}

/**
 * A message bubble with a matching avatar, entering with a soft
 * rise-and-fade instead of popping in — reads as considered, not busy.
 */
export function MessageBubble({
  role,
  isError,
  children,
}: {
  role: 'user' | 'assistant';
  isError?: boolean;
  children: ReactNode;
}) {
  const isUser = role === 'user';
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className={`flex items-end gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      <ChatAvatar role={role} />
      <div
        className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'rounded-br-sm bg-gradient-to-br from-accent to-accent-600 text-white shadow-sm'
            : `rounded-bl-sm border ${
                isError
                  ? 'border-danger/20 bg-danger/[0.06] text-danger'
                  : 'border-border/70 bg-bg-tertiary text-text-primary'
              }`
        }`}
      >
        {children}
      </div>
    </motion.div>
  );
}

/**
 * "Typing…" state — three softly breathing dots on a gradient-tinted
 * pill, animated with framer-motion (not CSS `animate-bounce`, which
 * reads as mechanical/cheap at this size) plus a matching avatar so it
 * sits in the transcript exactly like a real reply-in-progress.
 */
export function TypingIndicator() {
  return (
    <div className="flex items-end gap-2.5">
      <ChatAvatar role="assistant" />
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-border/70 bg-bg-tertiary px-4 py-3.5">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-gradient-to-br from-accent to-cta"
            animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut', delay: i * 0.15 }}
          />
        ))}
      </div>
    </div>
  );
}

/** Pill-shaped starter-prompt chip — a suggestion, not a form field. */
export function StarterPromptChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.98 }}
      className="focus-ring block w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-left text-sm text-text-primary transition-colors hover:border-accent/30 hover:bg-accent/5"
    >
      {label}
    </motion.button>
  );
}

/** Tiny pulsing "online" dot for a chat panel header — reuses the same
 * ping+dot language as `LiveIndicator`, scaled down for inline use next
 * to a title instead of as a standalone badge. */
export function OnlineDot() {
  return (
    <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-500 opacity-75" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success-500" />
    </span>
  );
}
