import { useId, type ReactNode } from 'react';

const selectCls =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  required?: boolean;
  disabled?: boolean;
  helperText?: string;
}

/** Native select styled like <Input> (the design system has no Select primitive yet). */
export function SelectField({ label, value, onChange, children, required, disabled, helperText }: SelectFieldProps) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={selectCls}>
        {children}
      </select>
      {helperText && <p className="mt-1 text-xs text-text-secondary">{helperText}</p>}
    </div>
  );
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const toneCls: Record<Tone, string> = {
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-primary text-text-secondary',
};

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${toneCls[tone]}`}>{children}</span>;
}

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Value for <input type="datetime-local"> in the user's timezone. */
export function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export const localInputToISO = (v: string): string => new Date(v).toISOString();

export const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
