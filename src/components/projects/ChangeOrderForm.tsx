import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import {
  CHANGE_ORDER_REASON_LABEL,
  EMPTY_CHANGE_ORDER_FORM,
  MAX_CHANGE_ORDER_LINES,
  approvalImpact,
  changeOrderTotals,
  emptyLine,
  hasFormErrors,
  parseQuantity,
  signedDays,
  signedDollarsToCents,
  signedMoney,
  toChangeOrderPayload,
  validateChangeOrderForm,
  type ChangeOrderFormValues,
  type ChangeOrderPayload,
  type ChangeOrderReason,
} from '@/lib/projectChangeOrders';
import { formatDate, formatMoney, type InstallProject } from '@/lib/installProjects';
import { compactInput, panelClass, selectClass } from './projectUi';

interface Props {
  mode: 'create' | 'edit';
  project: InstallProject;
  initial?: ChangeOrderFormValues;
  submitting: boolean;
  onSubmit: (payload: ChangeOrderPayload) => void;
  onCancel: () => void;
}

export function ProjectChangeOrderForm({ mode, project, initial = EMPTY_CHANGE_ORDER_FORM, submitting, onSubmit, onCancel }: Props) {
  const [v, setV] = useState<ChangeOrderFormValues>(initial);
  const [touched, setTouched] = useState(false);
  const errors = useMemo(() => validateChangeOrderForm(v), [v]);
  const payload = useMemo(() => (hasFormErrors(errors) ? null : toChangeOrderPayload(v)), [errors, v]);
  const totals = useMemo(() => (payload ? changeOrderTotals(payload.line_items, payload.markup_percent) : null), [payload]);
  const impact = useMemo(
    () => (totals && payload ? approvalImpact(project, { cost_delta_cents: totals.totalCents, schedule_delta_days: payload.schedule_delta_days }) : null),
    [project, totals, payload],
  );

  const set = <K extends keyof ChangeOrderFormValues>(key: K, value: ChangeOrderFormValues[K]) => setV((prev) => ({ ...prev, [key]: value }));
  const setLine = (i: number, patch: Partial<ChangeOrderFormValues['lines'][number]>) =>
    setV((prev) => ({ ...prev, lines: prev.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) }));
  const addLine = () => setV((prev) => (prev.lines.length >= MAX_CHANGE_ORDER_LINES ? prev : { ...prev, lines: [...prev.lines, emptyLine()] }));
  const removeLine = (i: number) => setV((prev) => ({ ...prev, lines: prev.lines.length > 1 ? prev.lines.filter((_, idx) => idx !== i) : [emptyLine()] }));

  const lineTotal = (i: number): string => {
    const l = v.lines[i];
    const q = parseQuantity(l.quantity);
    const u = signedDollarsToCents(l.unitPrice);
    if (q === null || u === null) return '—';
    return formatMoney(changeOrderTotals([{ quantity: q, unit_price_cents: u }], 0).totalCents);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (payload) onSubmit(payload);
  };

  return (
    <form onSubmit={submit} className={`${panelClass} space-y-4`} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Title" required value={v.title} onChange={(e) => set('title', e.target.value)} error={touched ? errors.title : undefined} placeholder="e.g. Upgrade to 5-ton unit" maxLength={160} />
        <div>
          <label htmlFor="co-reason" className="mb-1.5 block text-sm font-medium text-text-primary">Reason</label>
          <select id="co-reason" className={selectClass} value={v.reason} onChange={(e) => set('reason', e.target.value as ChangeOrderReason)}>
            {(Object.keys(CHANGE_ORDER_REASON_LABEL) as ChangeOrderReason[]).map((r) => (
              <option key={r} value={r}>{CHANGE_ORDER_REASON_LABEL[r]}</option>
            ))}
          </select>
        </div>
      </div>
      <Textarea label="Scope of change" rows={3} value={v.description} onChange={(e) => set('description', e.target.value)} error={touched ? errors.description : undefined} helperText="Shown to the customer on the signing page." />

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-text-primary">Line items</legend>
        <div className="hidden grid-cols-[1fr_90px_130px_110px_auto] gap-2 px-1 text-xs text-text-secondary sm:grid">
          <span>Description</span><span>Qty</span><span>Unit price</span><span className="text-right">Total</span><span className="w-8" />
        </div>
        {v.lines.map((l, i) => (
          <div key={i} className="space-y-1">
            <div className="grid gap-2 sm:grid-cols-[1fr_90px_130px_110px_auto] sm:items-center">
              <Input aria-label={`Line ${i + 1} description`} placeholder="What changes" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} className={compactInput} maxLength={200} />
              <Input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} className={compactInput} />
              <Input aria-label={`Line ${i + 1} unit price in dollars`} inputMode="decimal" placeholder="0.00" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} className={compactInput} />
              <p className="text-right text-sm font-medium tabular-nums text-text-primary">{lineTotal(i)}</p>
              <button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => removeLine(i)} className="focus-ring justify-self-end rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500">
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
            {touched && errors.lines[i] && <p role="alert" className="text-xs text-danger-500">{errors.lines[i]}</p>}
          </div>
        ))}
        {touched && errors.form && <p role="alert" className="text-xs text-danger-500">{errors.form}</p>}
        <Button type="button" size="sm" variant="secondary" onClick={addLine} disabled={v.lines.length >= MAX_CHANGE_ORDER_LINES}><Plus size={14} aria-hidden="true" /> Add line</Button>
        <p className="text-xs text-text-secondary">Use a negative unit price for a credit (for example −450 for a deleted item).</p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="Markup (%)" inputMode="decimal" value={v.markupPercent} onChange={(e) => set('markupPercent', e.target.value)} error={touched ? errors.markupPercent : undefined} helperText="Overhead & profit on the subtotal." />
        <Input label="Schedule impact (days)" inputMode="numeric" value={v.scheduleDays} onChange={(e) => set('scheduleDays', e.target.value)} error={touched ? errors.scheduleDays : undefined} helperText="Moves the target end date when approved." />
        <Input label="Your estimated cost (USD)" inputMode="decimal" value={v.estimatedCost} onChange={(e) => set('estimatedCost', e.target.value)} error={touched ? errors.estimatedCost : undefined} helperText="Internal. Used for the margin forecast." />
      </div>

      <div className="rounded-xl border border-border bg-bg-primary p-4 text-sm" aria-live="polite">
        {totals && impact && payload ? (
          <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            <div className="flex justify-between"><dt className="text-text-secondary">Subtotal</dt><dd className="tabular-nums text-text-primary">{formatMoney(totals.subtotalCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-text-secondary">Markup</dt><dd className="tabular-nums text-text-primary">{formatMoney(totals.markupCents)}</dd></div>
            <div className="flex justify-between font-semibold"><dt className="text-text-primary">Change total</dt><dd className="tabular-nums text-text-primary">{signedMoney(totals.totalCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-text-secondary">Schedule</dt><dd className="text-text-primary">{signedDays(payload.schedule_delta_days)}</dd></div>
            <div className="flex justify-between sm:col-span-2"><dt className="text-text-secondary">Contract if approved</dt><dd className="tabular-nums text-text-primary">{formatMoney(impact.contractBeforeCents, true)} → {formatMoney(impact.contractAfterCents, true)}</dd></div>
            {impact.targetEndAfter && payload.schedule_delta_days !== 0 && (
              <div className="flex justify-between sm:col-span-2"><dt className="text-text-secondary">Target end</dt><dd className="text-text-primary">{formatDate(impact.targetEndBefore)} → {formatDate(impact.targetEndAfter)}</dd></div>
            )}
            {impact.problem && <p role="alert" className="text-xs text-danger-500 sm:col-span-2">This schedule change would move the target end before the project start. Approval would fail — reduce the days.</p>}
          </dl>
        ) : (
          <p className="text-text-secondary">Fix the highlighted fields to see the totals.</p>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button type="submit" size="sm" disabled={submitting || Boolean(impact?.problem)}>{submitting ? 'Saving…' : mode === 'create' ? 'Create draft' : 'Save changes'}</Button>
      </div>
    </form>
  );
}
