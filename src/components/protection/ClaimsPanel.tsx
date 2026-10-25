import { useMemo, useState, type FormEvent } from 'react';
import { Check, CircleDollarSign, FileWarning, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  CLAIM_BLOCK_MESSAGES,
  CLAIM_STATUS_COLORS,
  CLAIM_STATUS_LABELS,
  PAYOUT_METHOD_LABELS,
  claimBlockReason,
  closeClaim,
  decideClaim,
  fileClaim,
  formatMoney,
  isOpenClaim,
  parseMoney,
  payableCents,
  protectionErrorMessage,
  remainingCents,
  settleClaim,
  todayString,
  type PayoutMethod,
  type PlanClaim,
  type ProtectionContract,
} from '@/lib/protectionPlans';
import { ErrorText, Field, Modal, Pill, cardClass, fmtDate, inputClass, unitLabel } from './ui';

// ─── File a claim ──────────────────────────────────────────────────────────

export function FileClaimDialog({
  contracts,
  claims,
  initialContractId,
  onClose,
  onDone,
}: {
  contracts: ProtectionContract[];
  claims: PlanClaim[];
  initialContractId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const eligible = useMemo(
    () => contracts.filter((c) => (c.status === 'active' || c.status === 'expired') && c.protection_contract_equipment.length > 0),
    [contracts],
  );
  const [contractId, setContractId] = useState(initialContractId && eligible.some((c) => c.id === initialContractId) ? initialContractId : (eligible[0]?.id ?? ''));
  const contract = eligible.find((c) => c.id === contractId) ?? null;
  const [unitId, setUnitId] = useState('');
  const [date, setDate] = useState(todayString());
  const [description, setDescription] = useState('');
  const [part, setPart] = useState('');
  const [labor, setLabor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unit = contract?.protection_contract_equipment.find((u) => u.equipment_id === unitId) ?? contract?.protection_contract_equipment[0] ?? null;
  const contractClaims = claims.filter((c) => c.protection_contract_id === contractId);
  const block = contract && unit ? claimBlockReason(contract, unit, date, contractClaims) : null;

  const partP = part.trim() === '' ? { ok: true as const, cents: 0 } : parseMoney(part, { allowZero: true, max: 100_000_000 });
  const laborP = labor.trim() === '' ? { ok: true as const, cents: 0 } : parseMoney(labor, { allowZero: true, max: 100_000_000 });
  const claimed = (partP.ok ? partP.cents : 0) + (laborP.ok ? laborP.cents : 0);
  const preview = contract
    ? payableCents(claimed, contract.deductible_cents, contract.per_claim_limit_cents, remainingCents(contract, contractClaims))
    : 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!contract || !unit) return;
    if (!partP.ok) return setError(`Parts: ${partP.error}`);
    if (!laborP.ok) return setError(`Labor: ${laborP.error}`);
    if (claimed <= 0) return setError('Enter the part and/or labor cost.');
    if (description.trim().length === 0) return setError('Describe what failed.');
    setError(null);
    setBusy(true);
    try {
      await fileClaim({
        contractId: contract.id,
        equipmentId: unit.equipment_id,
        failureDate: date,
        description,
        partCostCents: partP.cents,
        laborCostCents: laborP.cents,
      });
      onDone();
    } catch (err) {
      setError(protectionErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal wide title="File a plan claim" description="Records the failure against the plan. A manager then approves, denies or reduces the payout." onClose={onClose}>
      {eligible.length === 0 ? (
        <p className="text-sm text-text-secondary">No active plan with covered equipment yet.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Plan" htmlFor="fc-plan">
              <select id="fc-plan" className={inputClass} value={contractId} onChange={(e) => { setContractId(e.target.value); setUnitId(''); }}>
                {eligible.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.contract_number} · {c.customer_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Covered unit" htmlFor="fc-unit">
              <select id="fc-unit" className={inputClass} value={unit?.equipment_id ?? ''} onChange={(e) => setUnitId(e.target.value)}>
                {contract?.protection_contract_equipment.map((u) => (
                  <option key={u.equipment_id} value={u.equipment_id}>
                    {unitLabel(u.equipment)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Date of failure" htmlFor="fc-date">
              <input id="fc-date" type="date" className={inputClass} value={date} max={todayString()} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>

          {block && <ErrorText message={CLAIM_BLOCK_MESSAGES[block]} />}

          <Field label="What failed?" htmlFor="fc-desc">
            <textarea id="fc-desc" rows={3} className={inputClass} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Blower motor seized; replaced under plan…" />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Parts cost ($)" htmlFor="fc-part">
              <input id="fc-part" className={inputClass} inputMode="decimal" value={part} onChange={(e) => setPart(e.target.value)} />
            </Field>
            <Field label="Labor cost ($)" htmlFor="fc-labor">
              <input id="fc-labor" className={inputClass} inputMode="decimal" value={labor} onChange={(e) => setLabor(e.target.value)} />
            </Field>
          </div>

          {contract && claimed > 0 && (
            <div className="rounded-xl bg-bg-tertiary p-3 text-sm">
              <p className="font-medium text-text-primary">Estimated payout: {formatMoney(preview)}</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                {formatMoney(claimed)} claimed − {formatMoney(contract.deductible_cents)} deductible
                {contract.per_claim_limit_cents !== null ? `, capped at ${formatMoney(contract.per_claim_limit_cents)} per claim` : ''}
                {contract.aggregate_limit_cents !== null ? ` and the remaining total limit` : ''}.
              </p>
            </div>
          )}

          <ErrorText message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !!block}>
              {busy ? 'Filing…' : 'File claim'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ─── Decide / pay ──────────────────────────────────────────────────────────

type Decision = { kind: 'approve' | 'deny' | 'pay'; claim: PlanClaim };

function DecisionDialog({
  decision,
  contract,
  claims,
  onClose,
  onDone,
}: {
  decision: Decision;
  contract: ProtectionContract | undefined;
  claims: PlanClaim[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { claim, kind } = decision;
  const payable = contract
    ? payableCents(claim.claimed_amount_cents ?? 0, claim.deductible_cents ?? 0, contract.per_claim_limit_cents, remainingCents(contract, claims, claim.id))
    : 0;
  const [amount, setAmount] = useState((payable / 100).toFixed(payable % 100 === 0 ? 0 : 2));
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<PayoutMethod>('check');
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = kind === 'approve' ? parseMoney(amount, { max: payable }) : null;
    if (parsed && !parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      if (kind === 'approve' && parsed && parsed.ok) {
        const r = await decideClaim(claim.id, 'approve', { approvedCents: parsed.cents, note });
        onDone(`Approved ${formatMoney(r.approved_cents)}`);
      } else if (kind === 'deny') {
        await decideClaim(claim.id, 'deny', { note });
        onDone('Claim denied');
      } else {
        const r = await settleClaim(claim.id, method, ref);
        onDone(`Paid ${formatMoney(r.paid_cents)}`);
      }
    } catch (err) {
      setError(protectionErrorMessage(err));
      setBusy(false);
    }
  };

  const title = kind === 'approve' ? 'Approve claim' : kind === 'deny' ? 'Deny claim' : 'Record payout';
  return (
    <Modal title={title} description={`${claim.claim_number ?? 'Claim'} · ${claim.customer_name} · claimed ${formatMoney(claim.claimed_amount_cents)}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {kind === 'approve' && (
          <>
            <p className="rounded-xl bg-bg-tertiary p-3 text-sm text-text-secondary">
              The plan covers up to <strong className="text-text-primary">{formatMoney(payable)}</strong> after the {formatMoney(claim.deductible_cents)} deductible and limits. You can approve less, never more.
            </p>
            <Field label="Approved payout ($)" htmlFor="dc-amt">
              <input id="dc-amt" className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Note (optional)" htmlFor="dc-note">
              <textarea id="dc-note" rows={2} className={inputClass} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        )}
        {kind === 'deny' && (
          <Field label="Reason (shown in the claim record)" htmlFor="dc-why">
            <textarea id="dc-why" rows={3} className={inputClass} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        {kind === 'pay' && (
          <>
            <p className="rounded-xl bg-bg-tertiary p-3 text-sm text-text-secondary">
              Pay the customer <strong className="text-text-primary">{formatMoney(claim.approved_amount_cents)}</strong>. This draws down the plan’s claims reserve.
            </p>
            <Field label="Paid by" htmlFor="dc-method">
              <select id="dc-method" className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as PayoutMethod)}>
                {(Object.keys(PAYOUT_METHOD_LABELS) as PayoutMethod[]).map((m) => (
                  <option key={m} value={m}>
                    {PAYOUT_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reference (optional)" htmlFor="dc-ref">
              <input id="dc-ref" className={inputClass} maxLength={120} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Check #1042" />
            </Field>
          </>
        )}
        <ErrorText message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || (kind === 'deny' && note.trim() === '')}>
            {busy ? 'Working…' : title}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function ClaimsPanel({
  claims,
  contracts,
  canManage,
  onChanged,
  onFile,
}: {
  claims: PlanClaim[];
  contracts: ProtectionContract[];
  canManage: boolean;
  onChanged: () => void;
  onFile: () => void;
}) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [decision, setDecision] = useState<Decision | null>(null);
  const byId = useMemo(() => new Map(contracts.map((c) => [c.id, c])), [contracts]);
  const shown = filter === 'open' ? claims.filter((c) => isOpenClaim(c.status)) : claims;

  const close = async (c: PlanClaim) => {
    try {
      await closeClaim(c.id);
      onChanged();
    } catch (e) {
      toast(protectionErrorMessage(e), 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1.5" role="group" aria-label="Claim filter">
          {(['open', 'all'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
              className={`focus-ring rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${filter === k ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
            >
              {k === 'open' ? 'Open' : 'All'}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={onFile}>
          <Plus size={16} /> File a claim
        </Button>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={FileWarning}
          title={filter === 'open' ? 'No open claims' : 'No claims yet'}
          description="Claims you file against a plan appear here for review, approval and payout."
        />
      ) : (
        <ul className="space-y-3">
          {shown.map((c) => {
            const contract = byId.get(c.protection_contract_id);
            const unit = contract?.protection_contract_equipment.find((u) => u.equipment_id === c.equipment_id);
            return (
              <li key={c.id} className={cardClass}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-text-primary">
                      {c.claim_number ?? 'Claim'} · {c.customer_name}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {unitLabel(unit?.equipment)} · failed {fmtDate(c.failure_date)}
                    </p>
                  </div>
                  <Pill className={CLAIM_STATUS_COLORS[c.status]}>{CLAIM_STATUS_LABELS[c.status]}</Pill>
                </div>
                {c.failure_description && <p className="mt-2 text-sm text-text-secondary">{c.failure_description}</p>}
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-secondary sm:grid-cols-4">
                  <div>
                    <dt>Claimed</dt>
                    <dd className="text-sm font-medium text-text-primary">{formatMoney(c.claimed_amount_cents)}</dd>
                  </div>
                  <div>
                    <dt>Deductible</dt>
                    <dd className="text-sm font-medium text-text-primary">{formatMoney(c.deductible_cents)}</dd>
                  </div>
                  <div>
                    <dt>Approved payout</dt>
                    <dd className="text-sm font-medium text-text-primary">{c.approved_amount_cents === null ? '—' : formatMoney(c.approved_amount_cents)}</dd>
                  </div>
                  <div>
                    <dt>Paid</dt>
                    <dd className="text-sm font-medium text-text-primary">{c.credit_received_cents === null ? '—' : formatMoney(c.credit_received_cents)}</dd>
                  </div>
                </dl>
                {c.denial_reason && <p className="mt-2 text-xs text-danger">Denied: {c.denial_reason}</p>}
                {canManage && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(c.status === 'submitted' || c.status === 'eligible' || c.status === 'packet_pending') && (
                      <>
                        <Button size="sm" onClick={() => setDecision({ kind: 'approve', claim: c })}>
                          <Check size={14} /> Approve
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setDecision({ kind: 'deny', claim: c })}>
                          <X size={14} /> Deny
                        </Button>
                      </>
                    )}
                    {c.status === 'approved' && (
                      <Button size="sm" onClick={() => setDecision({ kind: 'pay', claim: c })}>
                        <CircleDollarSign size={14} /> Record payout
                      </Button>
                    )}
                    {(c.status === 'credit_received' || c.status === 'denied') && (
                      <Button size="sm" variant="ghost" onClick={() => void close(c)}>
                        Archive
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {decision && (
        <DecisionDialog
          decision={decision}
          contract={byId.get(decision.claim.protection_contract_id)}
          claims={claims.filter((c) => c.protection_contract_id === decision.claim.protection_contract_id)}
          onClose={() => setDecision(null)}
          onDone={(msg) => {
            setDecision(null);
            toast(msg, 'success');
            onChanged();
          }}
        />
      )}
    </div>
  );
}
