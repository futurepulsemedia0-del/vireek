import { useState } from 'react';
import { Check, Copy, Lock } from 'lucide-react';

export const SELECT =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-60';

export function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}

export const STATUS_STYLE = {
  success: 'bg-success-500/10 text-success-500',
  running: 'bg-accent/10 text-accent',
  partial: 'bg-warning-500/10 text-warning-500',
  failed: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
} as const;

export function Skeleton({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-xs text-danger">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-text-secondary">{hint}</span>
      ) : null}
    </label>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="focus-ring rounded-lg px-2 py-1 font-semibold underline">
          Try again
        </button>
      )}
    </div>
  );
}

export function NoAccess({ what }: { what: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
        <Lock size={26} />
      </span>
      <h3 className="mt-4 text-lg font-semibold text-text-primary">Permission required</h3>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-text-secondary">{what}</p>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1800);
        } catch {
          /* clipboard blocked: the text stays selectable */
        }
      }}
      className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-tertiary"
    >
      {done ? <Check size={14} className="text-success-500" /> : <Copy size={14} />}
      {done ? 'Copied' : label}
    </button>
  );
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <div className="absolute right-2 top-2">
        <CopyButton text={code} />
      </div>
      <pre className="max-h-72 overflow-auto rounded-xl border border-border bg-bg-primary p-4 pr-24 text-xs leading-relaxed text-text-primary">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-2.5 text-sm text-text-primary ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" className="h-4 w-4 rounded border-border accent-[rgb(var(--accent-primary))]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
