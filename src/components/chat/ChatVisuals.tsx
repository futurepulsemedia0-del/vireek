import { motion } from 'framer-motion';
import { Sparkles, User } from 'lucide-react';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------
// Shared visual language for every chat surface on the site — the
// dashboard "Ask your data" panel (AiAssistant), the site-wide "Ask
// Vireek" help widget (SiteAssistant), and the homepage "Talk to Sarah"
// typed demo (LiveDemo). One place to define what a message, an avatar,
// and "thinking…" look like, so the three never visually drift apart.
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
 * Thin blinking caret shown at the end of the assistant bubble while a
 * reply is actively streaming in — the same visual cue used by every
 * modern AI chat surface to say "still writing" without a separate
 * "typing…" row eating space in the transcript. Pass `active={false}`
 * (or omit the prop while a message is done) to render nothing.
 */
export function StreamingCaret({ active = true }: { active?: boolean }) {
  if (!active) return null;
  return (
    <motion.span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] rounded-full bg-current align-middle"
      animate={{ opacity: [1, 1, 0, 0] }}
      transition={{ duration: 0.9, repeat: Infinity, ease: 'linear', times: [0, 0.5, 0.5, 1] }}
    />
  );
}

/**
 * A message bubble with a matching avatar, entering with a soft
 * rise-and-fade instead of popping in — reads as considered, not busy.
 * Set `streaming` while an assistant reply is still being written to
 * show a live blinking caret at the end of the text.
 */
export function MessageBubble({
  role,
  isError,
  streaming,
  children,
}: {
  role: 'user' | 'assistant';
  isError?: boolean;
  streaming?: boolean;
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
        className={`max-w-[78%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
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
        <StreamingCaret active={!!streaming} />
      </div>
    </motion.div>
  );
}

/**
 * "Thinking…" state shown only for the brief gap between sending a
 * message and the first token arriving — once real text starts streaming
 * in, this is swapped out for the live bubble itself (see
 * `StreamingCaret`). Built from a softly rotating gradient-ring avatar and
 * three drifting dots whose glow follows the same accent→cta gradient as
 * the rest of the chat system, so it reads as "the assistant itself is
 * warming up" rather than a generic spinner.
 */
export function TypingIndicator() {
  return (
    <div className="flex items-end gap-2.5">
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-cta text-white shadow-sm">
        <motion.span
          className="absolute inset-0 rounded-full bg-gradient-to-br from-accent to-cta"
          animate={{ opacity: [0.55, 0, 0.55], scale: [1, 1.55, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        />
        <Sparkles size={14} strokeWidth={2.25} className="relative" />
      </span>
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-border/70 bg-bg-tertiary px-4 py-3.5">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-gradient-to-br from-accent to-cta"
            animate={{ opacity: [0.25, 1, 0.25], y: [0, -4, 0], scale: [0.85, 1.05, 0.85] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut', delay: i * 0.16 }}
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
