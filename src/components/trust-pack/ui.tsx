import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Loader2, type LucideIcon } from 'lucide-react';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';

export const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors disabled:opacity-60';

export function Card({ title, icon: Icon, children, aside }: { title: string; icon?: LucideIcon; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={18} className="shrink-0 text-accent" aria-hidden />}
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';
const TONE: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  bad: 'bg-red-500/10 text-red-600 dark:text-red-400',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]}`}>{children}</span>;
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-text-primary">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-text-secondary">{hint}</span>}
      {error && <span role="alert" className="mt-1 block text-xs text-red-500">{error}</span>}
    </label>
  );
}

export function PanelSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-32 w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-2xl" />
    </div>
  );
}

export function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 p-5">
      <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
        <AlertCircle size={16} aria-hidden /> {message}
      </div>
      <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>
    </div>
  );
}

export function Spinner() {
  return <Loader2 size={16} className="animate-spin" aria-hidden />;
}

/** Loads data once (and on demand). Background reloads keep the previous data on screen. */
export function useLoader<T>(load: () => Promise<T>, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async (initial = false) => {
    if (initial) setStatus('loading');
    try {
      setData(await loadRef.current());
      setStatus('ready');
      setError('');
    } catch (e) {
      if (initial) { setStatus('error'); setError(e instanceof Error ? e.message : 'Something went wrong.'); }
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload(true);
  }, [enabled, reload]);

  return { data, status, error, reload: () => reload(false), retry: () => reload(true) };
}

export const fmtDate = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
