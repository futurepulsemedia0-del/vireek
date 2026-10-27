import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { SelectField } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatMoney } from '@/lib/currency';
import type { InventoryLocation, InventoryPart, InventoryVendor } from '@/lib/inventory';
import { listReturnableLines, listReturnableUsage, saveRma } from '@/lib/vendorRmaApi';
import {
  EMPTY_LINE, EMPTY_RMA_FORM, REASON_LABELS, RESOLUTION_LABELS, RMA_REASONS, RMA_RESOLUTIONS, centsToInput, lineErrorKey,
  parseRmaForm, previewExpectedCredit, remainingReturnable, rmaToForm,
  type FieldErrors, type ReturnablePoLine, type ReturnableUsage, type Rma, type RmaFormValues, type RmaLineForm,
} from '@/lib/vendorRma';

interface Props {
  vendors: InventoryVendor[];
  parts: InventoryPart[];
  locations: InventoryLocation[];
  editing: Rma | null;
  onSaved: (id: string) => void | Promise<void>;
  onCancel: () => void;
}

let lineCounter = 0;
const newKey = () => `new-${Date.now()}-${(lineCounter += 1)}`;

export function RmaFormPanel({ vendors, parts, locations, editing, onSaved, onCancel }: Props) {
  const { toast } = useToast();
  const { currency } = useCurrency();
  const money = (cents: number) => formatMoney(cents / 100, currency);

  const [form, setForm] = useState<RmaFormValues>(() => (editing ? rmaToForm(editing) : EMPTY_RMA_FORM));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [poLines, setPoLines] = useState<ReturnablePoLine[]>([]);
  const [usage, setUsage] = useState<ReturnableUsage[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  const activeLocations = useMemo(() => locations.filter((l) => l.active), [locations]);
  const defaultLocation = activeLocations.find((l) => l.location_type === 'warehouse')?.id ?? activeLocations[0]?.id ?? '';
  const partById = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts]);

  // Units this return already holds on a PO line / usage row (so editing does not double count them).
  const ownPo = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of editing?.lines ?? []) if (l.purchase_order_line_id) m.set(l.purchase_order_line_id, (m.get(l.purchase_order_line_id) ?? 0) + l.quantity);
    return m;
  }, [editing]);
  const ownUsage = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of editing?.lines ?? []) if (l.usage_transaction_id) m.set(l.usage_transaction_id, (m.get(l.usage_transaction_id) ?? 0) + l.quantity);
    return m;
  }, [editing]);

  useEffect(() => {
    if (!form.vendor_id) { setPoLines([]); setUsage([]); return; }
    let cancelled = false;
    setPickerLoading(true);
    Promise.all([listReturnableLines(form.vendor_id), listReturnableUsage(form.vendor_id)])
      .then(([a, b]) => { if (!cancelled) { setPoLines(a); setUsage(b); } })
      .catch((err) => { if (!cancelled) toast(err instanceof Error ? err.message : "Couldn't load purchases.", 'error'); })
      .finally(() => { if (!cancelled) setPickerLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.vendor_id]);

  const set = (k: keyof RmaFormValues) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setLine = (key: string, patch: Partial<RmaLineForm>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const addLine = (line: RmaLineForm) => setForm((f) => ({ ...f, lines: [...f.lines, line] }));
  const removeLine = (key: string) => setForm((f) => ({ ...f, lines: f.lines.filter((l) => l.key !== key) }));

  const poOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of poLines) if (!seen.has(l.po_id)) seen.set(l.po_id, l.po_number);
    return [...seen.entries()];
  }, [poLines]);

  const addFromPo = (lineId: string) => {
    const src = poLines.find((l) => l.po_line_id === lineId);
    if (!src) return;
    const remaining = remainingReturnable(src.quantity_received, src.quantity_committed) + (ownPo.get(src.po_line_id) ?? 0);
    addLine({
      ...EMPTY_LINE(newKey()),
      part_id: src.part_id,
      location_id: defaultLocation,
      quantity: remaining > 0 ? '1' : '0',
      unit_credit: centsToInput(src.unit_cost_cents),
      cost_hint_cents: src.unit_cost_cents,
      purchase_order_line_id: src.po_line_id,
      max_quantity: remaining,
    });
    setForm((f) => (f.purchase_order_id ? f : { ...f, purchase_order_id: src.po_id }));
  };

  const addFromUsage = (txId: string) => {
    const src = usage.find((u) => u.usage_transaction_id === txId);
    if (!src) return;
    const remaining = remainingReturnable(src.quantity_used, src.quantity_committed) + (ownUsage.get(src.usage_transaction_id) ?? 0);
    addLine({
      ...EMPTY_LINE(newKey()),
      part_id: src.part_id,
      source: 'installed',
      location_id: form.resolution === 'replacement' ? defaultLocation : '',
      quantity: remaining > 0 ? '1' : '0',
      unit_credit: centsToInput(src.unit_cost_cents),
      cost_hint_cents: src.unit_cost_cents,
      usage_transaction_id: src.usage_transaction_id,
      job_id: src.job_id ?? '',
      max_quantity: remaining,
    });
  };

  const addManual = () => addLine({ ...EMPTY_LINE(newKey()), location_id: defaultLocation });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const result = parseRmaForm(form);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({});
    setSaving(true);
    try {
      const id = await saveRma(result.value, editing?.id ?? null);
      toast(editing ? 'Return updated.' : 'Return created.', 'success');
      await onSaved(id);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't save the return.", 'error');
    } finally {
      setSaving(false);
    }
  };

  const expected = previewExpectedCredit(form);
  const authorized = editing?.status === 'authorized';

  return (
    <form onSubmit={submit} noValidate className="space-y-5 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <h2 className="text-base font-semibold text-text-primary">{editing ? `Edit ${editing.rma_number}` : 'New vendor return'}</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField label="Vendor" required value={form.vendor_id} onChange={(e) => setForm((f) => ({ ...f, vendor_id: e.target.value, purchase_order_id: '' }))} error={errors.vendor_id} disabled={authorized}>
          <option value="">Choose a vendor…</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </SelectField>
        <SelectField label="Purchase order (optional)" value={form.purchase_order_id} onChange={set('purchase_order_id')} disabled={!form.vendor_id}>
          <option value="">Not linked to one order</option>
          {poOptions.map(([id, number]) => <option key={id} value={id}>{number}</option>)}
        </SelectField>
        <SelectField label="Reason" required value={form.reason_code} onChange={set('reason_code')} error={errors.reason_code}>
          {RMA_REASONS.map((r) => <option key={r} value={r}>{REASON_LABELS[r]}</option>)}
        </SelectField>
        <SelectField label="Expected from vendor" required value={form.resolution} onChange={set('resolution')} error={errors.resolution}>
          {RMA_RESOLUTIONS.map((r) => <option key={r} value={r}>{RESOLUTION_LABELS[r]}</option>)}
        </SelectField>
        <Input label="Vendor RMA number" value={form.vendor_rma_number} onChange={set('vendor_rma_number')} error={errors.vendor_rma_number} maxLength={80} helperText="Add it now if the vendor already gave you one. You can also authorize later." />
        <Input label="Restocking fee" inputMode="decimal" value={form.restocking_fee} onChange={set('restocking_fee')} error={errors.restocking_fee} placeholder="0.00" helperText="Deducted from the expected credit." disabled={form.resolution === 'replacement'} />
      </div>
      <Textarea label="Notes" rows={2} maxLength={2000} value={form.reason_notes} onChange={set('reason_notes')} error={errors.reason_notes} />

      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Parts to return</h3>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px]">
              <SelectField label="Add from a received purchase" value="" onChange={(e) => addFromPo(e.target.value)} disabled={!form.vendor_id || pickerLoading}>
                <option value="">{pickerLoading ? 'Loading…' : poLines.length ? 'Choose a purchase line…' : 'No received purchases'}</option>
                {poLines.map((l) => (
                  <option key={l.po_line_id} value={l.po_line_id} disabled={remainingReturnable(l.quantity_received, l.quantity_committed) + (ownPo.get(l.po_line_id) ?? 0) <= 0}>
                    {l.po_number} · {l.part_name} · {remainingReturnable(l.quantity_received, l.quantity_committed) + (ownPo.get(l.po_line_id) ?? 0)} returnable
                  </option>
                ))}
              </SelectField>
            </div>
            <div className="min-w-[200px]">
              <SelectField label="Add from job usage" value="" onChange={(e) => addFromUsage(e.target.value)} disabled={!form.vendor_id || pickerLoading}>
                <option value="">{pickerLoading ? 'Loading…' : usage.length ? 'Choose a used part…' : 'No recent usage'}</option>
                {usage.map((u) => (
                  <option key={u.usage_transaction_id} value={u.usage_transaction_id} disabled={remainingReturnable(u.quantity_used, u.quantity_committed) + (ownUsage.get(u.usage_transaction_id) ?? 0) <= 0}>
                    {u.part_name} · {u.job_label ?? 'No job'} · {u.used_at.slice(0, 10)}
                  </option>
                ))}
              </SelectField>
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={addManual}><Plus size={16} /> Other part</Button>
          </div>
        </div>
        {errors.lines && <p role="alert" className="text-xs text-danger">{errors.lines}</p>}

        {form.lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-text-secondary">
            Choose a vendor, then add the parts from a received purchase or a job, or add any other part.
          </p>
        ) : (
          <ul className="space-y-3" aria-label="Return lines">
            {form.lines.map((l, i) => {
              const part = partById.get(l.part_id);
              const linked = Boolean(l.purchase_order_line_id || l.usage_transaction_id);
              const err = (f: string) => errors[lineErrorKey(i, f)];
              return (
                <li key={l.key} className="rounded-xl border border-border bg-bg-primary p-3">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      {linked ? (
                        <>
                          <p className="truncate text-sm font-medium text-text-primary">{part?.name ?? 'Part'}{part?.part_number ? ` · ${part.part_number}` : ''}</p>
                          <p className="text-xs text-text-secondary">
                            {l.purchase_order_line_id ? 'From a received purchase' : 'From job usage'}
                            {l.max_quantity != null ? ` · up to ${l.max_quantity}` : ''}
                          </p>
                        </>
                      ) : (
                        <SelectField label="Part" required value={l.part_id} onChange={(e) => {
                          const p = partById.get(e.target.value);
                          setLine(l.key, { part_id: e.target.value, cost_hint_cents: p?.unit_cost_cents ?? 0, unit_credit: p ? centsToInput(p.unit_cost_cents) : '' });
                        }} error={err('part_id')}>
                          <option value="">Choose a part…</option>
                          {parts.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}{p.part_number ? ` · ${p.part_number}` : ''}</option>)}
                        </SelectField>
                      )}
                    </div>
                    <Button type="button" size="sm" variant="ghost" onClick={() => removeLine(l.key)} aria-label="Remove line"><Trash2 size={14} /></Button>
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    <SelectField label="Part is" value={l.source} onChange={(e) => setLine(l.key, { source: e.target.value as RmaLineForm['source'], location_id: e.target.value === 'stock' && !l.location_id ? defaultLocation : l.location_id })} disabled={Boolean(l.usage_transaction_id)} error={err('source')}>
                      <option value="stock">In stock</option>
                      <option value="installed">Already installed</option>
                    </SelectField>
                    <SelectField label={l.source === 'stock' ? 'Returned from' : form.resolution === 'replacement' ? 'Replacement goes to' : 'Location (optional)'} value={l.location_id} onChange={(e) => setLine(l.key, { location_id: e.target.value })} error={err('location_id')}>
                      <option value="">{l.source === 'stock' ? 'Choose…' : 'None'}</option>
                      {activeLocations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </SelectField>
                    <Input label="Quantity" inputMode="numeric" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} error={err('quantity')} />
                    <Input label="Credit per unit" inputMode="decimal" value={l.unit_credit} onChange={(e) => setLine(l.key, { unit_credit: e.target.value })} error={err('unit_credit')} placeholder="0.00" />
                    <Input label="Serial number" value={l.serial_number} onChange={(e) => setLine(l.key, { serial_number: e.target.value })} error={err('serial_number')} maxLength={120} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-sm text-text-secondary">
          Expected credit: <span className="font-semibold text-text-primary">{form.resolution === 'replacement' ? 'Replacement parts' : money(expected)}</span>
        </p>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Create return'}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        </div>
      </div>
    </form>
  );
}
