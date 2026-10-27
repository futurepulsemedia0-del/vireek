/**
 * Small shared pieces for the /dashboard/loyalty panels: stat tile, status pill, modal dialog, switch, select, progress bar.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { TONE_CLASS, type Tone } from '@/lib/loyalty';

export const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary';

export function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const value = Math.min(100, Math.max(0, Math.round(percent)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary"
    >
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${value}%` }} />
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-sm font-medium text-text-primary">{label}</p>
        {description && <p className="mt-0.5 text-xs text-text-secondary">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`focus-ring relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
          checked ? 'border-accent bg-accent' : 'border-border bg-bg-tertiary'
        }`}
      >
        <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  error,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  error?: string;
}) {
  const id = useId();
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} aria-invalid={!!error} className={selectClass}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error && <p role="alert" className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Modal: bottom sheet on phones, centered card on larger screens. Focus-trapped, Escape closes. */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useFocusTrap(open);
  useEscapeToClose(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" aria-hidden="true" />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed inset-x-0 bottom-0 z-[120] max-h-[92vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[92vw] sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl dark:shadow-card-hover-dark"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-text-primary">{title}</h2>
            {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </>
  );
}
