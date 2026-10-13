import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-accent/10 text-accent',
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>{children}</span>;
}

export function Section({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h3 className="text-sm font-semibold text-text-primary">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone = 'neutral', hint }: { label: string; value: ReactNode; tone?: Tone; hint?: string }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning-500' : tone === 'success' ? 'text-success-500' : 'text-text-primary';
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-bold ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  error?: string;
  id?: string;
  children: ReactNode;
}

/** Matches the shared <Input> chrome (label, error, focus ring) for native selects. */
export function SelectField({ label, error, id, className = '', children, ...rest }: SelectFieldProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div>
      <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
        {rest.required && <span className="ms-0.5 text-danger">*</span>}
      </label>
      <select
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        className={`focus-ring w-full rounded-xl border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${error ? 'border-danger' : 'border-border'} ${className}`}
        {...rest}
      >
        {children}
      </select>
      {error && <p id={`${fieldId}-error`} role="alert" className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <EmptyState icon={TriangleAlert} title="Something went wrong" description={message} action={{ label: 'Try again', onClick: onRetry }} />;
}

/**
 * Loads async data with loading/error state. A newer request always wins, so a
 * slow earlier response can never overwrite fresh data. `key` re-triggers a load.
 */
export function useLoader<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await loadRef.current();
      if (id === seq.current) setState({ data, loading: false, error: null });
    } catch (e) {
      if (id === seq.current) setState((s) => ({ data: s.data, loading: false, error: e instanceof Error ? e.message : 'Something went wrong.' }));
    }
  }, [key]);

  useEffect(() => {
    void reload();
    return () => { seq.current += 1; };
  }, [reload]);

  return { ...state, reload };
}

export function formatDate(dateOnly: string | null): string {
  if (!dateOnly) return '—';
  const d = new Date(`${dateOnly}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
