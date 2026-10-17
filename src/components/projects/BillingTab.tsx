import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Landmark, Plus, Receipt, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { addBillingStep, createProgressInvoice, deleteBillingStep, releaseRetainage, updateBillingStep } from '@/lib/installProjectsApi';
import {
  BILLING_STATUS_LABEL,
  addDaysIso,
  billingRowStatus,
  billingSummary,
  drawAmounts,
  formatDate,
  formatMoney,
  formatPercent,
  liveInvoice,
  remainingBillablePercent,
} from '@/lib/installProjects';
import { Pill, SectionHeader, Stat, billingTone, panelClass, selectClass, useAction, useConfirm, type TabProps } from './projectUi';

const DEFAULT_TERMS_DAYS = 14;

export function BillingTab({ ownerId, bundle, today, onChanged }: TabProps) {
  const { project, phases, billing, invoices } = bundle;
  const { busyKey, run } = useAction(onChanged);
  const { ask, dialog } = useConfirm();
  const summary = useMemo(() => billingSummary(project, billing, invoices, today), [project, billing, invoices, today]);
  const remaining = remainingBillablePercent(billing);
  const [label, setLabel] = useState('');
  const [percent, setPercent] = useState('');
  const [due, setDue] = useState('');
  const [phaseId, setPhaseId] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editPercent, setEditPercent] = useState('');
  const canInvoice = project.contract_value_cents > 0 && project.status !== 'cancelled';
  const releasable = project.status === 'completed' && summary.retainageHeldCents > 0 && !summary.retainageReleased;
  const retainageInvoice = project.retainage_invoice_id ? liveInvoice({ invoice_id: project.retainage_invoice_id }, invoices) : null;

  const pct = Number(percent);
  const percentValid = Number.isFinite(pct) && pct > 0 && pct <= remaining;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !percentValid) return;
    const ok = await run('add', () => addBillingStep(ownerId, { projectId: project.id, label, percent: pct, dueDate: due, phaseId, sortOrder: billing.length ? Math.max(...billing.map((b) => b.sort_order)) + 1 : 0 }), 'Billing step added.');
    if (ok) { setLabel(''); setPercent(''); setDue(''); setPhaseId(''); }
  };

  const invoiceNow = (id: string, stepDue: string | null) =>
    run(`inv-${id}`, () => createProgressInvoice(id, stepDue || addDaysIso(today, DEFAULT_TERMS_DAYS)), 'Invoice created as a draft in Invoicing.');

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Contract" value={formatMoney(project.contract_value_cents, true)} hint={`${formatPercent(summary.scheduledPercent, 1)} scheduled`} />
        <Stat label="Invoiced" value={formatMoney(summary.invoicedGrossCents, true)} hint={`${formatPercent(summary.billedPercent, 0)} of contract`} />
        <Stat label="Outstanding" value={formatMoney(summary.outstandingCents, true)} hint={summary.overdueCents > 0 ? `${formatMoney(summary.overdueCents)} overdue` : 'Nothing overdue'} tone={summary.overdueCents > 0 ? 'danger' : undefined} />
        <Stat label="Retainage held" value={formatMoney(summary.retainageHeldCents, true)} hint={summary.retainageReleased ? 'Released' : `${formatPercent(project.retainage_percent, 1)} of each draw`} />
      </div>

      <section>
        <SectionHeader title="Progress billing schedule" description="Each step invoices a share of the contract, less retainage. Invoices are created as drafts in Invoicing." />
        {billing.length === 0 ? (
          <EmptyState icon={Receipt} title="No billing steps yet" description="Split the contract into deposit, progress and final draws. They must add up to at most 100%." />
        ) : (
          <ul className="space-y-2">
            {billing.map((b) => {
              const status = billingRowStatus(b, invoices, today);
              const inv = liveInvoice(b, invoices);
              const amounts = b.invoice_id && inv && b.invoiced_gross_cents !== null
                ? { grossCents: b.invoiced_gross_cents, retainageCents: b.retainage_withheld_cents, netCents: b.invoiced_gross_cents - b.retainage_withheld_cents }
                : drawAmounts(project.contract_value_cents, project.retainage_percent, b.percent_of_contract);
              const locked = inv !== null;
              const phaseName = phases.find((p) => p.id === b.phase_id)?.name;
              const editing = editId === b.id;
              return (
                <li key={b.id} className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text-primary">{b.label}</p>
                    <p className="text-xs text-text-secondary">
                      {phaseName ? `${phaseName} · ` : ''}Due {formatDate(b.due_date)}
                      {inv && <> · <Link to="/dashboard/invoices" className="text-accent underline-offset-2 hover:underline">{inv.invoice_number}</Link></>}
                    </p>
                  </div>
                  {editing ? (
                    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); const v = Number(editPercent); if (v > 0 && v <= remaining + b.percent_of_contract) void run(`edit-${b.id}`, () => updateBillingStep(ownerId, b.id, { percent_of_contract: v }), 'Billing step updated.').then((ok) => ok && setEditId(null)); }}>
                      <Input aria-label="Percent of contract" type="number" step="0.001" value={editPercent} onChange={(e) => setEditPercent(e.target.value)} className="w-24 py-1.5 text-sm" />
                      <Button type="submit" size="sm" variant="secondary" disabled={busyKey === `edit-${b.id}`}>Save</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditId(null)}>Cancel</Button>
                    </form>
                  ) : (
                    <button type="button" disabled={locked} onClick={() => { setEditId(b.id); setEditPercent(String(b.percent_of_contract)); }} className="focus-ring rounded-lg px-2 py-1 text-sm font-semibold tabular-nums text-text-primary hover:bg-bg-tertiary disabled:cursor-default disabled:hover:bg-transparent" aria-label={`${formatPercent(b.percent_of_contract, 1)} of contract${locked ? '' : ', edit'}`}>
                      {formatPercent(b.percent_of_contract, 1)}
                    </button>
                  )}
                  <div className="text-right text-sm tabular-nums">
                    <p className="font-semibold text-text-primary">{formatMoney(amounts.netCents)}</p>
                    {amounts.retainageCents > 0 && <p className="text-xs text-text-secondary">{formatMoney(amounts.grossCents)} − {formatMoney(amounts.retainageCents)} ret.</p>}
                  </div>
                  <Pill tone={billingTone[status]}>{BILLING_STATUS_LABEL[status]}</Pill>
                  <div className="flex items-center gap-1">
                    {!inv && (
                      <Button size="sm" variant="secondary" disabled={!canInvoice || busyKey === `inv-${b.id}`} onClick={() => invoiceNow(b.id, b.due_date)} title={canInvoice ? undefined : 'Set a contract value first'}>
                        <FileText size={14} aria-hidden="true" /> {busyKey === `inv-${b.id}` ? 'Creating…' : 'Create invoice'}
                      </Button>
                    )}
                    {(!b.invoice_id || !inv) && (
                      <button type="button" aria-label={`Delete ${b.label}`} onClick={() => ask({ title: 'Delete billing step?', description: `“${b.label}” (${formatPercent(b.percent_of_contract, 1)}) will be removed from the schedule.`, label: 'Delete step', onConfirm: () => run(`del-${b.id}`, () => deleteBillingStep(ownerId, b.id), 'Billing step deleted.') })} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500">
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <form onSubmit={add} className={`${panelClass} space-y-3`}>
        <h3 className="text-sm font-semibold text-text-primary">Add billing step <span className="font-normal text-text-secondary">· {formatPercent(remaining, 1)} of the contract is unscheduled</span></h3>
        <div className="grid gap-2 sm:grid-cols-[1fr_120px_150px_1fr_auto]">
          <Input aria-label="Step label" placeholder="e.g. Equipment delivered" value={label} onChange={(e) => setLabel(e.target.value)} className="py-2 text-sm" maxLength={120} />
          <Input aria-label="Percent of contract" type="number" step="0.001" min={0} max={remaining} placeholder="%" value={percent} onChange={(e) => setPercent(e.target.value)} className="py-2 text-sm" disabled={remaining <= 0} />
          <Input aria-label="Due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="py-2 text-sm" />
          <select aria-label="Linked phase" className={selectClass} value={phaseId} onChange={(e) => setPhaseId(e.target.value)}>
            <option value="">No linked phase</option>
            {phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Button type="submit" size="sm" disabled={busyKey === 'add' || !label.trim() || !percentValid}><Plus size={14} aria-hidden="true" /> Add</Button>
        </div>
        {percent !== '' && !percentValid && <p role="alert" className="text-xs text-danger-500">Enter a percentage between 0 and {formatPercent(remaining, 1)}.</p>}
      </form>

      {project.retainage_percent > 0 && (
        <section className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
          <div className="flex items-start gap-3">
            <Landmark size={20} className="mt-0.5 text-accent" aria-hidden="true" />
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Retainage</h3>
              <p className="text-sm text-text-secondary">
                {retainageInvoice ? `Released on ${retainageInvoice.invoice_number}.` : releasable ? `${formatMoney(summary.retainageHeldCents)} is ready to invoice.` : project.status === 'completed' ? 'No retainage is currently held.' : `${formatMoney(summary.retainageHeldCents)} held so far. Mark the project completed to release it.`}
              </p>
            </div>
          </div>
          {releasable && (
            <Button size="sm" disabled={busyKey === 'release'} onClick={() => ask({ title: 'Release retainage?', description: `A draft invoice for ${formatMoney(summary.retainageHeldCents)} will be created in Invoicing.`, label: 'Create invoice', onConfirm: () => run('release', () => releaseRetainage(project.id, addDaysIso(today, DEFAULT_TERMS_DAYS)), 'Retainage invoice created as a draft.') })}>
              Release retainage
            </Button>
          )}
        </section>
      )}
      {dialog}
    </div>
  );
}
