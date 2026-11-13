// Recreated: verify against original intent
// Small shared building blocks for the Parts Sourcing tabs (class strings + a few presentational helpers).
import type { ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

export const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
export const label = 'mb-1 block text-xs font-semibold text-text-secondary';
export const field =
  'focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary placeholder:text-text-secondary/60 disabled:opacity-60';

export type ChipTone = 'ok' | 'bad' | 'info' | 'warn' | 'neutral';

const CHIP_TONES: Record<ChipTone, string> = {
  ok: 'bg-success-500/10 text-success-500',
  bad: 'bg-danger/10 text-danger',
  warn: 'bg-warning-500/10 text-warning-500',
  info: 'bg-accent/10 text-accent',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

export function Chip({ tone = 'neutral', children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${CHIP_TONES[tone]}`}>{children}</span>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-text-secondary">{children}</p>;
}

export function LoadingRow({ text = 'Loading…' }: { text?: string }) {
  return (
    <p role="status" className="flex items-center gap-2 py-4 text-sm text-text-secondary">
      <Loader2 size={16} className="animate-spin" aria-hidden="true" />
      {text}
    </p>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
      <AlertTriangle size={16} aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="focus-ring rounded-md px-2 py-1 text-xs font-semibold underline">
          Try again
        </button>
      )}
    </div>
  );
}
