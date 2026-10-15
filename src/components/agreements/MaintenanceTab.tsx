import { useMemo, useState } from 'react';
import { CalendarClock, CalendarPlus, Check, Pause, Play, Plus, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import {
  PM_STATUS_LABELS,
  PM_STATUS_STYLES,
  defaultNextDue,
  deleteAgreementRow,
  equipmentLabel,
  formatDate,
  insertAgreementRow,
  insertAgreementRows,
  pmStatus,
  siteLabel,
  toDateKey,
  updateAgreementRow,
  type PmPlanRow,
} from '@/lib/serviceAgreement';
import { CheckField, DeleteConfirm, FormActions, Panel, Pill, RowActions, SelectField, StatTile, useInlineForm, type TabProps } from './AgreementUi';
import { useAgreementActions } from './useAgreementActions';

interface PlanForm {
  name: string;
  scope: 'equipment' | 'site' | 'type';
  equipment_id: string;
  site_id: string;
  equipment_type: string;
  frequency_months: string;
  estimated_minutes: string;
  next_due_date: string;
  checklist: string;
  active: boolean;
}
const EMPTY_PLAN: PlanForm = { name: '', scope: 'equipment', equipment_id: '', site_id: '', equipment_type: '', frequency_months: '12', estimated_minutes: '', next_due_date: '', checklist: '', active: true };
const FREQUENCIES = [1, 2, 3, 4, 6, 12, 24, 36];

const STATUS_RANK = { overdue: 0, due_soon: 1, unscheduled: 2, scheduled: 3, paused: 4 } as const;

export function MaintenanceTab({ data, canManage, ownerId, reload }: TabProps) {
  const { busy, run } = useAgreementActions(reload);
  const form = useInlineForm<PlanForm>(EMPTY_PLAN);
  const [deleting, setDeleting] = useState<{ id: string; label: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const equipmentById = useMemo(() => new Map(data.equipment.map((e) => [e.id, e])), [data.equipment]);
  const siteById = useMemo(() => new Map(data.sites.map((s) => [s.id, s])), [data.sites]);
  const now = new Date();

  const rows = useMemo(
    () =>
      data.pmPlans
        .map((p) => ({ plan: p, ...pmStatus(p) }))
        .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.days ?? 9999) - (b.days ?? 9999)),
    [data.pmPlans]
  );
  const counts = {
    active: data.pmPlans.filter((p) => p.active).length,
    overdue: rows.filter((r) => r.status === 'overdue').length,
    soon: rows.filter((r) => r.status === 'due_soon').length,
  };

  // Covered equipment that has no plan yet — one click turns each unit's service interval into a plan.
  const planned = new Set(data.pmPlans.map((p) => p.equipment_id).filter((x): x is string => !!x));
  const unplanned = data.assets
    .filter((a) => a.equipment_id && a.coverage_level !== 'excluded' && !planned.has(a.equipment_id))
    .map((a) => equipmentById.get(a.equipment_id as string))
    .filter((e): e is NonNullable<typeof e> => !!e && e.status === 'active');

  const scopeLabel = (p: PmPlanRow): string => {
    if (p.equipment_id) {
      const e = equipmentById.get(p.equipment_id);
      return e ? equipmentLabel(e) : 'Equipment (removed)';
    }
    if (p.site_id) {
      const s = siteById.get(p.site_id);
      return s ? siteLabel(s) : 'Property (removed)';
    }
    return p.equipment_type ? `All ${p.equipment_type}` : 'Whole agreement';
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = form.form;
    const freq = Number(f.frequency_months);
    const minutes = f.estimated_minutes.trim() === '' ? null : Number(f.estimated_minutes);
    if (!f.name.trim()) return setFormError('Give the plan a name.');
    if (!Number.isInteger(freq) || freq < 1 || freq > 60) return setFormError('Frequency must be 1–60 months.');
    if (minutes !== null && (!Number.isInteger(minutes) || minutes <= 0)) return setFormError('Estimated minutes must be a positive whole number.');
    if (f.scope === 'equipment' && !f.equipment_id) return setFormError('Choose the equipment this plan covers.');
    if (f.scope === 'site' && !f.site_id) return setFormError('Choose the property this plan covers.');
    if (f.scope === 'type' && !f.equipment_type.trim()) return setFormError('Enter the equipment type.');
    setFormError(null);

    const last = form.editingId ? (data.pmPlans.find((p) => p.id === form.editingId)?.last_completed_date ?? null) : null;
    const payload = {
      name: f.name.trim(),
      equipment_id: f.scope === 'equipment' ? f.equipment_id : null,
      site_id: f.scope === 'site' ? f.site_id : null,
      equipment_type: f.scope === 'type' ? f.equipment_type.trim() : null,
      frequency_months: freq,
      estimated_minutes: minutes,
      next_due_date: f.next_due_date || defaultNextDue(freq, last),
      checklist: f.checklist.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 50),
      active: f.active,
    };
    const ok = await run(
      () => (form.editingId ? updateAgreementRow('agreement_pm_plans', form.editingId, payload) : insertAgreementRow('agreement_pm_plans', ownerId, { ...payload, contract_id: data.contract.id })),
      form.editingId ? 'Plan updated.' : 'Maintenance plan added.'
    );
    if (ok) form.close();
  };

  const generate = () =>
    run(
      () =>
        insertAgreementRows(
          'agreement_pm_plans',
          ownerId,
          unplanned.map((eq) => {
            const freq = Math.min(60, Math.max(1, eq.service_interval_months || 12));
            return {
              contract_id: data.contract.id,
              name: `${eq.equipment_type} preventive maintenance`,
              equipment_id: eq.id,
              frequency_months: freq,
              next_due_date: defaultNextDue(freq, eq.last_service_date),
              checklist: [],
              active: true,
            };
          })
        ),
      `${unplanned.length} plan${unplanned.length === 1 ? '' : 's'} created from equipment service intervals.`
    );

  const scheduleVisit = (p: PmPlanRow) =>
    run(
      () => insertAgreementRow('agreement_visits', ownerId, { contract_id: data.contract.id, pm_plan_id: p.id, entitlement_kind: 'pm_visit', visit_date: p.next_due_date ?? toDateKey(now), status: 'scheduled' }),
      'Visit scheduled.'
    );

  const markDone = (p: PmPlanRow) =>
    run(
      () => insertAgreementRow('agreement_visits', ownerId, { contract_id: data.contract.id, pm_plan_id: p.id, entitlement_kind: 'pm_visit', visit_date: toDateKey(now), status: 'completed' }),
      `Recorded. Next visit due ${formatDate(toDateKey(new Date(now.getFullYear(), now.getMonth() + p.frequency_months, now.getDate())))}.`
    );

  const hasScheduled = (p: PmPlanRow) => data.visits.some((v) => v.pm_plan_id === p.id && v.status === 'scheduled');

  return (
    <>
      <div className="mb-5 grid grid-cols-3 gap-3">
        <StatTile label="Active plans" value={counts.active} icon={CalendarClock} />
        <StatTile label="Overdue" value={counts.overdue} icon={CalendarClock} tone={counts.overdue ? 'text-danger' : 'text-success-500'} />
        <StatTile label="Due in 30 days" value={counts.soon} icon={CalendarClock} tone={counts.soon ? 'text-warning-500' : 'text-success-500'} />
      </div>

      <Panel
        title="Preventive-maintenance plans"
        description="Recurring work this agreement promises. Completing a visit moves the plan's next due date forward automatically."
        action={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              {unplanned.length > 0 && (
                <Button size="sm" variant="secondary" onClick={generate} disabled={busy}>
                  <Wand2 size={14} aria-hidden="true" /> Generate {unplanned.length} from equipment
                </Button>
              )}
              <Button size="sm" onClick={() => form.start()} disabled={form.open}>
                <Plus size={14} aria-hidden="true" /> Add plan
              </Button>
            </div>
          ) : undefined
        }
      >
        {form.open && (
          <form onSubmit={submit} className="mb-4 grid gap-3 rounded-lg border border-border bg-bg-primary p-4 sm:grid-cols-2">
            <Input label="Plan name" required maxLength={160} placeholder="e.g. Rooftop unit quarterly service" value={form.form.name} onChange={(e) => form.patch({ name: e.target.value })} />
            <SelectField
              label="Applies to"
              value={form.form.scope}
              onChange={(v) => form.patch({ scope: v })}
              options={[
                { value: 'equipment', label: 'One piece of equipment' },
                { value: 'site', label: 'One property' },
                { value: 'type', label: 'An equipment type' },
              ]}
            />
            {form.form.scope === 'equipment' && (
              <SelectField label="Equipment" value={form.form.equipment_id} onChange={(v) => form.patch({ equipment_id: v })} options={[{ value: '', label: 'Select equipment…' }, ...data.equipment.map((e) => ({ value: e.id, label: equipmentLabel(e) }))]} />
            )}
            {form.form.scope === 'site' && (
              <SelectField label="Property" value={form.form.site_id} onChange={(v) => form.patch({ site_id: v })} options={[{ value: '', label: 'Select a property…' }, ...data.sites.map((s) => ({ value: s.id, label: siteLabel(s) }))]} />
            )}
            {form.form.scope === 'type' && <Input label="Equipment type" maxLength={120} placeholder="e.g. Furnace" value={form.form.equipment_type} onChange={(e) => form.patch({ equipment_type: e.target.value })} />}
            <SelectField
              label="Repeats every"
              value={form.form.frequency_months}
              onChange={(v) => form.patch({ frequency_months: v })}
              options={[...new Set([...FREQUENCIES, Number(form.form.frequency_months) || 12])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: m === 1 ? 'Month' : m === 12 ? 'Year' : `${m} months` }))}
            />
            <Input label="First / next due date" type="date" helperText="Leave blank to start today (or one interval after the last service)." value={form.form.next_due_date} onChange={(e) => form.patch({ next_due_date: e.target.value })} />
            <Input label="Estimated minutes" type="number" inputMode="numeric" min={1} value={form.form.estimated_minutes} onChange={(e) => form.patch({ estimated_minutes: e.target.value })} />
            <div className="sm:col-span-2">
              <Textarea label="Checklist (one task per line)" rows={4} value={form.form.checklist} onChange={(e) => form.patch({ checklist: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <CheckField label="Plan is active" checked={form.form.active} onChange={(v) => form.patch({ active: v })} />
            </div>
            {formError && <p className="text-sm text-danger sm:col-span-2" role="alert">{formError}</p>}
            <div className="sm:col-span-2">
              <FormActions busy={busy} onCancel={() => { setFormError(null); form.close(); }} submitLabel={form.editingId ? 'Save changes' : 'Add plan'} />
            </div>
          </form>
        )}

        {rows.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No maintenance plans" description="Add the recurring maintenance this agreement includes, or generate plans from the service interval of each covered unit." />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ plan: p, status, days }) => (
              <li key={p.id} className="py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary">{p.name}</p>
                    <p className="text-xs text-text-secondary">
                      {scopeLabel(p)} · every {p.frequency_months === 12 ? 'year' : p.frequency_months === 1 ? 'month' : `${p.frequency_months} months`}
                      {p.estimated_minutes ? ` · ~${p.estimated_minutes} min` : ''}
                      {p.checklist.length > 0 ? ` · ${p.checklist.length} task${p.checklist.length === 1 ? '' : 's'}` : ''}
                    </p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      Next due {formatDate(p.next_due_date)}
                      {days !== null && (days < 0 ? ` (${-days} day${days === -1 ? '' : 's'} late)` : days === 0 ? ' (today)' : ` (in ${days} day${days === 1 ? '' : 's'})`)} · last done {formatDate(p.last_completed_date)}
                    </p>
                  </div>
                  <Pill className={PM_STATUS_STYLES[status]}>{PM_STATUS_LABELS[status]}</Pill>
                  {canManage && (
                    <div className="flex flex-wrap items-center gap-1">
                      {p.active && !hasScheduled(p) && (
                        <Button size="sm" variant="ghost" onClick={() => scheduleVisit(p)} disabled={busy} aria-label={`Schedule visit for ${p.name}`}>
                          <CalendarPlus size={14} aria-hidden="true" /> Schedule
                        </Button>
                      )}
                      {p.active && (
                        <Button size="sm" variant="secondary" onClick={() => markDone(p)} disabled={busy} aria-label={`Mark ${p.name} done today`}>
                          <Check size={14} aria-hidden="true" /> Done today
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => run(() => updateAgreementRow('agreement_pm_plans', p.id, { active: !p.active }), p.active ? 'Plan paused.' : 'Plan resumed.')} disabled={busy} aria-label={p.active ? `Pause ${p.name}` : `Resume ${p.name}`}>
                        {p.active ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                      </Button>
                      <RowActions
                        label={p.name}
                        onEdit={() =>
                          form.start(
                            {
                              name: p.name,
                              scope: p.equipment_id ? 'equipment' : p.site_id ? 'site' : 'type',
                              equipment_id: p.equipment_id ?? '',
                              site_id: p.site_id ?? '',
                              equipment_type: p.equipment_type ?? '',
                              frequency_months: String(p.frequency_months),
                              estimated_minutes: p.estimated_minutes ? String(p.estimated_minutes) : '',
                              next_due_date: p.next_due_date ?? '',
                              checklist: p.checklist.join('\n'),
                              active: p.active,
                            },
                            p.id
                          )
                        }
                        onDelete={() => setDeleting({ id: p.id, label: p.name })}
                      />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <DeleteConfirm
        target={deleting}
        noun="maintenance plan"
        onCancel={() => setDeleting(null)}
        onConfirm={async (id) => {
          await run(() => deleteAgreementRow('agreement_pm_plans', id), 'Plan deleted.');
          setDeleting(null);
        }}
      />
    </>
  );
}
