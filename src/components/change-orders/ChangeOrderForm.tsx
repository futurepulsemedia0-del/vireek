import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { formatCents } from '@/lib/quotes';
import { fetchParentOptions, type ParentOption } from '@/lib/changeOrdersApi';
import {
  EMPTY_LINE,
  MAX_LINES,
  REASONS,
  REASON_LABEL,
  formTotals,
  hasErrors,
  lineFormAmount,
  validateForm,
  type ChangeOrderReason,
  type FormErrors,
  type FormValues,
} from '@/lib/changeOrders';
import { panelClass, selectClass } from './coUi';

interface Props {
  mode: 'create' | 'edit';
  ownerId: string;
  initial: FormValues;
  submitting: boolean;
  onSubmit: (values: FormValues, parent: ParentOption | null) => void | Promise<void>;
  onCancel: () => void;
}

function ParentPicker({ ownerId, value, onChange }: { ownerId: string; value: ParentOption | null; onChange: (p: ParentOption | null) => void }) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<ParentOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (value) return;
    const mine = ++seq.current;
    setFailed(false);
    const t = setTimeout(() => {
      fetchParentOptions(ownerId, query)
        .then((o) => { if (seq.current === mine) setOptions(o); })
        .catch(() => { if (seq.current === mine) { setOptions([]); setFailed(true); } });
    }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [ownerId, query, value]);

  if (value) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{value.label}</p>
          <p className="truncate text-xs text-text-secondary">{value.sublabel}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>Change</Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Input aria-label="Search jobs and projects" icon={Search} placeholder="Search by customer, project or address" value={query} onChange={(e) => setQuery(e.target.value)} className="py-2 text-sm" />
      <div role="listbox" aria-label="Jobs and projects" className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-border bg-bg-primary p-1">
        {options === null ? (
          <p className="flex items-center gap-2 p-3 text-sm text-text-secondary" aria-busy="true"><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading…</p>
        ) : failed ? (
          <p className="p-3 text-sm text-danger-500">Couldn’t load jobs and projects. Try searching again.</p>
        ) : options.length === 0 ? (
          <p className="p-3 text-sm text-text-secondary">Nothing matches. Try a different customer, project number or address.</p>
        ) : (
          options.map((o) => (
            <button key={`${o.kind}:${o.id}`} type="button" role="option" aria-selected={false} onClick={() => onChange(o)} className="focus-ring block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-bg-tertiary">
              <span className="block truncate text-sm font-medium text-text-primary">{o.label}</span>
              <span className="block truncate text-xs text-text-secondary">{o.sublabel}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function ChangeOrderForm({ mode, ownerId, initial, submitting, onSubmit, onCancel }: Props) {
  const [v, setV] = useState<FormValues>(initial);
  const [parent, setParent] = useState<ParentOption | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [parentError, setParentError] = useState('');
  const [touched, setTouched] = useState(false);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setV((p) => ({ ...p, [key]: value }));
  const totals = useMemo(() => formTotals(v), [v]);

  // Re-validate live once the user has tried to submit, so errors clear as they fix them.
  useEffect(() => { if (touched) setErrors(validateForm(v)); }, [v, touched]);

  const pickParent = (p: ParentOption | null) => {
    setParent(p);
    setParentError('');
    if (p && !v.customerName.trim()) set('customerName', p.customerName);
  };

  const setLine = (i: number, patch: Partial<FormValues['lines'][number]>) =>
    setV((p) => ({ ...p, lines: p.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setTouched(true);
    const next = validateForm(v);
    setErrors(next);
    const missingParent = mode === 'create' && !parent;
    setParentError(missingParent ? 'Pick the job or project this change applies to.' : '');
    if (hasErrors(next) || missingParent) return;
    void onSubmit(v, parent);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5" aria-label={mode === 'create' ? 'New change order' : 'Edit change order'}>
      {mode === 'create' && (
        <section className={panelClass}>
          <h2 className="text-base font-semibold text-text-primary">Applies to</h2>
          <p className="mb-3 mt-0.5 text-sm text-text-secondary">The job or install project whose scope or price is changing.</p>
          <ParentPicker ownerId={ownerId} value={parent} onChange={pickParent} />
          {parentError && <p role="alert" className="mt-2 text-sm text-danger-500">{parentError}</p>}
        </section>
      )}

      <section className={`${panelClass} space-y-4`}>
        <h2 className="text-base font-semibold text-text-primary">What’s changing</h2>
        <Input label="Title" required value={v.title} maxLength={160} placeholder="e.g. Replace burnt contactor and capacitor" onChange={(e) => set('title', e.target.value)} error={errors.title} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="co-reason" className="mb-1.5 block text-sm font-medium text-text-primary">Reason</label>
            <select id="co-reason" className={selectClass} value={v.reason} onChange={(e) => set('reason', e.target.value as ChangeOrderReason)}>
              {REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
            </select>
          </div>
          <Input label="Schedule impact (days)" inputMode="numeric" value={v.scheduleDays} onChange={(e) => set('scheduleDays', e.target.value)} error={errors.scheduleDays} helperText="Use a negative number if this finishes earlier." />
        </div>
        <Textarea label="Scope description (shown to the customer)" rows={4} value={v.description} maxLength={4000} placeholder="Explain what was found, what will be done and why." onChange={(e) => set('description', e.target.value)} error={errors.description} />
        <Textarea label="Internal notes (never shown to the customer)" rows={2} value={v.internalNotes} maxLength={4000} onChange={(e) => set('internalNotes', e.target.value)} />
      </section>

      <section className={`${panelClass} space-y-4`}>
        <h2 className="text-base font-semibold text-text-primary">Customer</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Name" required value={v.customerName} maxLength={160} onChange={(e) => set('customerName', e.target.value)} error={errors.customerName} />
          <Input label="Email" type="email" value={v.customerEmail} onChange={(e) => set('customerEmail', e.target.value)} error={errors.customerEmail} />
          <Input label="Phone" type="tel" value={v.customerPhone} onChange={(e) => set('customerPhone', e.target.value)} />
          <Input label="Site address" value={v.siteAddress} maxLength={300} onChange={(e) => set('siteAddress', e.target.value)} />
        </div>
      </section>

      <section className={`${panelClass} space-y-4`}>
        <div>
          <h2 className="text-base font-semibold text-text-primary">Pricing</h2>
          <p className="mt-0.5 text-sm text-text-secondary">Add a negative price for a credit. Blank rows are ignored.</p>
        </div>

        <ul className="space-y-3">
          {v.lines.map((l, i) => {
            const lineErr = errors.lineErrors?.[i];
            const amount = lineFormAmount(l);
            return (
              <li key={i} className="rounded-xl border border-border bg-bg-primary p-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_6rem_8rem_auto] sm:items-end">
                  <Input label="Description" value={l.description} maxLength={200} onChange={(e) => setLine(i, { description: e.target.value })} className="py-2 text-sm" />
                  <Input label="Qty" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} className="py-2 text-sm" />
                  <Input label="Unit price ($)" inputMode="decimal" value={l.unitPrice} placeholder="0.00" onChange={(e) => setLine(i, { unitPrice: e.target.value })} className="py-2 text-sm" />
                  <div className="flex items-center justify-between gap-3 sm:justify-end">
                    <span className="text-sm font-semibold tabular-nums text-text-primary sm:min-w-[5.5rem] sm:text-right">{amount === null ? '—' : formatCents(amount)}</span>
                    <button
                      type="button"
                      aria-label={`Remove line ${i + 1}`}
                      disabled={v.lines.length === 1}
                      onClick={() => setV((p) => ({ ...p, lines: p.lines.filter((_, idx) => idx !== i) }))}
                      className="focus-ring rounded-lg p-2 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-danger-500 disabled:opacity-40"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {lineErr && <p role="alert" className="mt-2 text-sm text-danger-500">{lineErr}</p>}
              </li>
            );
          })}
        </ul>
        {errors.lines && <p role="alert" className="text-sm text-danger-500">{errors.lines}</p>}

        <Button type="button" variant="secondary" size="sm" disabled={v.lines.length >= MAX_LINES} onClick={() => setV((p) => ({ ...p, lines: [...p.lines, { ...EMPTY_LINE }] }))}>
          <Plus size={16} aria-hidden="true" /> Add line
        </Button>

        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-[12rem_1fr] sm:items-start">
          <Input label="Tax (%)" inputMode="decimal" value={v.taxPercent} onChange={(e) => set('taxPercent', e.target.value)} error={errors.taxPercent} />
          <dl className="space-y-1.5 text-sm sm:ml-auto sm:w-64" aria-label="Totals">
            <div className="flex justify-between"><dt className="text-text-secondary">Subtotal</dt><dd className="tabular-nums text-text-primary">{formatCents(totals.subtotalCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-text-secondary">Tax</dt><dd className="tabular-nums text-text-primary">{formatCents(totals.taxCents)}</dd></div>
            <div className="flex justify-between border-t border-border pt-1.5 text-base font-bold"><dt className="text-text-primary">Total</dt><dd className="tabular-nums text-text-primary" data-testid="form-total">{formatCents(totals.totalCents)}</dd></div>
          </dl>
        </div>
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          {mode === 'create' ? 'Create draft' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
