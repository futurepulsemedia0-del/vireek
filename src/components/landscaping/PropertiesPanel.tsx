import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { Pill, SelectField } from '@/components/tradePacks/shared';
import {
  deleteArea,
  friendlyLandscapingError,
  listAreas,
  listCustomers,
  listProperties,
  saveArea,
  saveProperty,
  useLandscapeLoader,
  type Property,
  type PropertyArea,
} from '@/lib/landscapingApi';
import { PanelState, Section } from './ui';

const numOrNull = (v: string): number | null => (v.trim() === '' ? null : Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : null);
const sqft = (n: number | null) => (n === null ? '—' : `${n.toLocaleString()} sq ft`);

function Areas({ ownerId, property, canManage }: { ownerId: string; property: Property; canManage: boolean }) {
  const { toast } = useToast();
  const areas = useLandscapeLoader((o) => listAreas(o, property.id), [property.id]);
  const [name, setName] = useState('');
  const [type, setType] = useState<PropertyArea['area_type']>('turf');
  const [area, setArea] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<PropertyArea | null>(null);
  const list = areas.data ?? [];
  const turfSum = list.filter((a) => a.area_type === 'turf').reduce((s, a) => s + (a.sqft ?? 0), 0);

  const add = async () => {
    setBusy(true);
    try {
      await saveArea(ownerId, { property_id: property.id, name, area_type: type, sqft: numOrNull(area), measured_on: new Date().toISOString().slice(0, 10) });
      setName('');
      setArea('');
      areas.reload();
    } catch (e) {
      toast(friendlyLandscapingError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-border p-3">
      <h4 className="text-sm font-medium text-text-primary">Service areas</h4>
      <PanelState loading={areas.loading} error={areas.error} empty={list.length === 0} emptyTitle="No areas recorded" emptyDescription="Break the property into zones (front lawn, back lawn, beds…) with measured square feet." onRetry={areas.reload}>
        <ul className="mt-2 space-y-1">
          {list.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
              <span>{a.name} <Pill>{a.area_type}</Pill> · {sqft(a.sqft)} · {a.measured_via}{a.measured_on ? ` · ${a.measured_on}` : ''}</span>
              {canManage && <Button size="xs" variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => setRemoving(a)}><Trash2 className="h-4 w-4" /></Button>}
            </li>
          ))}
        </ul>
        {property.turf_sqft !== null && turfSum > 0 && Math.abs(turfSum - property.turf_sqft) > property.turf_sqft * 0.1 && (
          <p role="status" className="mt-2 text-xs text-warning">Turf areas add up to {turfSum.toLocaleString()} sq ft but the property says {property.turf_sqft.toLocaleString()} sq ft.</p>
        )}
      </PanelState>
      {canManage && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Input label="Area name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <SelectField label="Type" value={type} onChange={(x) => setType(x as PropertyArea['area_type'])}>
            {['turf', 'bed', 'hardscape', 'tree', 'hedge', 'driveway', 'walkway', 'other'].map((t) => <option key={t} value={t}>{t}</option>)}
          </SelectField>
          <Input label="Sq ft" type="number" min={0} value={area} onChange={(e) => setArea(e.target.value)} />
          <Button size="sm" variant="secondary" loading={busy} disabled={!name.trim()} onClick={() => void add()}><Plus className="mr-1 h-4 w-4" />Add</Button>
        </div>
      )}
      <ConfirmDialog open={removing !== null} title="Remove this area?" description={`“${removing?.name ?? ''}” will be deleted from the property record.`} confirmLabel="Remove" onCancel={() => setRemoving(null)} onConfirm={async () => { const a = removing; setRemoving(null); if (a) { try { await deleteArea(ownerId, a.id); areas.reload(); } catch (e) { toast(friendlyLandscapingError(e), 'error'); } } }} />
    </div>
  );
}

export function PropertiesPanel({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const props = useLandscapeLoader((o) => listProperties(o), []);
  const customers = useLandscapeLoader((o) => listCustomers(o), []);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ id?: string; customer_id: string; label: string; address: string; lot: string; turf: string; bed: string; hard: string; edge: string; slope: string; notes: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const list = props.data ?? [];
  const nameOf = (id: string) => customers.data?.find((c) => c.id === id)?.name ?? 'Customer';

  const edit = (p?: Property) =>
    setForm({ id: p?.id, customer_id: p?.customer_id ?? '', label: p?.label ?? '', address: p?.address ?? '', lot: p?.lot_sqft?.toString() ?? '', turf: p?.turf_sqft?.toString() ?? '', bed: p?.bed_sqft?.toString() ?? '', hard: p?.hardscape_sqft?.toString() ?? '', edge: p?.edge_ft?.toString() ?? '', slope: p?.slope ?? '', notes: p?.access_notes ?? '' });

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await saveProperty(ownerId, { id: form.id, customer_id: form.customer_id, label: form.label, address: form.address, lot_sqft: numOrNull(form.lot), turf_sqft: numOrNull(form.turf), bed_sqft: numOrNull(form.bed), hardscape_sqft: numOrNull(form.hard), edge_ft: numOrNull(form.edge), slope: (form.slope || null) as Property['slope'], access_notes: form.notes });
      toast('Property saved', 'success');
      setForm(null);
      props.reload();
    } catch (e) {
      toast(friendlyLandscapingError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (form) {
    const f = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
    return (
      <Section title={form.id ? 'Edit property' : 'New property'}>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Customer" required value={form.customer_id} onChange={(x) => setForm({ ...form, customer_id: x })} disabled={!!form.id}>
            <option value="">Select…</option>
            {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SelectField>
          <Input label="Label" required value={form.label} maxLength={120} onChange={f('label')} />
          <Input label="Address" value={form.address} maxLength={300} onChange={f('address')} />
          <SelectField label="Slope" value={form.slope} onChange={(x) => setForm({ ...form, slope: x })}><option value="">Unknown</option><option value="flat">Flat</option><option value="gentle">Gentle</option><option value="steep">Steep</option></SelectField>
          <Input label="Lot (sq ft)" type="number" min={0} value={form.lot} onChange={f('lot')} />
          <Input label="Turf (sq ft)" type="number" min={0} value={form.turf} onChange={f('turf')} />
          <Input label="Beds (sq ft)" type="number" min={0} value={form.bed} onChange={f('bed')} />
          <Input label="Hardscape (sq ft)" type="number" min={0} value={form.hard} onChange={f('hard')} />
          <Input label="Edging (linear ft)" type="number" min={0} value={form.edge} onChange={f('edge')} />
          <Input label="Access notes" value={form.notes} maxLength={2000} onChange={f('notes')} helperText="Gate, dogs, parking. Avoid storing codes you don't need." />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setForm(null)} disabled={busy}>Cancel</Button>
          <Button loading={busy} disabled={!form.customer_id || !form.label.trim()} onClick={() => void save()}>Save property</Button>
        </div>
      </Section>
    );
  }

  return (
    <Section title="Properties & service areas" description="Measured sizes drive pricing and crew time. Break a property into service areas for precise quotes." actions={canManage && <Button size="sm" onClick={() => edit()}><Plus className="mr-1 h-4 w-4" />New property</Button>}>
      <PanelState loading={props.loading} error={props.error} empty={list.length === 0} emptyTitle="No properties yet" emptyDescription="Add a property to record its measurements." onRetry={props.reload}>
        <ul className="space-y-3">
          {list.map((p) => (
            <li key={p.id} className="rounded-xl border border-border bg-bg-secondary p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-text-primary">{p.label} <span className="text-xs font-normal text-text-secondary">· {nameOf(p.customer_id)}</span></p>
                  <p className="text-xs text-text-secondary">{p.address ?? 'No address'} · turf {sqft(p.turf_sqft)} · beds {sqft(p.bed_sqft)} · lot {sqft(p.lot_sqft)}{p.slope ? ` · ${p.slope} slope` : ''}</p>
                </div>
                <div className="flex gap-2">
                  {canManage && <Button size="xs" variant="secondary" onClick={() => edit(p)}>Edit</Button>}
                  <Button size="xs" variant="ghost" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>Areas</Button>
                </div>
              </div>
              {open === p.id && <Areas ownerId={ownerId} property={p} canManage={canManage} />}
            </li>
          ))}
        </ul>
      </PanelState>
    </Section>
  );
}
