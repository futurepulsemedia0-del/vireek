import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('rounded-2xl border border-border bg-bg-secondary p-4', className)}>{children}</section>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 py-10 text-sm text-text-secondary">
      <Loader2 size={18} className="animate-spin" aria-hidden /> {label}…
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
      {message}
      {onRetry && (
        <button type="button" onClick={onRetry} className="focus-ring ml-2 font-semibold underline">
          Try again
        </button>
      )}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean };

export function PrimaryButton({ busy, children, className, disabled, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'focus-ring inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:opacity-60',
        className,
      )}
    >
      {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function SecondaryButton({ busy, children, className, disabled, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'focus-ring inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm font-medium text-text-primary transition hover:bg-bg-tertiary disabled:opacity-60',
        className,
      )}
    >
      {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'neutral' | 'accent'; children: ReactNode }) {
  const tones = {
    good: 'bg-success-500/10 text-success',
    warn: 'bg-warning-500/10 text-warning-500',
    bad: 'bg-danger/10 text-danger',
    neutral: 'bg-bg-tertiary text-text-secondary',
    accent: 'bg-accent/10 text-accent',
  } as const;
  return <span className={cx('rounded-full px-2.5 py-1 text-xs font-medium', tones[tone])}>{children}</span>;
}

export function openExternal(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}
