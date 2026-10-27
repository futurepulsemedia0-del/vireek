import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/Input';

export const HVAC_SECTION = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
export const HVAC_SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary sm:py-2.5 sm:text-sm';

export const TONE_CLASS = {
  good: 'bg-success-500/10 text-success-500',
  warn: 'bg-warning-500/10 text-warning-500',
  bad: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
} as const;
export type Tone = keyof typeof TONE_CLASS;

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

export function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 space-y-3 border-0 p-0">
      <legend className="mb-1 text-sm font-semibold text-text-primary">{title}</legend>
      {hint ? <p className="-mt-1 text-xs text-text-secondary">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

interface NumFieldProps {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  /** Blank means null when true, otherwise NaN (so validation flags it). */
  nullable?: boolean;
  error?: string;
  helper?: string;
  disabled?: boolean;
}

const showNum = (v: number | null): string => (v === null || Number.isNaN(v) ? '' : String(v));

/**
 * Text-backed number input: the user can clear and retype freely, junk
 * characters are ignored, and the parent only ever sees finite numbers
 * (or null / NaN for a blank field).
 */
export function NumField({ label, value, onChange, nullable = false, error, helper, disabled }: NumFieldProps) {
  const [draft, setDraft] = useState(showNum(value));
  const lastRef = useRef<number | null>(value);

  useEffect(() => {
    if (!Object.is(lastRef.current, value)) {
      lastRef.current = value;
      setDraft(showNum(value));
    }
  }, [value]);

  return (
    <Input
      label={label}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={draft}
      disabled={disabled}
      error={error}
      helperText={error ? undefined : helper}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const trimmed = text.trim();
        let next: number | null;
        if (trimmed === '') next = nullable ? null : Number.NaN;
        else {
          const n = Number(trimmed);
          if (!Number.isFinite(n)) return;
          next = n;
        }
        lastRef.current = next;
        onChange(next);
      }}
      onBlur={() => setDraft(showNum(lastRef.current))}
    />
  );
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T | '';
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  placeholder?: string;
  helper?: string;
  disabled?: boolean;
}

export function SelectField<T extends string>({ label, value, options, onChange, placeholder, helper, disabled }: SelectFieldProps<T>) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select
        id={id}
        className={HVAC_SELECT_CLASS}
        value={value}
        disabled={disabled}
        aria-describedby={helper ? `${id}-help` : undefined}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {helper ? (
        <p id={`${id}-help`} className="mt-1.5 text-xs text-text-secondary">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

export function CheckField({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-sm text-text-primary">
      <input
        id={id}
        type="checkbox"
        className="focus-ring h-5 w-5 rounded border-border accent-[var(--color-accent,#2563eb)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-0.5 text-lg font-bold text-text-primary">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

export function WarningList({ items, tone = 'warn' }: { items: string[]; tone?: 'warn' | 'bad' }) {
  if (items.length === 0) return null;
  const box = tone === 'bad' ? 'border-danger/30 bg-danger/10' : 'border-warning-500/30 bg-warning-500/10';
  return (
    <ul role="status" className={`space-y-1.5 rounded-xl border p-3 text-sm text-text-primary ${box}`}>
      {items.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}
