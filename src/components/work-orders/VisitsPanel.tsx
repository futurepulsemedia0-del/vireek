import { useState, type FormEvent } from 'react';
import { CalendarClock, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { SelectField } from '@/components/work-orders/WorkOrderForm';
import {
  allowedBillingMoves,
  allowedVisitMoves,
  BILLING_COLORS,
  BILLING_LABELS,
  canStartWork,
  EMPTY_VISIT_FORM,
  formatMoney,
  formatVisitWindow,
  toVisitPayload,
  validateVisitForm,
  VISIT_STATUS_COLORS,
  VISIT_STATUS_LABELS,
  visitToForm,
  type FormErrors,
  type VisitFormValues,
  type WorkOrder,
  type WorkOrderVisit,
} from '@/lib/workOrders';
import type { TechnicianOption, VisitPatch } from '@/lib/workOrdersApi';

// ============================================================
// Visit form (add + edit)
// ============================================================

interface VisitFormProps {
  initial: VisitFormValues;
  technicians: TechnicianOption[];
  isEdit: boolean;
  saving: boolean;
  onSubmit: (values: VisitFormValues) => void;
  onCancel: () => void;
}

function VisitForm({ initial, technicians, isEdit, saving, onSubmit, onCancel }: VisitFormProps) {
  const [values, setValues] = useState<VisitFormValues>(initial);
  const [errors, setErrors] = useState<FormErrors<VisitFormValues>>({});

  const set = <K extends keyof VisitFormValues>(key: K, value: VisitFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const found = validateVisitForm(values);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(values);
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={isEdit ? 'Edit visit' : 'Add visit'}
      className="space-y-4 rounded-xl border border-accent/30 bg-bg-primary p-4"
    >
      <fieldset className="space-y-4" disabled={saving}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Starts"
            type="datetime-local"
            required
            value={values.scheduled_start}
            error={errors.scheduled_start}
            onChange={(e) => set('scheduled_start', e.target.value)}
          />
          <Input
            label="Ends"
            type="datetime-local"
            value={values.scheduled_end}
            error={errors.scheduled_end}
            onChange={(e) => set('scheduled_end', e.target.value)}
          />
          <SelectField
            label="Technician"
            value={values.assigned_technician_id}
            onChange={(v) => set('assigned_technician_id', v)}
            placeholder="Unassigned"
            options={technicians.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Input
            label="Billable for this visit"
            inputMode="decimal"
            value={values.billable_amount}
            error={errors.billable_amount}
            placeholder="450"
            onChange={(e) => set('billable_amount', e.target.value)}
          />
          {isEdit && (
            <Input
              label="Invoice reference"
              value={values.invoice_reference}
              placeholder="INV-1042"
              onChange={(e) => set('invoice_reference', e.target.value)}
            />
          )}
        </div>
        <Textarea
          label="Visit notes"
          rows={2}
          value={values.notes}
          error={errors.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
      </fieldset>
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={saving} className="w-full sm:w-auto">
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={saving} className="w-full sm:w-auto">
          {saving ? 'Saving…' : isEdit ? 'Save visit' : 'Add visit'}
        </Button>
      </div>
    </form>
  );
}

// ============================================================
// Visits panel
// ============================================================

interface VisitsPanelProps {
  workOrder: WorkOrder;
  visits: WorkOrderVisit[];
  technicians: TechnicianOption[];
  /** Visit id (or 'new') currently being written; disables its controls. */
  busyId: string | null;
  onCreate: (workOrderId: string, values: VisitFormValues) => Promise<boolean>;
  onUpdate: (visit: WorkOrderVisit, patch: VisitPatch) => Promise<boolean>;
  onDelete: (visit: WorkOrderVisit) => void;
}

export function VisitsPanel({ workOrder, visits, technicians, busyId, onCreate, onUpdate, onDelete }: VisitsPanelProps) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const techName = (id: string | null) => technicians.find((t) => t.id === id)?.name ?? null;
  const startable = canStartWork(workOrder.approval_status);
  const cancelled = workOrder.status === 'cancelled';

  return (
    <section aria-label="Visits" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <CalendarClock size={16} className="text-accent" aria-hidden="true" />
          Visits ({visits.length})
        </h3>
        {!adding && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={cancelled}
            onClick={() => {
              setEditingId(null);
              setAdding(true);
            }}
          >
            <Plus size={14} aria-hidden="true" /> Add visit
          </Button>
        )}
      </div>

      {!startable && (
        <p className="rounded-xl bg-warning-500/10 px-3 py-2 text-xs text-warning-500">
          You can schedule visits now, but they can&apos;t start until this work order is approved.
        </p>
      )}

      {adding && (
        <VisitForm
          initial={EMPTY_VISIT_FORM}
          technicians={technicians}
          isEdit={false}
          saving={busyId === 'new'}
          onCancel={() => setAdding(false)}
          onSubmit={async (values) => {
            if (await onCreate(workOrder.id, values)) setAdding(false);
          }}
        />
      )}

      {visits.length === 0 && !adding && (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-text-secondary">
          No visits scheduled yet. Add the first one to start tracking work and billing per visit.
        </p>
      )}

      <ul className="space-y-3">
        {visits.map((visit) => {
          const busy = busyId === visit.id;
          const billed = visit.billing_status === 'invoiced' || visit.billing_status === 'paid';
          const tech = techName(visit.assigned_technician_id);
          const statusMoves = allowedVisitMoves(visit, workOrder.approval_status);
          const billingMoves = allowedBillingMoves(visit);

          if (editingId === visit.id) {
            return (
              <li key={visit.id}>
                <VisitForm
                  initial={visitToForm(visit)}
                  technicians={technicians}
                  isEdit
                  saving={busy}
                  onCancel={() => setEditingId(null)}
                  onSubmit={async (values) => {
                    const p = toVisitPayload(values);
                    if (await onUpdate(visit, p)) setEditingId(null);
                  }}
                />
              </li>
            );
          }

          return (
            <li key={visit.id} className="rounded-xl border border-border bg-bg-primary p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-text-primary">Visit {visit.visit_number}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${VISIT_STATUS_COLORS[visit.status]}`}>
                      {VISIT_STATUS_LABELS[visit.status]}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BILLING_COLORS[visit.billing_status]}`}>
                      {BILLING_LABELS[visit.billing_status]}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-text-secondary">
                    {formatVisitWindow(visit.scheduled_start, visit.scheduled_end)}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                    <span className="inline-flex items-center gap-1">
                      <UserRound size={12} aria-hidden="true" />
                      {tech ?? 'Unassigned'}
                    </span>
                    <span>
                      Billable: <span className="font-medium text-text-primary">{formatMoney(visit.billable_amount_cents)}</span>
                    </span>
                    {visit.invoice_reference && <span>Invoice {visit.invoice_reference}</span>}
                  </p>
                  {visit.notes && <p className="mt-2 whitespace-pre-line text-xs text-text-secondary">{visit.notes}</p>}
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busy || billed}
                    onClick={() => {
                      setAdding(false);
                      setEditingId(visit.id);
                    }}
                    className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40"
                    aria-label={`Edit visit ${visit.visit_number}`}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    disabled={busy || billed}
                    onClick={() => onDelete(visit)}
                    className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    aria-label={`Delete visit ${visit.visit_number}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              {(statusMoves.length > 0 || billingMoves.length > 0) && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-border/70 pt-3">
                  {statusMoves.map((m) => (
                    <Button
                      key={`s-${m.to}`}
                      type="button"
                      size="sm"
                      variant={m.tone === 'primary' ? 'primary' : 'secondary'}
                      className={m.tone === 'danger' ? 'text-danger' : ''}
                      disabled={busy}
                      onClick={() => void onUpdate(visit, { status: m.to })}
                    >
                      {m.label}
                    </Button>
                  ))}
                  {billingMoves.map((m) => (
                    <Button
                      key={`b-${m.to}`}
                      type="button"
                      size="sm"
                      variant={m.tone === 'primary' ? 'primary' : 'ghost'}
                      className={m.tone === 'danger' ? 'text-danger' : ''}
                      disabled={busy}
                      onClick={() => void onUpdate(visit, { billing_status: m.to })}
                    >
                      {m.label}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
