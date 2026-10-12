import { useId, useMemo, useState } from 'react';
import { Building2, ChevronDown, Mail, MapPin, Pencil, Phone, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { SelectField } from '@/components/work-orders/WorkOrderForm';
import { VisitsPanel } from '@/components/work-orders/VisitsPanel';
import {
  APPROVAL_COLORS,
  APPROVAL_LABELS,
  formatMoney,
  formatVisitWindow,
  summarizeWorkOrder,
  WORK_ORDER_STATUS_COLORS,
  WORK_ORDER_STATUS_LABELS,
  WORK_ORDER_STATUS_OPTIONS,
  type ApprovalStatus,
  type VisitFormValues,
  type WorkOrder,
  type WorkOrderStatus,
  type WorkOrderVisit,
} from '@/lib/workOrders';
import type { TechnicianOption, VisitPatch } from '@/lib/workOrdersApi';

export interface ApprovalDecision {
  approval_status: ApprovalStatus;
  approver_name: string | null;
  approval_notes: string | null;
}

// ============================================================
// Approval panel
// ============================================================

function ApprovalPanel({
  workOrder,
  busy,
  onDecide,
}: {
  workOrder: WorkOrder;
  busy: boolean;
  onDecide: (decision: ApprovalDecision) => Promise<boolean>;
}) {
  const [deciding, setDeciding] = useState<'approved' | 'rejected' | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');

  const reset = () => {
    setDeciding(null);
    setName('');
    setNotes('');
  };

  const submit = async () => {
    if (!deciding) return;
    const ok = await onDecide({
      approval_status: deciding,
      approver_name: name.trim() || null,
      approval_notes: notes.trim() || null,
    });
    if (ok) reset();
  };

  const status = workOrder.approval_status;

  return (
    <section aria-label="Approval" className="space-y-3 rounded-xl border border-border bg-bg-primary p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ShieldCheck size={16} className="text-accent" aria-hidden="true" /> Approval
        </h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${APPROVAL_COLORS[status]}`}>
          {APPROVAL_LABELS[status]}
        </span>
      </div>

      {(status === 'approved' || status === 'rejected') && (
        <p className="text-xs text-text-secondary">
          {status === 'approved' ? 'Approved' : 'Rejected'}
          {workOrder.approver_name ? ` by ${workOrder.approver_name}` : ''}
          {workOrder.approved_at ? ` on ${new Date(workOrder.approved_at).toLocaleDateString()}` : ''}
          {workOrder.approval_notes ? ` — ${workOrder.approval_notes}` : ''}
        </p>
      )}

      {deciding ? (
        <div className="space-y-3">
          <Input
            label={deciding === 'approved' ? 'Approved by (customer contact)' : 'Rejected by (customer contact)'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
          <Textarea label="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" size="sm" variant="secondary" onClick={reset} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" size="sm" variant="primary" onClick={() => void submit()} disabled={busy}>
              {busy ? 'Saving…' : deciding === 'approved' ? 'Confirm approval' : 'Confirm rejection'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {status === 'pending' && (
            <>
              <Button type="button" size="sm" variant="primary" disabled={busy} onClick={() => setDeciding('approved')}>
                Approve
              </Button>
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setDeciding('rejected')}>
                Reject
              </Button>
            </>
          )}
          {(status === 'approved' || status === 'rejected') && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void onDecide({ approval_status: 'pending', approver_name: null, approval_notes: null })}
            >
              Reopen approval
            </Button>
          )}
          {status === 'not_required' && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void onDecide({ approval_status: 'pending', approver_name: null, approval_notes: null })}
            >
              Require approval
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

// ============================================================
// Card
// ============================================================

interface WorkOrderCardProps {
  workOrder: WorkOrder;
  visits: WorkOrderVisit[];
  customerName: string | null;
  technicians: TechnicianOption[];
  expanded: boolean;
  /** True while this work order's own row is being written. */
  busy: boolean;
  visitBusyId: string | null;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onApproval: (decision: ApprovalDecision) => Promise<boolean>;
  onStatusChange: (status: WorkOrderStatus) => Promise<boolean>;
  onCreateVisit: (workOrderId: string, values: VisitFormValues) => Promise<boolean>;
  onUpdateVisit: (visit: WorkOrderVisit, patch: VisitPatch) => Promise<boolean>;
  onDeleteVisit: (visit: WorkOrderVisit) => void;
}

export function WorkOrderCard({
  workOrder,
  visits,
  customerName,
  technicians,
  expanded,
  busy,
  visitBusyId,
  onToggle,
  onEdit,
  onDelete,
  onApproval,
  onStatusChange,
  onCreateVisit,
  onUpdateVisit,
  onDeleteVisit,
}: WorkOrderCardProps) {
  const panelId = useId();
  const summary = useMemo(() => summarizeWorkOrder(workOrder, visits), [workOrder, visits]);
  const nte = workOrder.not_to_exceed_cents;
  const pct = nte && nte > 0 ? Math.min(100, Math.round((summary.committedCents / nte) * 100)) : 0;
  const phoneHref = workOrder.site_contact_phone ? `tel:${workOrder.site_contact_phone.replace(/[^\d+]/g, '')}` : null;

  return (
    <article className="rounded-2xl border border-border bg-bg-secondary">
      <div className="flex items-start gap-2 p-4 sm:p-5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="focus-ring flex min-w-0 flex-1 items-start gap-3 rounded-xl text-left"
        >
          <ChevronDown
            size={18}
            aria-hidden="true"
            className={`mt-0.5 shrink-0 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-text-secondary">{workOrder.work_order_number ?? 'Unnumbered'}</span>
              {workOrder.po_number && (
                <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-primary">
                  PO {workOrder.po_number}
                </span>
              )}
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${WORK_ORDER_STATUS_COLORS[workOrder.status]}`}>
                {WORK_ORDER_STATUS_LABELS[workOrder.status]}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${APPROVAL_COLORS[workOrder.approval_status]}`}>
                {APPROVAL_LABELS[workOrder.approval_status]}
              </span>
            </div>
            <p className="mt-1.5 break-words text-base font-semibold text-text-primary">{workOrder.title}</p>
            <p className="mt-1 text-xs text-text-secondary">
              {[customerName, workOrder.site_name].filter(Boolean).join(' · ') || 'No customer or site yet'}
            </p>
            <p className="mt-2 text-xs text-text-secondary">
              {summary.completedCount} of {summary.liveVisitCount} visit{summary.liveVisitCount === 1 ? '' : 's'} done
              {summary.nextVisitAt ? ` · Next ${formatVisitWindow(summary.nextVisitAt, null)}` : ''}
              {' · '}Billed {formatMoney(summary.invoicedCents + summary.paidCents)}
              {nte !== null ? ` of ${formatMoney(nte)} cap` : ''}
            </p>
            {nte !== null && nte > 0 && (
              <div
                role="progressbar"
                aria-label="Billing committed against not-to-exceed cap"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                className="mt-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-bg-tertiary"
              >
                <div
                  className={`h-full rounded-full ${summary.overNte ? 'bg-danger' : pct >= 90 ? 'bg-warning-500' : 'bg-accent'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40"
            aria-label={`Edit ${workOrder.title}`}
          >
            <Pencil size={15} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
            aria-label={`Delete ${workOrder.title}`}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {expanded && (
        <div id={panelId} className="space-y-5 border-t border-border/70 p-4 sm:p-5">
          {workOrder.description && (
            <p className="whitespace-pre-line text-sm leading-relaxed text-text-secondary">{workOrder.description}</p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <section aria-label="Site and contact" className="space-y-2 rounded-xl border border-border bg-bg-primary p-4 text-sm">
              <h3 className="text-sm font-semibold text-text-primary">Site contact</h3>
              {workOrder.site_name && (
                <p className="flex items-start gap-2 text-text-secondary">
                  <Building2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> {workOrder.site_name}
                </p>
              )}
              {workOrder.site_address && (
                <p className="flex items-start gap-2 text-text-secondary">
                  <MapPin size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(workOrder.site_address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-accent hover:underline"
                  >
                    {workOrder.site_address}
                  </a>
                </p>
              )}
              {workOrder.site_contact_name && (
                <p className="flex items-start gap-2 text-text-primary">
                  <UserRound size={14} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
                  {workOrder.site_contact_name}
                </p>
              )}
              {phoneHref && (
                <p className="flex items-start gap-2">
                  <Phone size={14} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
                  <a href={phoneHref} className="text-accent hover:underline">
                    {workOrder.site_contact_phone}
                  </a>
                </p>
              )}
              {workOrder.site_contact_email && (
                <p className="flex items-start gap-2 break-all">
                  <Mail size={14} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
                  <a href={`mailto:${workOrder.site_contact_email}`} className="text-accent hover:underline">
                    {workOrder.site_contact_email}
                  </a>
                </p>
              )}
              {!workOrder.site_name &&
                !workOrder.site_address &&
                !workOrder.site_contact_name &&
                !phoneHref &&
                !workOrder.site_contact_email && (
                  <p className="text-text-secondary">No site details yet. Use Edit to add them.</p>
                )}
            </section>

            <div className="space-y-4">
              <ApprovalPanel workOrder={workOrder} busy={busy} onDecide={onApproval} />
              <SelectField
                label="Work order status"
                value={workOrder.status}
                disabled={busy}
                onChange={(v) => void onStatusChange(v as WorkOrderStatus)}
                options={WORK_ORDER_STATUS_OPTIONS}
              />
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            {[
              { label: 'Committed', value: formatMoney(summary.committedCents) },
              { label: 'Ready to bill', value: formatMoney(summary.readyCents) },
              { label: 'Invoiced', value: formatMoney(summary.invoicedCents) },
              {
                label: summary.remainingCents === null ? 'Cap' : summary.overNte ? 'Over cap by' : 'Cap remaining',
                value:
                  summary.remainingCents === null
                    ? 'No cap'
                    : formatMoney(Math.abs(summary.remainingCents)),
                danger: summary.overNte,
              },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-border bg-bg-primary p-3">
                <dd className={`text-base font-bold ${s.danger ? 'text-danger' : 'text-text-primary'}`}>{s.value}</dd>
                <dt className="mt-0.5 text-xs text-text-secondary">{s.label}</dt>
              </div>
            ))}
          </dl>

          <VisitsPanel
            workOrder={workOrder}
            visits={visits}
            technicians={technicians}
            busyId={visitBusyId}
            onCreate={onCreateVisit}
            onUpdate={onUpdateVisit}
            onDelete={onDeleteVisit}
          />
        </div>
      )}
    </article>
  );
}
