import { useMemo, useState } from 'react';
import { AlertTriangle, Ban, FilePlus2, Link2, Plus, RefreshCw, ShieldCheck, ShieldPlus, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  CONTRACT_STATUS_COLORS,
  CONTRACT_STATUS_LABELS,
  blockerMessage,
  certificateLink,
  daysLeftLabel,
  effectiveStatus,
  formatMoney,
  renewalState,
  termLabel,
  type PlanClaim,
  type PlanTemplate,
  type ProtectionContract,
} from '@/lib/protectionPlans';
import { ActivateDialog, AttachInvoiceDialog, CancelDialog, LinkUnitsDialog, RenewDialog, SellDialog } from './ContractDialogs';
import { Pill, cardClass, fmtDate, inputClass, unitLabel } from './ui';

type FilterKey = 'attention' | 'active' | 'pending' | 'renewals' | 'ended' | 'all';
type Dialog =
  | { type: 'sell' }
  | { type: 'attach' | 'activate' | 'link' | 'cancel' | 'renew'; contract: ProtectionContract };

export function ContractsPanel({
  contracts,
  claims,
  templates,
  canManage,
  onChanged,
  onFileClaim,
}: {
  contracts: ProtectionContract[];
  claims: PlanClaim[];
  templates: PlanTemplate[];
  canManage: boolean;
  onChanged: () => void;
  onFileClaim: (contractId: string) => void;
}) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<FilterKey>('attention');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const enriched = useMemo(
    () =>
      contracts.map((c) => ({
        c,
        status: effectiveStatus(c),
        renewal: renewalState(c, contracts),
        needsAttention:
          !!c.activation_blocker ||
          (c.status === 'pending_payment' && c.protection_contract_equipment.length === 0) ||
          (c.status === 'pending_payment' && !c.invoice_id),
      })),
    [contracts],
  );

  const counts = useMemo(
    () => ({
      attention: enriched.filter((e) => e.needsAttention || e.renewal === 'due').length,
      active: enriched.filter((e) => e.status === 'active' || e.status === 'scheduled').length,
      pending: enriched.filter((e) => e.status === 'pending_payment').length,
      renewals: enriched.filter((e) => e.renewal === 'due').length,
      ended: enriched.filter((e) => e.status === 'expired' || e.status === 'cancelled').length,
      all: enriched.length,
    }),
    [enriched],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return enriched.filter((e) => {
      if (q && !`${e.c.contract_number} ${e.c.customer_name} ${e.c.plan_name}`.toLowerCase().includes(q)) return false;
      switch (filter) {
        case 'attention':
          return e.needsAttention || e.renewal === 'due';
        case 'active':
          return e.status === 'active' || e.status === 'scheduled';
        case 'pending':
          return e.status === 'pending_payment';
        case 'renewals':
          return e.renewal === 'due';
        case 'ended':
          return e.status === 'expired' || e.status === 'cancelled';
        default:
          return true;
      }
    });
  }, [enriched, filter, query]);

  const filters: { key: FilterKey; label: string }[] = [
    { key: 'attention', label: 'Needs action' },
    { key: 'active', label: 'Active' },
    { key: 'pending', label: 'Awaiting payment' },
    { key: 'renewals', label: 'Renewals due' },
    { key: 'ended', label: 'Ended' },
    { key: 'all', label: 'All' },
  ];

  const copyLink = async (c: ProtectionContract) => {
    try {
      await navigator.clipboard.writeText(certificateLink(c.public_token));
      toast('Certificate link copied', 'success');
    } catch {
      toast('Could not copy — select and copy the link manually', 'error');
    }
  };

  const done = (message?: string) => {
    setDialog(null);
    if (message) toast(message, 'success');
    onChanged();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Plan filter">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`focus-ring rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
            >
              {f.label} <span className="opacity-70">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setDialog({ type: 'sell' })}>
            <Plus size={16} /> Sell a plan
          </Button>
        )}
      </div>

      <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by customer, plan or number…" aria-label="Search plans" />

      {shown.length === 0 ? (
        contracts.length === 0 ? (
          <EmptyState
            icon={ShieldPlus}
            title="No plans sold yet"
            description="Sell a plan on an invoice, or offer one at checkout on a quote. Active plans, claims and renewals show up here."
            action={canManage ? { label: 'Sell a plan', onClick: () => setDialog({ type: 'sell' }) } : undefined}
          />
        ) : (
          <EmptyState icon={ShieldCheck} title="Nothing here" description="No plans match this filter." />
        )
      ) : (
        <ul className="space-y-3">
          {shown.map(({ c, status, renewal }) => {
            const blocker = blockerMessage(c.activation_blocker);
            const openClaims = claims.filter((k) => k.protection_contract_id === c.id && ['eligible', 'packet_pending', 'submitted', 'approved'].includes(k.status)).length;
            return (
              <li key={c.id} className={cardClass}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-text-primary">
                      {c.contract_number} · {c.customer_name}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {c.plan_name} · {termLabel(c.term_months)} · {formatMoney(c.price_cents)}
                      {c.source === 'renewal' ? ' · renewal' : c.source === 'quote' ? ' · sold at checkout' : ''}
                    </p>
                  </div>
                  <Pill className={CONTRACT_STATUS_COLORS[status]}>{CONTRACT_STATUS_LABELS[status]}</Pill>
                </div>

                {blocker && (
                  <p role="alert" className="mt-3 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <span>{blocker}</span>
                  </p>
                )}

                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-text-secondary sm:grid-cols-4">
                  <div>
                    <dt>Coverage</dt>
                    <dd className="text-sm font-medium text-text-primary">{c.coverage_start ? `${fmtDate(c.coverage_start)} – ${fmtDate(c.coverage_end)}` : 'Starts when paid'}</dd>
                  </div>
                  <div>
                    <dt>Time left</dt>
                    <dd className="text-sm font-medium text-text-primary">{status === 'active' ? daysLeftLabel(c.coverage_end) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Paid out</dt>
                    <dd className="text-sm font-medium text-text-primary">
                      {formatMoney(c.paid_out_cents)}
                      {c.aggregate_limit_cents !== null ? ` / ${formatMoney(c.aggregate_limit_cents)}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Open claims</dt>
                    <dd className="text-sm font-medium text-text-primary">{openClaims}</dd>
                  </div>
                </dl>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {c.protection_contract_equipment.length === 0 ? (
                    <span className="rounded-lg bg-warning-500/10 px-2 py-1 text-xs text-warning-500">No equipment linked</span>
                  ) : (
                    c.protection_contract_equipment.map((u) => (
                      <span key={u.equipment_id} className="rounded-lg bg-bg-tertiary px-2 py-1 text-xs text-text-primary">
                        {unitLabel(u.equipment)}
                      </span>
                    ))
                  )}
                </div>

                {status === 'pending_payment' && !blocker && (
                  <p className="mt-3 text-xs text-text-secondary">
                    {c.invoice_id ? 'Billed on an invoice — activates automatically when it is paid.' : 'Not billed yet — add it to an invoice or confirm payment received.'}
                  </p>
                )}
                {c.status === 'cancelled' && (
                  <p className="mt-3 text-xs text-text-secondary">
                    Cancelled {fmtDate(c.cancelled_effective)}
                    {c.refund_cents > 0 ? ` · refund due ${formatMoney(c.refund_cents)}` : ''}
                    {c.cancel_reason ? ` · ${c.cancel_reason}` : ''}
                  </p>
                )}
                {renewal === 'due' && (
                  <p className="mt-3 text-xs font-medium text-accent">Renewal window is open — renew to keep the customer covered without a gap.</p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {canManage && c.status === 'pending_payment' && (
                    <>
                      {c.protection_contract_equipment.length < c.max_equipment && (
                        <Button size="sm" variant="secondary" onClick={() => setDialog({ type: 'link', contract: c })}>
                          <Link2 size={14} /> Cover equipment
                        </Button>
                      )}
                      <Button size="sm" variant="secondary" onClick={() => setDialog({ type: 'attach', contract: c })}>
                        <FilePlus2 size={14} /> {c.invoice_id ? 'Move to another invoice' : 'Add to invoice'}
                      </Button>
                      {!c.invoice_id && c.protection_contract_equipment.length > 0 && (
                        <Button size="sm" onClick={() => setDialog({ type: 'activate', contract: c })}>
                          <Wallet size={14} /> Paid separately
                        </Button>
                      )}
                    </>
                  )}
                  {canManage && c.status === 'active' && status !== 'expired' && c.protection_contract_equipment.length < c.max_equipment && (
                    <Button size="sm" variant="secondary" onClick={() => setDialog({ type: 'link', contract: c })}>
                      <Link2 size={14} /> Cover equipment
                    </Button>
                  )}
                  {(status === 'active' || status === 'expired') && c.protection_contract_equipment.length > 0 && (
                    <Button size="sm" variant="secondary" onClick={() => onFileClaim(c.id)}>
                      File claim
                    </Button>
                  )}
                  {canManage && renewal === 'due' && (
                    <Button size="sm" onClick={() => setDialog({ type: 'renew', contract: c })}>
                      <RefreshCw size={14} /> Renew
                    </Button>
                  )}
                  {c.status !== 'cancelled' && (
                    <Button size="sm" variant="ghost" onClick={() => void copyLink(c)}>
                      Copy certificate link
                    </Button>
                  )}
                  {canManage && (c.status === 'pending_payment' || c.status === 'active') && (
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ type: 'cancel', contract: c })}>
                      <Ban size={14} /> Cancel
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {dialog?.type === 'sell' && <SellDialog templates={templates} onClose={() => setDialog(null)} onDone={(n) => done(`Plan ${n} created`)} />}
      {dialog?.type === 'attach' && <AttachInvoiceDialog contract={dialog.contract} onClose={() => setDialog(null)} onDone={() => done('Added to the invoice')} />}
      {dialog?.type === 'activate' && <ActivateDialog contract={dialog.contract} onClose={() => setDialog(null)} onDone={() => done('Plan activated')} />}
      {dialog?.type === 'link' && <LinkUnitsDialog contract={dialog.contract} onClose={() => setDialog(null)} onDone={() => done('Equipment covered')} />}
      {dialog?.type === 'cancel' && (
        <CancelDialog
          contract={dialog.contract}
          claims={claims}
          onClose={() => setDialog(null)}
          onDone={(refund) => done(refund > 0 ? `Plan cancelled — refund due ${formatMoney(refund)}` : 'Plan cancelled')}
        />
      )}
      {dialog?.type === 'renew' && <RenewDialog contract={dialog.contract} onClose={() => setDialog(null)} onDone={(n) => done(`Renewal ${n} created`)} />}
    </div>
  );
}
