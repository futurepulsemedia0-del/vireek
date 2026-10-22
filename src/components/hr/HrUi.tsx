import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import type { HrData } from '@/lib/hrOnboardingApi';

/** Shared state handed to every HR panel. `patch` updates the page data in place; `reload` re-reads everything quietly. */
export interface HrCtx {
  ownerId: string;
  today: string;
  data: HrData;
  patch: (fn: (d: HrData) => HrData) => void;
  reload: () => Promise<void>;
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

const TONES: Record<Tone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
  accent: 'bg-accent/10 text-accent',
};

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function StatTile({ label, value, tone = 'default', onClick }: { label: string; value: number; tone?: 'default' | 'alert'; onClick?: () => void }) {
  const body = (
    <>
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone === 'alert' && value > 0 ? 'text-danger' : 'text-text-primary'}`}>{value}</p>
    </>
  );
  const cls = 'rounded-2xl border border-border bg-bg-secondary p-4 text-left';
  return onClick ? (
    <button type="button" onClick={onClick} className={`focus-ring w-full transition-colors hover:border-accent/40 ${cls}`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
      <div className={`h-full rounded-full transition-all ${value === 100 ? 'bg-success' : 'bg-accent'}`} style={{ width: `${value}%` }} />
    </div>
  );
}

export const SELECT_CLASS =
  'focus-ring w-full rounded-xl border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  error?: string;
}

export function SelectField({ label, error, className = '', children, ...props }: SelectFieldProps) {
  const id = useId();
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`${SELECT_CLASS} ${error ? 'border-danger' : 'border-border'} ${className}`}
        {...props}
      >
        {children}
      </select>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function CheckField({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-sm text-text-primary">
      <input type="checkbox" className="h-4 w-4 accent-accent" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Segmented single-choice control (filters, tabs inside a panel). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`focus-ring min-h-[40px] rounded-xl border px-3.5 text-sm font-semibold transition-colors ${
            value === o.value ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FormShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl border border-accent/30 bg-bg-secondary p-4 sm:p-5">
      <h3 className="mb-4 text-base font-semibold text-text-primary">{title}</h3>
      {children}
    </section>
  );
}

export function employeeName(data: HrData, id: string): string {
  return data.employees.find((e) => e.id === id)?.full_name ?? 'Former employee';
}
