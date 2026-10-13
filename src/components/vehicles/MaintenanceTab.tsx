import { useMemo, useState } from 'react';
import { CalendarClock, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { completeMaintenance, createSchedule, deleteSchedule, setScheduleActive } from '@/lib/vehicleManagementApi';
import {
  SERVICE_PRESETS, evaluateSchedule, formatMiles, parseCompleteForm, parseScheduleForm, sortScheduleViews, toDateOnly,
  type CompleteFormValues, type FieldErrors, type MaintenanceSchedule, type ScheduleFormValues, type ScheduleHealth, type ScheduleView, type Vehicle,
} from '@/lib/vehicleManagement';
import { Pill, Section, formatDate, type Tone } from './shared';

interface Props {
  vehicle: Vehicle;
  schedules: MaintenanceSchedule[];
  ownerId: string;
  onChanged: () => void;
}

const HEALTH: Record<ScheduleHealth, { label: string; tone: Tone }> = {
  overdue: { label: 'Overdue', tone: 'danger' },
  due_soon: { label: 'Due soon', tone: 'warning' },
  ok: { label: 'On track', tone: 'success' },
  no_baseline: { label: 'No baseline', tone: 'neutral' },
  paused: { label: 'Paused', tone: 'neutral' },
};

const EMPTY_SCHEDULE: ScheduleFormValues = { name: '', interval_miles: '', interval_days: '', last_service_miles: '', last_service_date: '', notes: '' };
const EMPTY_COMPLETE: CompleteFormValues = { service_date: '', odometer: '', cost: '', notes: '' };

function remainingText(v: ScheduleView): string {
  const parts: string[] = [];
  if (v.milesRemaining != null) parts.push(v.milesRemaining < 0 ? `${Math.abs(v.milesRemaining).toLocaleString()} mi overdue` : `${v.milesRemaining.toLocaleString()} mi left`);
  if (v.daysRemaining != null) parts.push(v.daysRemaining < 0 ? `${Math.abs(v.daysRemaining)} days overdue` : `${v.daysRemaining} days left`);
  return parts.join(' · ') || 'Set a baseline by marking this service as done.';
}

export function MaintenanceTab({ vehicle, schedules, ownerId, onChanged }: Props) {
  const { toast } = useToast();
  const { currency } = useCurrency();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ScheduleFormValues>(EMPTY_SCHEDULE);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [completing, setCompleting] = useState<string | null>(null);
  const [complete, setComplete] = useState<CompleteFormValues>(EMPTY_COMPLETE);
  const [completeErrors, setCompleteErrors] = useState<FieldErrors>({});
  const [pendingDelete, setPendingDelete] = useState<MaintenanceSchedule | null>(null);

  const views = useMemo(
    () => sortScheduleViews(schedules.map((s) => evaluateSchedule(s, vehicle.odometer_miles, new Date()))),
    [schedules, vehicle.odometer_miles],
  );

  const run = async (key: string, action: () => Promise<void>, success: string): Promise<boolean> => {
    setBusy(key);
    try {
      await action();
      toast(success, 'success');
      onChanged();
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong.', 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const submitSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = parseScheduleForm(form, vehicle.odometer_miles, new Date());
    if (!result.ok) { setErrors(result.errors); return; }
    const ok = await run('new', () => createSchedule(ownerId, vehicle.id, result.value), 'Schedule added.');
    if (ok) { setForm(EMPTY_SCHEDULE); setErrors({}); setShowForm(false); }
  };

  const submitComplete = async (e: React.FormEvent, s: MaintenanceSchedule) => {
    e.preventDefault();
    const result = parseCompleteForm(complete, vehicle.odometer_miles, new Date());
    if (!result.ok) { setCompleteErrors(result.errors); return; }
    const ok = await run(s.id, () => completeMaintenance(s.id, result.value), `${s.name} recorded.`);
    if (ok) { setCompleting(null); setComplete(EMPTY_COMPLETE); setCompleteErrors({}); }
  };

  const startComplete = (s: MaintenanceSchedule) => {
    setCompleting(s.id);
    setCompleteErrors({});
    setComplete({ service_date: toDateOnly(new Date()), odometer: String(Math.round(vehicle.odometer_miles)), cost: '', notes: '' });
  };

  const setF = (k: keyof ScheduleFormValues) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setC = (k: keyof CompleteFormValues) => (e: { target: { value: string } }) => setComplete((f) => ({ ...f, [k]: e.target.value }));

  const addButton = !showForm && <Button size="sm" onClick={() => setShowForm(true)}><Plus size={16} /> Add schedule</Button>;

  return (
    <div className="space-y-4">
      {showForm && (
        <Section title="New maintenance schedule">
          <form onSubmit={submitSchedule} noValidate className="space-y-4">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Quick presets">
              {SERVICE_PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, name: p.name, interval_miles: p.miles ? String(p.miles) : '', interval_days: p.days ? String(p.days) : '' }))}
                  className="focus-ring rounded-full border border-border px-3 py-1 text-xs text-text-secondary hover:border-accent/40 hover:text-text-primary"
                >
                  {p.name}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Input label="Service" required value={form.name} onChange={setF('name')} error={errors.name} maxLength={80} placeholder="Oil & filter change" />
              <Input label="Every (miles)" type="number" inputMode="numeric" min="1" value={form.interval_miles} onChange={setF('interval_miles')} error={errors.interval_miles} />
              <Input label="Every (days)" type="number" inputMode="numeric" min="1" value={form.interval_days} onChange={setF('interval_days')} error={errors.interval_days} />
              <Input label="Last done at (mi)" type="number" inputMode="numeric" min="0" value={form.last_service_miles} onChange={setF('last_service_miles')} error={errors.last_service_miles} helperText={`Blank = now (${formatMiles(vehicle.odometer_miles)})`} />
              <Input label="Last done on" type="date" value={form.last_service_date} onChange={setF('last_service_date')} error={errors.last_service_date} helperText="Blank = today" />
            </div>
            <Textarea label="Notes (optional)" rows={2} value={form.notes} onChange={setF('notes')} error={errors.notes} maxLength={500} />
            <div className="flex justify-end gap-3">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setShowForm(false); setErrors({}); }} disabled={busy === 'new'}>Cancel</Button>
              <Button type="submit" size="sm" disabled={busy === 'new'}>{busy === 'new' ? 'Saving…' : 'Save schedule'}</Button>
            </div>
          </form>
        </Section>
      )}

      <Section title="Service schedules" action={addButton || undefined}>
        {views.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No maintenance schedules" description="Add oil changes, inspections and other recurring services so nothing gets missed." action={showForm ? undefined : { label: 'Add schedule', onClick: () => setShowForm(true) }} />
        ) : (
          <ul className="space-y-3">
            {views.map((v) => {
              const s = v.schedule;
              const h = HEALTH[v.health];
              const intervals = [s.interval_miles ? `${s.interval_miles.toLocaleString()} mi` : null, s.interval_days ? `${s.interval_days} days` : null].filter(Boolean).join(' or ');
              return (
                <li key={s.id} className="rounded-xl border border-border bg-bg-primary p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{s.name}</p>
                      <p className="text-xs text-text-secondary">Every {intervals}</p>
                    </div>
                    <Pill tone={h.tone}>{h.label}</Pill>
                  </div>
                  <p className={`mt-2 text-sm ${v.health === 'overdue' ? 'text-danger' : 'text-text-secondary'}`}>{s.active ? remainingText(v) : 'Reminders paused.'}</p>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    Last done {s.last_service_date ? formatDate(s.last_service_date) : '—'}{s.last_service_miles != null ? ` at ${formatMiles(s.last_service_miles)}` : ''}
                  </p>

                  {completing === s.id ? (
                    <form onSubmit={(e) => submitComplete(e, s)} noValidate className="mt-4 space-y-3 border-t border-border pt-4">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <Input label="Service date" type="date" required value={complete.service_date} onChange={setC('service_date')} error={completeErrors.service_date} />
                        <Input label="Odometer (mi)" type="number" inputMode="numeric" min="0" value={complete.odometer} onChange={setC('odometer')} error={completeErrors.odometer} />
                        <Input label={`Cost (${currency})`} type="number" inputMode="decimal" min="0" step="0.01" value={complete.cost} onChange={setC('cost')} error={completeErrors.cost} helperText="Logged as a maintenance expense" />
                      </div>
                      <Input label="Notes (optional)" value={complete.notes} onChange={setC('notes')} error={completeErrors.notes} maxLength={300} />
                      <div className="flex justify-end gap-3">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setCompleting(null)} disabled={busy === s.id}>Cancel</Button>
                        <Button type="submit" size="sm" disabled={busy === s.id}>{busy === s.id ? 'Saving…' : 'Record service'}</Button>
                      </div>
                    </form>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {s.active && <Button size="sm" variant="secondary" onClick={() => startComplete(s)} disabled={busy === s.id}>Mark serviced</Button>}
                      <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => run(s.id, () => setScheduleActive(s.id, !s.active), s.active ? 'Schedule paused.' : 'Schedule resumed.')}>{s.active ? 'Pause' : 'Resume'}</Button>
                      <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => setPendingDelete(s)}>Delete</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this schedule?"
        description={`"${pendingDelete?.name ?? ''}" will stop tracking for ${vehicle.label}. Logged expenses are kept.`}
        confirmLabel="Delete schedule"
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) await run(target.id, () => deleteSchedule(target.id), 'Schedule deleted.');
        }}
      />
    </div>
  );
}
