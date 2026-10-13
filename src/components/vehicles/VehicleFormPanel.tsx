import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import {
  EMPTY_VEHICLE_FORM, FUEL_TYPES, VEHICLE_STATUSES, humanize, parseVehicleForm, vehicleToForm,
  type FieldErrors, type Vehicle, type VehicleFormValues, type VehiclePayload,
} from '@/lib/vehicleManagement';
import { Section, SelectField } from './shared';

interface Props {
  vehicle?: Vehicle;
  saving: boolean;
  onSubmit: (payload: VehiclePayload) => void;
  onCancel: () => void;
}

export function VehicleFormPanel({ vehicle, saving, onSubmit, onCancel }: Props) {
  const [form, setForm] = useState<VehicleFormValues>(() => (vehicle ? vehicleToForm(vehicle) : EMPTY_VEHICLE_FORM));
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = (key: keyof VehicleFormValues) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = parseVehicleForm(form, new Date());
    if (!result.ok) {
      setErrors(result.errors);
      const first = Object.keys(result.errors)[0];
      document.getElementById(`vehicle-form-${first}`)?.focus();
      return;
    }
    onSubmit(result.value);
  };

  return (
    <Section title={vehicle ? `Edit ${vehicle.label}` : 'Add a vehicle'}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Input id="vehicle-form-label" label="Name" required placeholder="Truck 1" value={form.label} onChange={set('label')} error={errors.label} maxLength={80} />
          <Input id="vehicle-form-make" label="Make" placeholder="Ford" value={form.make} onChange={set('make')} />
          <Input id="vehicle-form-model" label="Model" placeholder="Transit 250" value={form.model} onChange={set('model')} />
          <Input id="vehicle-form-year" label="Year" type="number" inputMode="numeric" placeholder="2022" value={form.year} onChange={set('year')} error={errors.year} />
          <Input id="vehicle-form-license_plate" label="License plate" value={form.license_plate} onChange={set('license_plate')} error={errors.license_plate} maxLength={16} />
          <Input id="vehicle-form-vin" label="VIN" value={form.vin} onChange={set('vin')} error={errors.vin} maxLength={17} autoCapitalize="characters" />
          <SelectField id="vehicle-form-fuel_type" label="Fuel type" value={form.fuel_type} onChange={set('fuel_type')} error={errors.fuel_type}>
            {FUEL_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
          </SelectField>
          <SelectField id="vehicle-form-status" label="Status" value={form.status} onChange={set('status')} error={errors.status}>
            {VEHICLE_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </SelectField>
          <Input id="vehicle-form-odometer_miles" label="Odometer (mi)" type="number" inputMode="decimal" min="0" value={form.odometer_miles} onChange={set('odometer_miles')} error={errors.odometer_miles} />
          <Input id="vehicle-form-purchase_date" label="Purchase date" type="date" value={form.purchase_date} onChange={set('purchase_date')} error={errors.purchase_date} />
          <Input id="vehicle-form-monthly_payment_cost" label="Monthly payment" type="number" inputMode="decimal" min="0" step="0.01" value={form.monthly_payment_cost} onChange={set('monthly_payment_cost')} error={errors.monthly_payment_cost} />
          <Input id="vehicle-form-monthly_insurance_cost" label="Monthly insurance" type="number" inputMode="decimal" min="0" step="0.01" value={form.monthly_insurance_cost} onChange={set('monthly_insurance_cost')} error={errors.monthly_insurance_cost} />
        </div>
        <Textarea id="vehicle-form-notes" label="Notes" rows={3} value={form.notes} onChange={set('notes')} error={errors.notes} maxLength={2000} />
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : vehicle ? 'Save changes' : 'Add vehicle'}</Button>
        </div>
      </form>
    </Section>
  );
}
