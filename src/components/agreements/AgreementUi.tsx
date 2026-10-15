import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { Agreement360, AgreementTab, Derived } from '@/lib/serviceAgreement';

/** Props every tab receives. */
export interface TabProps {
  data: Agreement360;
  derived: Derived;
  /** Can create / edit / delete agreement records. */
  canManage: boolean;
  /** Can see pricing, margin and claim amounts (can_view_billing or owner). */
  canSeeMoney: boolean;
  /** The ACCOUNT OWNER's id — RLS requires it on every insert (not the team member's own id). */
  ownerId: string;
  reload: () => Promise<void>;
  goTab: (tab: AgreementTab) => void;
}

export function Pill({ className = '', children }: { className?: string; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

export function StatTile({ label, value, icon: Icon, tone = 'text-accent', sub }: { label: string; value: ReactNode; icon: LucideIcon; tone?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <Icon size={16} className={tone} aria-hidden="true" />
      <p className="mt-2 text-2xl font-bold text-text-primary">{value}</p>
      <p className="text-xs text-text-secondary">{label}</p>
      {sub && <p className="mt-1 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

export function Panel({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5 rounded-xl border border-border bg-bg-secondary p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-text-secondary">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-text-primary">{value}</dd>
    </div>
  );
}

export function ProgressBar({ pct, tone = 'bg-accent', label }: { pct: number; tone?: string; label: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100} className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
      <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
  helperText,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
  helperText?: string;
}) {
  const id = `sel-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select id={id} className={selectClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {helperText && <p className="mt-1.5 text-xs text-text-secondary">{helperText}</p>}
    </div>
  );
}

export function CheckField({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
      <input type="checkbox" className="focus-ring h-4 w-4 rounded border-border accent-accent" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function FormActions({ busy, onCancel, submitLabel = 'Save' }: { busy: boolean; onCancel: () => void; submitLabel?: string }) {
  return (
    <div className="flex gap-2">
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? 'Saving…' : submitLabel}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </div>
  );
}

export function RowActions({ onEdit, onDelete, label }: { onEdit?: () => void; onDelete?: () => void; label: string }) {
  return (
    <div className="flex shrink-0 gap-1">
      {onEdit && (
        <button type="button" onClick={onEdit} aria-label={`Edit ${label}`} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
          <Pencil size={14} />
        </button>
      )}
      {onDelete && (
        <button type="button" onClick={onDelete} aria-label={`Delete ${label}`} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-danger/10 hover:text-danger">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

/** Simple two-button delete confirmation reused by every tab. */
export function DeleteConfirm({
  target,
  noun,
  onConfirm,
  onCancel,
}: {
  target: { id: string; label: string } | null;
  noun: string;
  onConfirm: (id: string) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={target !== null}
      title={`Delete ${noun}?`}
      description={`“${target?.label ?? ''}” will be removed from this agreement. This is recorded in the audit log.`}
      confirmLabel="Yes, delete"
      onConfirm={async () => {
        if (target) await onConfirm(target.id);
      }}
      onCancel={onCancel}
    />
  );
}

/** Parses a dollars text field into integer cents. Returns undefined for blank, null for invalid. */
export function dollarsToCents(text: string): number | null | undefined {
  const t = text.trim().replace(/[$,\s]/g, '');
  if (t === '') return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export const centsToDollarsText = (cents: number | null | undefined): string => (cents === null || cents === undefined ? '' : String(cents / 100));

/** Small local-state helper for an inline "add / edit" form. */
export function useInlineForm<T>(empty: T) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<T>(empty);
  return {
    open,
    editingId,
    form,
    setForm,
    patch: (p: Partial<T>) => setForm((f) => ({ ...f, ...p })),
    start: (initial?: T, id?: string) => {
      setForm(initial ?? empty);
      setEditingId(id ?? null);
      setOpen(true);
    },
    close: () => {
      setOpen(false);
      setEditingId(null);
      setForm(empty);
    },
  };
}
