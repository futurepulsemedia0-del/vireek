import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, FilePlus2, FileSignature, FileText, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { RequestSignatureModal } from '@/components/signatures/RequestSignatureModal';
import { useToast } from '@/contexts/ToastContext';
import {
  CHANGE_ORDER_BILLING_LABEL,
  CHANGE_ORDER_REASON_LABEL,
  CHANGE_ORDER_STATUS_LABEL,
  approvalImpact,
  approvedChangeTotals,
  availableActions,
  buildSignatureSummary,
  changeOrderBillingState,
  daysWaiting,
  formFromChangeOrder,
  pendingChangeCents,
  signedDays,
  signedMoney,
  type ChangeOrder,
  type ChangeOrderStatus,
} from '@/lib/changeOrders';
import {
  createChangeOrder,
  deleteChangeOrder,
  fetchCustomerContact,
  invoiceChangeOrder,
  markChangeOrderSent,
  reopenChangeOrder,
  syncChangeOrders,
  updateChangeOrder,
  voidChangeOrder,
  type CustomerContact,
} from '@/lib/changeOrdersApi';
import { addDaysIso, formatDate, formatMoney, friendlyError, liveInvoice } from '@/lib/installProjects';
import { ChangeOrderForm } from './ChangeOrderForm';
import { Pill, SectionHeader, Stat, panelClass, useAction, useConfirm, type TabProps } from './projectUi';

const DEFAULT_TERMS_DAYS = 14;

const STATUS_TONE: Record<ChangeOrderStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  sent: 'info',
  approved: 'success',
  rejected: 'danger',
  voided: 'neutral',
};

export function ChangeOrdersTab({ ownerId, bundle, today, onChanged }: TabProps) {
  const { project, invoices } = bundle;
  const changeOrders = bundle.changeOrders;
  const { toast } = useToast();
  const { busyKey, run } = useAction(onChanged);
  const { ask, dialog } = useConfirm();
  const [form, setForm] = useState<'new' | ChangeOrder | null>(null);
  const [signing, setSigning] = useState<{ co: ChangeOrder; contact: CustomerContact } | null>(null);

  const approved = useMemo(() => approvedChangeTotals(changeOrders), [changeOrders]);
  const pendingCents = useMemo(() => pendingChangeCents(changeOrders), [changeOrders]);
  const hasSent = changeOrders.some((c) => c.status === 'sent' && c.signature_request_id !== null);
  const cancelled = project.status === 'cancelled';

  // Pick up customer signatures that arrived while this page was closed.
  useEffect(() => {
    if (!hasSent) return;
    let cancelledRun = false;
    void (async () => {
      try {
        const r = await syncChangeOrders(project.id);
        if (cancelledRun) return;
        if (r.error) toast(friendlyError(new Error(r.error), 'A signed change order could not be applied.'), 'error');
        if (r.changed > 0) await onChanged();
      } catch {
        /* the manual refresh button reports errors */
      }
    })();
    return () => {
      cancelledRun = true;
    };
  }, [project.id, hasSent, onChanged, toast]);

  const refreshSignatures = () =>
    run('sync', async () => {
      const r = await syncChangeOrders(project.id);
      if (r.error) throw new Error(friendlyError(new Error(r.error), 'A signed change order could not be applied.'));
    }, 'Signature status is up to date.');

  const save = async (payload: Parameters<typeof createChangeOrder>[2]) => {
    const editing = form !== null && form !== 'new' ? form : null;
    const ok = await run(
      'save',
      () => (editing ? updateChangeOrder(ownerId, editing.id, payload) : createChangeOrder(ownerId, project.id, payload)),
      editing ? 'Change order updated.' : 'Draft change order created.',
    );
    if (ok) setForm(null);
  };

  const startSigning = async (co: ChangeOrder) => {
    const contact = await fetchCustomerContact(ownerId, project.customer_id);
    setSigning({ co, contact });
  };

  const onSent = (coId: string, signatureRequestId: string) =>
    void run('link', () => markChangeOrderSent(coId, signatureRequestId), 'Sent to the customer for signature.');

  const confirmInvoice = (co: ChangeOrder) =>
    ask({
      title: co.cost_delta_cents < 0 ? 'Create a credit invoice?' : 'Invoice this change order?',
      description:
        co.cost_delta_cents < 0
          ? `A draft invoice with a negative total of ${formatMoney(co.cost_delta_cents)} will be created in Invoicing. Review it before sending.`
          : `A draft invoice for ${formatMoney(co.cost_delta_cents)} will be created in Invoicing. Progress billing is not affected.`,
      label: 'Create invoice',
      onConfirm: () => run(`inv-${co.id}`, () => invoiceChangeOrder(co.id, addDaysIso(today, DEFAULT_TERMS_DAYS)), 'Invoice created as a draft in Invoicing.'),
    });

  if (form !== null) {
    const editing = form === 'new' ? null : form;
    return (
      <div className="space-y-4">
        <SectionHeader title={editing ? `Edit ${editing.co_number ?? 'change order'}` : 'New change order'} description="Drafts can be edited freely. Once sent, the customer signs the exact scope and totals below." />
        <ChangeOrderForm mode={editing ? 'edit' : 'create'} project={project} initial={editing ? formFromChangeOrder(editing) : undefined} submitting={busyKey === 'save'} onSubmit={(p) => void save(p)} onCancel={() => setForm(null)} />
        {dialog}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Original contract" value={formatMoney(project.contract_value_cents, true)} hint="Progress draws bill against this" />
        <Stat label="Approved changes" value={signedMoney(approved.priceCents)} hint={`${approved.count} approved · ${signedDays(approved.scheduleDays)}`} tone={approved.priceCents > 0 ? 'success' : approved.priceCents < 0 ? 'warning' : undefined} />
        <Stat label="Revised contract" value={formatMoney(project.contract_value_cents + (project.approved_change_cents ?? 0), true)} hint="Original + approved changes" />
        <Stat label="Awaiting signature" value={signedMoney(pendingCents)} hint={`${changeOrders.filter((c) => c.status === 'sent').length} sent`} tone={pendingCents !== 0 ? 'warning' : undefined} />
      </div>

      <section>
        <SectionHeader
          title="Change orders"
          description="Scope, price and schedule changes the customer signs before they affect the contract."
          action={
            <div className="flex flex-wrap items-center gap-2">
              {hasSent && <Button size="sm" variant="secondary" disabled={busyKey === 'sync'} onClick={() => void refreshSignatures()}><RotateCcw size={14} aria-hidden="true" /> Check signatures</Button>}
              <Button size="sm" disabled={cancelled} onClick={() => setForm('new')} title={cancelled ? 'This project is cancelled' : undefined}><FilePlus2 size={14} aria-hidden="true" /> New change order</Button>
            </div>
          }
        />
        {changeOrders.length === 0 ? (
          <EmptyState icon={FileSignature} title="No change orders yet" description="When the customer asks for extra work or conditions change on site, record it here and send it for e-signature." />
        ) : (
          <ul className="space-y-3">
            {changeOrders.map((co) => {
              const inv = liveInvoice({ invoice_id: co.invoice_id }, invoices);
              const actions = availableActions(co, project.status, inv !== null);
              const billing = changeOrderBillingState(co, invoices, today);
              const waiting = co.status === 'sent' ? daysWaiting(co.sent_at, today) : null;
              const impact = approvalImpact(project, co);
              const busy = (k: string) => busyKey === `${k}-${co.id}`;
              return (
                <li key={co.id} className={`${panelClass} space-y-3`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{co.co_number} · {co.title}</p>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {CHANGE_ORDER_REASON_LABEL[co.reason]} · {co.line_items.length} line{co.line_items.length === 1 ? '' : 's'} · created {formatDate(co.created_at)}
                        {waiting !== null && ` · waiting ${waiting} day${waiting === 1 ? '' : 's'}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {billing !== 'not_applicable' && <Pill tone={billing === 'paid' ? 'success' : billing === 'overdue' ? 'danger' : billing === 'invoiced' ? 'info' : 'warning'}>{CHANGE_ORDER_BILLING_LABEL[billing]}</Pill>}
                      <Pill tone={STATUS_TONE[co.status]}>{CHANGE_ORDER_STATUS_LABEL[co.status]}</Pill>
                    </div>
                  </div>

                  {co.description && <p className="whitespace-pre-line text-sm text-text-secondary">{co.description}</p>}

                  <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <div><dt className="text-xs text-text-secondary">Price change</dt><dd className="font-semibold tabular-nums text-text-primary">{signedMoney(co.cost_delta_cents)}</dd></div>
                    <div><dt className="text-xs text-text-secondary">Schedule</dt><dd className="text-text-primary">{signedDays(co.schedule_delta_days)}</dd></div>
                    <div><dt className="text-xs text-text-secondary">{co.status === 'approved' ? 'Contract now' : 'Contract if approved'}</dt><dd className="tabular-nums text-text-primary">{formatMoney(co.status === 'approved' ? project.contract_value_cents + (project.approved_change_cents ?? 0) : impact.contractAfterCents, true)}</dd></div>
                    <div>
                      <dt className="text-xs text-text-secondary">{co.status === 'approved' ? 'Approved' : co.status === 'rejected' ? 'Declined' : co.status === 'voided' ? 'Withdrawn' : 'Sent'}</dt>
                      <dd className="text-text-primary">{formatDate(co.decided_at ?? co.sent_at)}{co.decided_by_name ? ` · ${co.decided_by_name}` : ''}</dd>
                    </div>
                  </dl>

                  {co.status === 'rejected' && co.decision_note && <p className="text-sm text-text-secondary">Customer note: {co.decision_note}</p>}
                  {inv && <p className="text-xs text-text-secondary">Invoice <Link to="/dashboard/invoices" className="text-accent underline-offset-2 hover:underline">{inv.invoice_number}</Link></p>}

                  {actions.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                      {actions.includes('send') && <Button size="sm" disabled={busyKey !== null} onClick={() => void startSigning(co)}><FileSignature size={14} aria-hidden="true" /> Send for signature</Button>}
                      {actions.includes('invoice') && <Button size="sm" disabled={busy('inv')} onClick={() => confirmInvoice(co)}><FileText size={14} aria-hidden="true" /> {busy('inv') ? 'Creating…' : 'Create invoice'}</Button>}
                      {actions.includes('edit') && <Button size="sm" variant="secondary" onClick={() => setForm(co)}><Pencil size={14} aria-hidden="true" /> Edit</Button>}
                      {actions.includes('reopen') && (
                        <Button size="sm" variant="secondary" disabled={busy('reopen')} onClick={() =>
                          co.status === 'sent'
                            ? ask({ title: 'Recall this change order?', description: 'The signature request is cancelled and the change order returns to draft so you can edit it.', label: 'Recall', onConfirm: () => run(`reopen-${co.id}`, () => reopenChangeOrder(co.id), 'Returned to draft.') })
                            : void run(`reopen-${co.id}`, () => reopenChangeOrder(co.id), 'Returned to draft.')}>
                          <RotateCcw size={14} aria-hidden="true" /> {co.status === 'sent' ? 'Recall' : 'Revise'}
                        </Button>
                      )}
                      {actions.includes('void') && (
                        <Button size="sm" variant="ghost" disabled={busy('void')} onClick={() => ask({ title: 'Withdraw this change order?', description: `${co.co_number} is withdrawn and any open signature request is cancelled. It stays on record and the contract is not changed.`, label: 'Withdraw', onConfirm: () => run(`void-${co.id}`, () => voidChangeOrder(co.id), 'Change order withdrawn.') })}>
                          <Ban size={14} aria-hidden="true" /> Withdraw
                        </Button>
                      )}
                      {actions.includes('delete') && (
                        <button type="button" aria-label={`Delete ${co.co_number}`} onClick={() => ask({ title: 'Delete this draft?', description: `${co.co_number} “${co.title}” will be deleted permanently.`, label: 'Delete draft', onConfirm: () => run(`del-${co.id}`, () => deleteChangeOrder(ownerId, co.id), 'Draft deleted.') })} className="focus-ring ml-auto rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500">
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {signing && (
        <RequestSignatureModal
          key={signing.co.id}
          open
          onClose={() => setSigning(null)}
          documentType="custom"
          documentId={signing.co.id}
          title={`${signing.co.co_number} — ${signing.co.title}`}
          documentSummary={buildSignatureSummary(project, signing.co)}
          customerId={project.customer_id}
          defaultSigner={{ name: project.customer_name, email: signing.contact.email ?? undefined, phone: signing.contact.phone ?? undefined }}
          onSent={(result) => onSent(signing.co.id, result.request.id)}
        />
      )}
      {dialog}
    </div>
  );
}
