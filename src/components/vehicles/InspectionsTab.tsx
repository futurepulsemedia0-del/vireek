import { useState } from 'react';
import { ClipboardCheck, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { createInspection, deleteInspection, fetchInspections } from '@/lib/vehicleManagementApi';
import {
  INSPECTION_RESULTS, INSPECTION_TYPES, formatMiles, humanize, newChecklist, parseInspectionForm, suggestInspectionResult,
  type ChecklistStatus, type FieldErrors, type InspectionFormValues, type InspectionResult, type Vehicle, type VehicleInspection,
} from '@/lib/vehicleManagement';
import { ErrorState, Pill, Section, SelectField, formatDateTime, useLoader, type Tone } from './shared';

interface Props {
  vehicle: Vehicle;
  ownerId: string;
  onChanged: () => void;
}

const RESULT_TONE: Record<InspectionResult, Tone> = { pass: 'success', needs_attention: 'warning', fail: 'danger' };
const RESULT_LABEL: Record<InspectionResult, string> = { pass: 'Pass', needs_attention: 'Needs attention', fail: 'Fail' };
const STATUS_OPTIONS: { value: ChecklistStatus; label: string }[] = [{ value: 'ok', label: 'OK' }, { value: 'issue', label: 'Issue' }, { value: 'na', label: 'N/A' }];

const emptyForm = (): InspectionFormValues => ({ inspection_type: 'pre_trip', result: 'pass', odometer_miles: '', notes: '', items: newChecklist() });

export function InspectionsTab({ vehicle, ownerId, onChanged }: Props) {
  const { toast } = useToast();
  const list = useLoader(() => fetchInspections(vehicle.id), vehicle.id);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<InspectionFormValues>(emptyForm);
  const [resultTouched, setResultTouched] = useState(false);
  const [markInShop, setMarkInShop] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<VehicleInspection | null>(null);

  const setItem = (key: string, status: ChecklistStatus) =>
    setForm((f) => {
      const items = f.items.map((i) => (i.key === key ? { ...i, status } : i));
      // Keep the result in step with the checklist until the user picks one themselves.
      return { ...f, items, result: resultTouched ? f.result : suggestInspectionResult(items) };
    });

  const close = () => { setShowForm(false); setErrors({}); setForm(emptyForm()); setResultTouched(false); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = parseInspectionForm(form, vehicle.odometer_miles);
    if (!result.ok) { setErrors(result.errors); return; }
    setSaving(true);
    try {
      const shouldMove = result.value.result === 'fail' && vehicle.status === 'active' && markInShop;
      const moved = await createInspection(ownerId, vehicle.id, result.value, shouldMove);
      toast(shouldMove && !moved ? 'Inspection saved, but the vehicle status could not be changed.' : 'Inspection saved.', shouldMove && !moved ? 'error' : 'success');
      close();
      void list.reload();
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the inspection.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const rows = list.data ?? [];

  return (
    <div className="space-y-4">
      {showForm && (
        <Section title="New inspection">
          <form onSubmit={submit} noValidate className="space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField label="Inspection type" value={form.inspection_type} onChange={(e) => setForm((f) => ({ ...f, inspection_type: e.target.value }))} error={errors.inspection_type}>
                {INSPECTION_TYPES.map((t) => <option key={t} value={t}>{t === 'dot' ? 'DOT' : humanize(t)}</option>)}
              </SelectField>
              <Input label="Odometer (mi)" type="number" inputMode="numeric" min="0" value={form.odometer_miles} onChange={(e) => setForm((f) => ({ ...f, odometer_miles: e.target.value }))} error={errors.odometer_miles} helperText={`Current: ${formatMiles(vehicle.odometer_miles)}`} />
            </div>

            <fieldset>
              <legend className="mb-2 text-sm font-medium text-text-primary">Checklist</legend>
              <ul className="divide-y divide-border rounded-xl border border-border">
                {form.items.map((item) => (
                  <li key={item.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                    <span className="text-sm text-text-primary">{item.label}</span>
                    <div role="radiogroup" aria-label={item.label} className="flex overflow-hidden rounded-lg border border-border">
                      {STATUS_OPTIONS.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          role="radio"
                          aria-checked={item.status === o.value}
                          onClick={() => setItem(item.key, o.value)}
                          className={`focus-ring min-h-[36px] px-3 text-xs font-medium ${item.status === o.value ? (o.value === 'issue' ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent') : 'text-text-secondary hover:bg-bg-tertiary'}`}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </fieldset>

            <SelectField label="Result" required value={form.result} onChange={(e) => { setResultTouched(true); setForm((f) => ({ ...f, result: e.target.value })); }} error={errors.result}>
              {INSPECTION_RESULTS.map((r) => <option key={r} value={r}>{RESULT_LABEL[r]}</option>)}
            </SelectField>
            <Textarea label={form.result === 'pass' ? 'Notes (optional)' : 'What needs attention'} required={form.result !== 'pass'} rows={3} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} error={errors.notes} maxLength={2000} />

            {form.result === 'fail' && vehicle.status === 'active' && (
              <label className="flex items-start gap-2 text-sm text-text-primary">
                <input type="checkbox" checked={markInShop} onChange={(e) => setMarkInShop(e.target.checked)} className="mt-1" />
                Mark this vehicle as “In shop” until it is repaired
              </label>
            )}

            <div className="flex justify-end gap-3">
              <Button type="button" variant="ghost" size="sm" onClick={close} disabled={saving}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save inspection'}</Button>
            </div>
          </form>
        </Section>
      )}

      <Section title="Inspection history" action={!showForm ? <Button size="sm" onClick={() => setShowForm(true)}><Plus size={16} /> New inspection</Button> : undefined}>
        {list.loading && !list.data ? (
          <SkeletonCardList count={3} rows={1} />
        ) : list.error && !list.data ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : rows.length === 0 ? (
          <EmptyState icon={ClipboardCheck} title="No inspections recorded" description="Run a pre-trip, safety or annual inspection and keep the record here." action={showForm ? undefined : { label: 'New inspection', onClick: () => setShowForm(true) }} />
        ) : (
          <ul className="space-y-3">
            {rows.map((i) => {
              const issues = i.checklist.filter((c) => c.status === 'issue');
              return (
                <li key={i.id} className="rounded-xl border border-border bg-bg-primary p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{i.inspection_type === 'dot' ? 'DOT' : humanize(i.inspection_type)} inspection</p>
                      <p className="text-xs text-text-secondary">{formatDateTime(i.inspected_at)}{i.odometer_miles != null ? ` · ${formatMiles(i.odometer_miles)}` : ''}</p>
                    </div>
                    <Pill tone={RESULT_TONE[i.result]}>{RESULT_LABEL[i.result]}</Pill>
                  </div>
                  {issues.length > 0 && <p className="mt-2 text-sm text-danger">Issues: {issues.map((c) => c.label).join(', ')}</p>}
                  {i.notes && <p className="mt-2 break-words text-sm text-text-secondary">{i.notes}</p>}
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setPendingDelete(i)} aria-label={`Delete inspection from ${formatDateTime(i.inspected_at)}`}>Delete</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this inspection record?"
        description="Inspection records are an audit trail. Only delete one that was entered by mistake."
        confirmLabel="Delete record"
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (!target) return;
          try {
            await deleteInspection(target.id);
            toast('Inspection deleted.', 'success');
            void list.reload();
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not delete the inspection.', 'error');
          }
        }}
      />
    </div>
  );
}
