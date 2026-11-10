import { useMemo, useState } from 'react';
import { Archive, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { archiveUnit, fetchUnits, friendlySolarError, parseSerials, saveUnit, useAsyncData, type SolarUnit, type UnitInput } from '@/lib/solarApi';
import { daysUntil, effectiveWarrantyEnd, warrantyState, type WarrantyState } from '@/lib/tradePacks/solarPipeline';
import { Pill, SelectField, fmtDate } from './shared';

const KINDS = ['panel', 'inverter', 'battery', 'optimizer', 'meter', 'other'] as const;
const blank: UnitInput = { component_kind: 'panel', make: '', model: '', quantity: '1', serials: '', installed_on: '', warranty_start: '', product_warranty_years: '', performance_warranty_years: '', warranty_expires_override: '', warranty_terms: '' };
const tone = (s: WarrantyState) => (s === 'expired' ? 'danger' : s === 'expiring_soon' ? 'warning' : s === 'active' ? 'success' : 'neutral');
const LABEL: Record<WarrantyState, string> = { unknown: 'No warranty data', active: 'In warranty', expiring_soon: 'Expiring soon', expired: 'Expired' };

export function SolarEquipmentView({ ownerId, projectId }: { ownerId: string; projectId: string }) {
  const { toast } = useToast();
  const units = useAsyncData(() => fetchUnits(ownerId, projectId), [ownerId, projectId], 'Could not load equipment.');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<UnitInput>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof UnitInput>(k: K, v: UnitInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const today = new Date().toISOString().slice(0, 10);
  const serialCount = useMemo(() => parseSerials(form.serials).length, [form.serials]);

  const open = (u?: SolarUnit) => {
    setError(null);
    setEditing(u ? u.id : 'new');
    setForm(u ? { component_kind: u.component_kind, make: u.make ?? '', model: u.model ?? '', quantity: String(u.quantity), serials: u.serials.join('\n'), installed_on: u.installed_on ?? '', warranty_start: u.warranty_start ?? '', product_warranty_years: u.product_warranty_years?.toString() ?? '', performance_warranty_years: u.performance_warranty_years?.toString() ?? '', warranty_expires_override: u.warranty_expires_override ?? '', warranty_terms: u.warranty_terms ?? '' } : blank);
  };
  const submit = async () => {
    if (serialCount > Number(form.quantity || 1)) { setError('More serial numbers than the quantity.'); return; }
    if ((form.product_warranty_years || form.performance_warranty_years) && !form.warranty_start) { setError('Set the warranty start date.'); return; }
    setBusy(true); setError(null);
    try { await saveUnit(ownerId, projectId, form, editing === 'new' ? undefined : (editing as string)); toast('Equipment saved', 'success'); setEditing(null); await units.reload(); }
    catch (e) { setError(friendlySolarError(e)); } finally { setBusy(false); }
  };
  const archive = async (id: string) => {
    setBusy(true);
    try { await archiveUnit(ownerId, id); toast('Unit archived', 'info'); await units.reload(); } catch (e) { toast(friendlySolarError(e), 'error'); } finally { setBusy(false); }
  };

  if (units.loading) return <Skeleton className="h-40 w-full rounded-2xl" />;
  const list = units.data ?? [];
  return (
    <div className="space-y-4">
      {units.error && <p className="text-sm text-danger" role="alert">{units.error}</p>}
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">Panel, inverter and battery serials with warranty terms. Warranty end = start + years − 1 day unless you enter the manufacturer’s date.</p>
        {editing === null && <Button onClick={() => open()}>Add equipment</Button>}
      </div>
      {editing !== null && (
        <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <SelectField label="Type" value={form.component_kind} onChange={(v) => set('component_kind', v as UnitInput['component_kind'])}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</SelectField>
            <Input label="Make" value={form.make} onChange={(e) => set('make', e.target.value)} />
            <Input label="Model" value={form.model} onChange={(e) => set('model', e.target.value)} />
            <Input label="Quantity" type="number" min={1} max={5000} value={form.quantity} onChange={(e) => set('quantity', e.target.value)} />
          </div>
          <Textarea label={`Serial numbers (${serialCount} entered) — one per line or comma-separated`} value={form.serials} onChange={(e) => set('serials', e.target.value)} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Installed on" type="date" value={form.installed_on} onChange={(e) => set('installed_on', e.target.value)} />
            <Input label="Warranty start" type="date" value={form.warranty_start} onChange={(e) => set('warranty_start', e.target.value)} />
            <Input label="Manufacturer end date (override)" type="date" value={form.warranty_expires_override} onChange={(e) => set('warranty_expires_override', e.target.value)} />
            <Input label="Product warranty (years)" type="number" min={1} max={40} value={form.product_warranty_years} onChange={(e) => set('product_warranty_years', e.target.value)} />
            <Input label="Performance warranty (years)" type="number" min={1} max={50} value={form.performance_warranty_years} onChange={(e) => set('performance_warranty_years', e.target.value)} />
          </div>
          <Textarea label="Warranty terms (as stated by the manufacturer)" value={form.warranty_terms} onChange={(e) => set('warranty_terms', e.target.value)} />
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <div className="flex gap-2"><Button onClick={submit} loading={busy}>Save</Button><Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button></div>
        </div>
      )}
      {list.length === 0 && editing === null ? <p className="text-sm text-text-secondary">No equipment registered for this project yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Equipment registry</caption>
            <thead className="text-text-secondary"><tr><th className="py-2 pr-3">Item</th><th className="pr-3">Qty</th><th className="pr-3">Serials</th><th className="pr-3">Warranty</th><th /></tr></thead>
            <tbody>
              {list.map((u) => {
                const end = effectiveWarrantyEnd(u);
                const st = warrantyState(end, today);
                return (
                  <tr key={u.id} className="border-t border-border align-top">
                    <td className="py-2 pr-3"><span className="font-medium capitalize text-text-primary">{u.component_kind}</span><br /><span className="text-text-secondary">{[u.make, u.model].filter(Boolean).join(' ') || '—'}</span></td>
                    <td className="pr-3">{u.quantity}</td>
                    <td className="pr-3 text-text-secondary">{u.serials.length ? `${u.serials.length} recorded` : '—'}</td>
                    <td className="pr-3"><Pill tone={tone(st)}>{LABEL[st]}</Pill>{end && <span className="ml-2 text-text-secondary">to {fmtDate(end)}{st !== 'expired' ? ` (${daysUntil(end, today)} d)` : ''}</span>}</td>
                    <td className="space-x-1 text-right">
                      <Button size="sm" variant="ghost" iconOnly aria-label={`Edit ${u.component_kind}`} onClick={() => open(u)}><Pencil size={14} /></Button>
                      <Button size="sm" variant="ghost" iconOnly aria-label={`Archive ${u.component_kind}`} disabled={busy} onClick={() => archive(u.id)}><Archive size={14} /></Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
