import { useCallback, useState } from 'react';
import { ClipboardCheck, Loader2, RefreshCw, CheckCircle2, CircleAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { WarrantyClaim } from '@/lib/supabase';
import {
  CLAIM_ACTION_LABELS,
  CREDIT_METHOD_LABELS,
  availableActions,
  dollarsToCents,
  formatCents,
  type ClaimAction,
  type CreditMethod,
  type WarrantyClaimPacket,
} from '@/lib/warrantyClaimRecovery';
import {
  approveForSubmission,
  fetchClaimPacket,
  markSubmitted,
  recordPayment,
  transitionClaim,
  WarrantyRecoveryError,
} from '@/lib/warrantyClaimRecoveryApi';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';
const btn =
  'focus-ring min-h-[36px] rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50';

type Mode = null | 'packet' | 'submit' | 'payment' | 'deny';

interface Props {
  claim: WarrantyClaim;
  /** Office/owner only — mirrors warranty_recovery_can_manage() in the database, which is the real gate. */
  canManage: boolean;
  onChanged: () => void;
}

export function ClaimWorkflowPanel({ claim, canManage, onChanged }: Props) {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [packet, setPacket] = useState<WarrantyClaimPacket | null>(null);
  const [packetLoading, setPacketLoading] = useState(false);
  const [packetError, setPacketError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [ref, setRef] = useState('');
  const [amount, setAmount] = useState(claim.credit_received_cents != null ? String(claim.credit_received_cents / 100) : '');
  const [receivedOn, setReceivedOn] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<CreditMethod>((claim.credit_method as CreditMethod) ?? 'account_credit');
  const [reason, setReason] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState<'expire' | 'close' | null>(null);

  const actions = canManage ? availableActions(claim.status) : [];

  const loadPacket = useCallback(async () => {
    setPacketLoading(true);
    setPacketError(null);
    try {
      setPacket(await fetchClaimPacket(claim.id));
    } catch (e) {
      setPacketError(e instanceof WarrantyRecoveryError ? e.message : 'Could not load the packet.');
    } finally {
      setPacketLoading(false);
    }
  }, [claim.id]);

  const open = (next: Mode) => {
    setConfirmed(false);
    if (mode === next) { setMode(null); return; }
    setMode(next);
    if (next === 'packet') void loadPacket();
  };

  const run = async (fn: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await fn();
      toast(success, 'success');
      setMode(null);
      onChanged();
    } catch (e) {
      toast(e instanceof WarrantyRecoveryError ? e.message : 'Something went wrong. Please try again.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const onAction = (a: ClaimAction) => {
    if (a === 'approve') return open('packet');
    if (a === 'submit') return open('submit');
    if (a === 'record_payment') return open('payment');
    if (a === 'deny') return open('deny');
    if (a === 'back_to_review') return void run(() => transitionClaim(claim.id, 'needs_review'), 'Sent back to review');
    if (a === 'expire') return setPendingConfirm('expire');
    if (a === 'close') return setPendingConfirm('close');
  };

  const submitPayment = () => {
    const cents = dollarsToCents(amount);
    if (cents === null) { toast('Enter the amount you were paid (more than $0).', 'error'); return; }
    setBusy(true);
    recordPayment(claim.id, cents, receivedOn || null, method)
      .then((r) => {
        toast(
          r.shortfall_cents && r.shortfall_cents > 0
            ? `Recorded ${formatCents(r.recovered_cents)} recovered (${formatCents(r.shortfall_cents)} short of the claim).`
            : `Recorded ${formatCents(r.recovered_cents)} recovered.`,
          'success',
        );
        setMode(null);
        onChanged();
      })
      .catch((e) => toast(e instanceof WarrantyRecoveryError ? e.message : 'Could not record the payment.', 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => open('packet')} className={`${btn} flex items-center gap-1 border border-border text-text-secondary hover:text-text-primary`}>
          <ClipboardCheck size={13} /> {mode === 'packet' ? 'Hide packet' : 'View packet'}
        </button>
        {actions.filter((a) => a !== 'approve' || mode !== 'packet').map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => onAction(a)}
            className={`${btn} ${a === 'approve' || a === 'record_payment' ? 'bg-accent text-white hover:brightness-110' : 'border border-border text-text-secondary hover:text-text-primary'}`}
          >
            {a === 'record_payment' && claim.status === 'credit_received' ? 'Correct payment' : CLAIM_ACTION_LABELS[a]}
          </button>
        ))}
        {!canManage && <span className="text-xs text-text-secondary">View only — ask an office manager to action claims.</span>}
      </div>

      {mode === 'packet' && (
        <div className="mt-3 rounded-xl bg-bg-primary p-3" aria-live="polite">
          {packetLoading ? (
            <div className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin" /> Building packet from your records…</div>
          ) : packetError ? (
            <div className="flex flex-wrap items-center gap-3 text-sm text-danger">
              <span>{packetError}</span>
              <button type="button" onClick={() => void loadPacket()} className={`${btn} flex items-center gap-1 border border-border text-text-primary`}><RefreshCw size={12} /> Retry</button>
            </div>
          ) : packet ? (
            <>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {packet.items.map((it) => (
                  <li key={it.key} className="flex items-start gap-2 text-sm">
                    {it.present
                      ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success-500" />
                      : <CircleAlert size={15} className={`mt-0.5 shrink-0 ${it.blocking ? 'text-danger' : 'text-warning-500'}`} />}
                    <span className={it.present ? 'text-text-primary' : 'text-text-secondary'}>
                      {it.label}{!it.present && (it.blocking ? ' — missing (required)' : ' — missing')}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 space-y-1 text-xs text-text-secondary">
                <p>Unit: {[packet.unit.manufacturer, packet.unit.model_number].filter(Boolean).join(' ') || 'not on file'}{packet.unit.serial_number ? ` · S/N ${packet.unit.serial_number}` : ''}{packet.unit.install_date ? ` · installed ${packet.unit.install_date}` : ''}</p>
                <p>Parts: {packet.parts.length ? packet.parts.map((p) => `${p.quantity}× ${p.name}`).join(', ') : 'none recorded'} · Labor: {packet.labor.hours != null ? `${packet.labor.hours} h` : 'none recorded'} · Photos: {packet.photos.length}</p>
                {packet.failure_notes.text && <p>Notes ({(packet.failure_notes.source ?? '').replace(/_/g, ' ')}): {packet.failure_notes.text}</p>}
              </div>
              {claim.status === 'needs_review' || claim.status === 'eligible' || claim.status === 'packet_pending' ? (
                <div className="mt-3 border-t border-border/60 pt-3">
                  {!packet.complete && (
                    <p className="mb-2 text-xs text-danger">Fix the required items above (edit the claim) before approving. Nothing is sent to the manufacturer from Vireek.</p>
                  )}
                  <label className="flex items-start gap-2 text-sm text-text-primary">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={!packet.complete} className="mt-0.5 h-4 w-4 accent-accent" />
                    I reviewed this packet and approve it for submission.
                  </label>
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={busy || !packet.complete || !confirmed} onClick={() => void run(() => approveForSubmission(claim.id), 'Approved — ready to submit')} className={`${btn} bg-accent text-white hover:brightness-110`}>
                      {busy ? 'Approving…' : CLAIM_ACTION_LABELS.approve}
                    </button>
                    <button type="button" onClick={() => void loadPacket()} className={`${btn} flex items-center gap-1 border border-border text-text-secondary`}><RefreshCw size={12} /> Refresh</button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-text-secondary">No packet data.</p>
          )}
        </div>
      )}

      {mode === 'submit' && (
        <div className="mt-3 space-y-2 rounded-xl bg-bg-primary p-3">
          <p className="text-xs text-text-secondary">File the claim yourself with the manufacturer or distributor, then enter the reference number they gave you. Vireek does not contact them.</p>
          <input type="text" value={ref} maxLength={120} onChange={(e) => setRef(e.target.value)} placeholder="Manufacturer reference / claim #" className={inputClass} aria-label="Manufacturer reference number" />
          <label className="flex items-start gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-accent" />
            I submitted this claim myself, outside Vireek.
          </label>
          <button type="button" disabled={busy || !ref.trim() || !confirmed} onClick={() => void run(() => markSubmitted(claim.id, ref.trim()), 'Marked as submitted')} className={`${btn} bg-accent text-white hover:brightness-110`}>
            {busy ? 'Saving…' : 'Save as submitted'}
          </button>
        </div>
      )}

      {mode === 'payment' && (
        <div className="mt-3 space-y-2 rounded-xl bg-bg-primary p-3">
          <p className="text-xs text-text-secondary">Enter the amount the manufacturer actually paid or credited. This is added to your recovered-revenue ledger.</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount paid ($)" className={inputClass} aria-label="Amount paid" />
            <input type="date" value={receivedOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setReceivedOn(e.target.value)} className={inputClass} aria-label="Date received" />
            <select value={method} onChange={(e) => setMethod(e.target.value as CreditMethod)} className={inputClass} aria-label="Payment method">
              {(Object.keys(CREDIT_METHOD_LABELS) as CreditMethod[]).map((m) => <option key={m} value={m}>{CREDIT_METHOD_LABELS[m]}</option>)}
            </select>
          </div>
          <button type="button" disabled={busy} onClick={submitPayment} className={`${btn} bg-accent text-white hover:brightness-110`}>
            {busy ? 'Saving…' : 'Record payment'}
          </button>
        </div>
      )}

      {mode === 'deny' && (
        <div className="mt-3 space-y-2 rounded-xl bg-bg-primary p-3">
          <input type="text" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="Denial reason (optional)" className={inputClass} aria-label="Denial reason" />
          <button type="button" disabled={busy} onClick={() => void run(() => transitionClaim(claim.id, 'denied', reason), 'Marked as denied')} className={`${btn} border border-border text-text-primary`}>
            {busy ? 'Saving…' : 'Confirm denied'}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm === 'expire' ? 'Mark this claim expired?' : 'Close this claim?'}
        description={pendingConfirm === 'expire' ? 'Use this when the filing window has passed. You can only close it afterwards.' : 'Closed claims leave the open list. This cannot be reopened.'}
        confirmLabel={pendingConfirm === 'expire' ? 'Yes, mark expired' : 'Yes, close it'}
        onConfirm={() => {
          const to = pendingConfirm;
          setPendingConfirm(null);
          if (to) void run(() => transitionClaim(claim.id, to === 'expire' ? 'expired' : 'closed'), to === 'expire' ? 'Marked expired' : 'Claim closed');
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    </div>
  );
}
