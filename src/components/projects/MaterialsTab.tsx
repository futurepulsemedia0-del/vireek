import { useEffect, useMemo, useState } from 'react';
import { Package, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { addMaterial, deleteMaterial, fetchInventoryPartOptions, setMaterialStatus, type InventoryPartOption } from '@/lib/installProjectsApi';
import {
  MATERIAL_STATUS_LABEL,
  MATERIAL_STATUS_ORDER,
  centsToDollarsInput,
  dollarsToCents,
  formatDate,
  formatMoney,
  marginForecast,
  materialLineCents,
  materialsSummary,
  type MaterialStatus,
} from '@/lib/installProjects';
import { Pill, SectionHeader, Stat, marginTone, materialTone, panelClass, selectClass, useAction, useConfirm, type TabProps } from './projectUi';

const EMPTY = { description: '', quantity: '1', unit: '', cost: '', vendor: '', phaseId: '', partId: '', expected: '' };

export function MaterialsTab({ ownerId, bundle, onChanged }: TabProps) {
  const { project, phases, materials } = bundle;
  const { busyKey, run } = useAction(onChanged);
  const { ask, dialog } = useConfirm();
  const [form, setForm] = useState(EMPTY);
  const [parts, setParts] = useState<InventoryPartOption[]>([]);
  const summary = useMemo(() => materialsSummary(materials), [materials]);
  const margin = useMemo(() => marginForecast(project, summary.totalCents), [project, summary.totalCents]);

  useEffect(() => {
    let cancelled = false;
    fetchInventoryPartOptions(ownerId).then((p) => { if (!cancelled) setParts(p); }).catch(() => { /* optional picker — manual entry still works */ });
    return () => { cancelled = true; };
  }, [ownerId]);

  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const pickPart = (id: string) => {
    const part = parts.find((p) => p.id === id);
    setForm((f) => part ? { ...f, partId: id, description: part.name, unit: part.unit_label ?? f.unit, cost: centsToDollarsInput(part.unit_cost_cents) } : { ...f, partId: '' });
  };

  const qty = Number(form.quantity);
  const cents = dollarsToCents(form.cost);
  const valid = form.description.trim().length > 0 && Number.isFinite(qty) && qty > 0 && cents !== null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || cents === null) return;
    const ok = await run('add', () => addMaterial(ownerId, project.id, { description: form.description, quantity: qty, unit_label: form.unit, unit_cost_cents: cents, vendor: form.vendor, phase_id: form.phaseId, part_id: form.partId, expected_date: form.expected }), 'Material added.');
    if (ok) setForm(EMPTY);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Material cost" value={formatMoney(summary.totalCents, true)} hint={`${summary.lineCount} line${summary.lineCount === 1 ? '' : 's'}`} />
        <Stat label="Still to order" value={formatMoney(summary.byStatus.planned.cents, true)} hint={`${summary.byStatus.planned.count} planned`} />
        <Stat label="On site" value={formatMoney(summary.byStatus.delivered.cents + summary.byStatus.installed.cents, true)} hint={`${summary.byStatus.delivered.count + summary.byStatus.installed.count} delivered or installed`} />
        <Stat label="Forecast margin" value={margin.marginPercent === null ? '—' : `${margin.marginPercent.toFixed(1)}%`} hint={margin.level === 'unknown' ? 'Set a contract value' : `${formatMoney(margin.marginCents, true)} after labor`} tone={marginTone[margin.level] === 'danger' ? 'danger' : marginTone[margin.level] === 'warning' ? 'warning' : marginTone[margin.level] === 'success' ? 'success' : undefined} />
      </div>

      <section>
        <SectionHeader title="Bill of materials" description="Plan, order and track equipment and parts. Costs feed the margin forecast." />
        {materials.length === 0 ? (
          <EmptyState icon={Package} title="No materials yet" description="Add the equipment and parts this install needs, with expected cost and delivery dates." />
        ) : (
          <ul className="space-y-2">
            {materials.map((m) => (
              <li key={m.id} className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">{m.description}</p>
                  <p className="truncate text-xs text-text-secondary">
                    {m.quantity} {m.unit_label || 'ea'} × {formatMoney(m.unit_cost_cents)}
                    {m.vendor ? ` · ${m.vendor}` : ''}
                    {m.expected_date ? ` · expected ${formatDate(m.expected_date)}` : ''}
                    {m.phase_id ? ` · ${phases.find((p) => p.id === m.phase_id)?.name ?? ''}` : ''}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums text-text-primary">{formatMoney(materialLineCents(m))}</p>
                <Pill tone={materialTone[m.status]}>{MATERIAL_STATUS_LABEL[m.status]}</Pill>
                <select aria-label={`Status for ${m.description}`} className={`${selectClass} !w-auto`} value={m.status} disabled={busyKey === `st-${m.id}`} onChange={(e) => run(`st-${m.id}`, () => setMaterialStatus(ownerId, m.id, e.target.value as MaterialStatus))}>
                  {MATERIAL_STATUS_ORDER.map((s) => <option key={s} value={s}>{MATERIAL_STATUS_LABEL[s]}</option>)}
                </select>
                <button type="button" aria-label={`Delete ${m.description}`} onClick={() => ask({ title: 'Delete material?', description: `“${m.description}” will be removed from the bill of materials.`, label: 'Delete material', onConfirm: () => run(`del-${m.id}`, () => deleteMaterial(ownerId, m.id), 'Material deleted.') })} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500">
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={submit} className={`${panelClass} space-y-3`}>
        <h3 className="text-sm font-semibold text-text-primary">Add material</h3>
        {parts.length > 0 && (
          <select aria-label="Inventory part" className={selectClass} value={form.partId} onChange={(e) => pickPart(e.target.value)}>
            <option value="">Pick from inventory (optional)…</option>
            {parts.map((p) => <option key={p.id} value={p.id}>{p.name}{p.part_number ? ` · ${p.part_number}` : ''}</option>)}
          </select>
        )}
        <div className="grid gap-2 sm:grid-cols-6">
          <div className="sm:col-span-3"><Input aria-label="Description" placeholder="Description" value={form.description} onChange={(e) => set('description', e.target.value)} className="py-2 text-sm" maxLength={200} /></div>
          <Input aria-label="Quantity" type="number" min={0} step="0.01" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} className="py-2 text-sm" />
          <Input aria-label="Unit" placeholder="Unit (ft, ea)" value={form.unit} onChange={(e) => set('unit', e.target.value)} className="py-2 text-sm" />
          <Input aria-label="Unit cost in dollars" inputMode="decimal" placeholder="Unit cost $" value={form.cost} onChange={(e) => set('cost', e.target.value)} className="py-2 text-sm" error={form.cost !== '' && cents === null ? 'Invalid amount' : undefined} />
          <div className="sm:col-span-2"><Input aria-label="Vendor" placeholder="Vendor" value={form.vendor} onChange={(e) => set('vendor', e.target.value)} className="py-2 text-sm" /></div>
          <div className="sm:col-span-2"><Input aria-label="Expected delivery" type="date" value={form.expected} onChange={(e) => set('expected', e.target.value)} className="py-2 text-sm" /></div>
          <select aria-label="Phase" className={`${selectClass} sm:col-span-2`} value={form.phaseId} onChange={(e) => set('phaseId', e.target.value)}>
            <option value="">Any phase</option>
            {phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!valid || busyKey === 'add'}><Plus size={14} aria-hidden="true" /> Add material</Button>
        </div>
      </form>
      {dialog}
    </div>
  );
}
