import { useState } from 'react';
import { CreditCard, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { deleteCard, saveCard, type FuelVehicle } from '@/lib/fuelCardsApi';
import {
  CARD_STATUSES, EMPTY_CARD_FORM, PROVIDER_SUGGESTIONS, formatGallons, humanize, maskCard, parseCardForm,
  type CardFormValues, type CardStatus, type FuelCard,
} from '@/lib/fuelCards';
import type { FieldErrors, Technician } from '@/lib/vehicleManagement';
import { Pill, SelectField, type Tone } from '@/components/vehicles/shared';

const STATUS_TONE: Record<CardStatus, Tone> = { active: 'success', suspended: 'warning', cancelled: 'neutral' };

interface Props {
  cards: FuelCard[];
  vehicles: FuelVehicle[];
  technicians: Technician[];
  unknownLast4: string[];
  onChanged: () => Promise<unknown> | void;
}

const toForm = (c: FuelCard): CardFormValues => ({
  label: c.label, provider: c.provider, last4: c.card_last4, vehicle_id: c.vehicle_id ?? '', technician_id: c.technician_id ?? '',
  status: c.status, tank_capacity: c.tank_capacity_gallons == null ? '' : String(c.tank_capacity_gallons), notes: c.notes ?? '',
});

export function FuelCardsTab({ cards, vehicles, technicians, unknownLast4, onChanged }: Props) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<null | 'new' | string>(null);
  const [form, setForm] = useState<CardFormValues>(EMPTY_CARD_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<FuelCard | null>(null);

  const vehicleName = (id: string | null) => vehicles.find((v) => v.id === id)?.label ?? null;
  const driverName = (id: string | null) => {
    const t = technicians.find((x) => x.id === id);
    return t ? t.member_name?.trim() || t.member_email : null;
  };
  const set = (k: keyof CardFormValues) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const open = (card: FuelCard | null, last4 = '') => {
    setForm(card ? toForm(card) : { ...EMPTY_CARD_FORM, last4 });
    setErrors({});
    setEditing(card ? card.id : 'new');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const result = parseCardForm(form);
    if (!result.ok) { setErrors(result.errors); return; }
    setSaving(true);
    try {
      await saveCard(result.value, editing && editing !== 'new' ? editing : null);
      toast(editing === 'new' ? 'Card added.' : 'Card updated.', 'success');
      setEditing(null);
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the card.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      await deleteCard(target.id);
      toast('Card deleted.', 'success');
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the card.', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">Register each card so purchases are matched to the right vehicle and driver. Only the last 4 digits are stored.</p>
        <Button size="sm" onClick={() => open(null)} disabled={editing === 'new'}><Plus size={16} /> Add card</Button>
      </div>

      {unknownLast4.length > 0 && (
        <div role="status" className="rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
          <p className="font-medium">Unregistered cards found in your transactions</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {unknownLast4.map((l4) => (
              <Button key={l4} size="sm" variant="secondary" onClick={() => open(null, l4)}>Register {maskCard(l4)}</Button>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <form onSubmit={submit} noValidate className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-text-primary">{editing === 'new' ? 'Add fuel card' : 'Edit fuel card'}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Card name" required value={form.label} onChange={set('label')} error={errors.label} maxLength={80} placeholder="Truck 1 fuel card" />
            <Input label="Last 4 digits" required inputMode="numeric" value={form.last4} onChange={set('last4')} error={errors.last4} maxLength={4} placeholder="1234" />
            <div>
              <Input label="Provider" list="fuel-providers" value={form.provider} onChange={set('provider')} error={errors.provider} maxLength={40} placeholder="WEX, Fleetcor, Comdata…" />
              <datalist id="fuel-providers">{PROVIDER_SUGGESTIONS.map((p) => <option key={p} value={p} />)}</datalist>
            </div>
            <SelectField label="Status" value={form.status} onChange={set('status')}>
              {CARD_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </SelectField>
            <SelectField label="Vehicle" value={form.vehicle_id} onChange={set('vehicle_id')}>
              <option value="">No vehicle (match by plate)</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}{v.license_plate ? ` · ${v.license_plate}` : ''}</option>)}
            </SelectField>
            <SelectField label="Assigned driver" value={form.technician_id} onChange={set('technician_id')}>
              <option value="">Use the vehicle’s driver at the time</option>
              {technicians.map((t) => <option key={t.id} value={t.id}>{t.member_name?.trim() || t.member_email}</option>)}
            </SelectField>
            <Input label="Tank capacity (gal)" type="number" inputMode="decimal" min={1} max={500} step="any" value={form.tank_capacity} onChange={set('tank_capacity')} error={errors.tank_capacity} helperText="Optional. Used to flag purchases larger than the tank." />
          </div>
          <Textarea label="Notes" rows={2} maxLength={500} value={form.notes} onChange={set('notes')} error={errors.notes} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save card'}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
          </div>
        </form>
      )}

      {cards.length === 0 && !editing ? (
        <EmptyState icon={CreditCard} title="No fuel cards yet" description="Add your cards to link every purchase to a vehicle and driver." action={{ label: 'Add card', onClick: () => open(null) }} />
      ) : (
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2" aria-label="Fuel cards">
          {cards.map((c) => (
            <li key={c.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{c.label}</p>
                  <p className="truncate text-xs text-text-secondary">{humanize(c.provider)} · {maskCard(c.card_last4)}</p>
                </div>
                <Pill tone={STATUS_TONE[c.status]}>{humanize(c.status)}</Pill>
              </div>
              <p className="mt-2 text-xs text-text-secondary">
                {[vehicleName(c.vehicle_id) ?? 'No vehicle', driverName(c.technician_id) ?? 'Driver by assignment', c.tank_capacity_gallons ? `Tank ${formatGallons(c.tank_capacity_gallons)}` : null].filter(Boolean).join(' · ')}
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => open(c)} aria-label={`Edit ${c.label}`}><Pencil size={14} /> Edit</Button>
                <Button size="sm" variant="ghost" onClick={() => setPendingDelete(c)} aria-label={`Delete ${c.label}`}><Trash2 size={14} /> Delete</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this card?"
        description="Cards that already have transactions can’t be deleted — set them to Cancelled instead."
        confirmLabel="Delete card"
        onConfirm={remove}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
