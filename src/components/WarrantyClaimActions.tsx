import { useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { downloadWarrantyClaimFullPacketPdf } from '@/lib/pdf';
import { CLAIM_STATUS_LABELS } from '@/lib/warrantyClaimRecovery';
import {
  WccStatus, applyWarrantyPayment, buildTransitionPatch, createWarrantyInvoice, fetchClaimPacket,
  missingLabel, nextStatuses, normalizeStatus, transitionErrorMessage,
} from '@/lib/warrantyClaimToCash';

interface Props {
  claim: { id: string; status: string; ar_invoice_id?: string | null; ar_payment_id?: string | null; approved_amount_cents?: number | null };
  onChanged: () => void;
}

const field = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-xs text-text-primary';
const btn = 'focus-ring rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50';
const dollarsToCents = (v: string): number | undefined => {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
};

export function WarrantyClaimActions({ claim, onChanged }: Props) {
  const { toast } = useToast();
  const [target, setTarget] = useState<WccStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState('');
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState<string[] | null>(null);
  const status = normalizeStatus(claim.status);
  const options = nextStatuses(status);

  const run = async (fn: () => Promise<void>, fail: string) => {
    setBusy(true);
    try { await fn(); onChanged(); } catch (e) {
      toast(fail === 'status' ? transitionErrorMessage((e as { message?: string })?.message) : fail, 'error');
    } finally { setBusy(false); }
  };

  const submit = () => {
    if (!target) return;
    const cents = dollarsToCents(amount);
    const patch = buildTransitionPatch(target, {
      claimNumber: ref, submittedAt: date ? new Date(date).toISOString() : undefined,
      approvedCents: cents, denialReason: reason, paidCents: cents, paidAt: date || undefined,
    });
    void run(async () => {
      const { error } = await supabase.from('warranty_claims').update(patch).eq('id', claim.id);
      if (error) throw error;
      setTarget(null); setRef(''); setDate(''); setAmount(''); setReason('');
    }, 'status');
  };

  const packet = () => run(async () => {
    const p = await fetchClaimPacket(claim.id);
    setMissing(p.missing);
    downloadWarrantyClaimFullPacketPdf(p);
  }, 'Could not build the claim packet');

  return (
    <div className="flex w-56 flex-col items-end gap-1.5 text-xs">
      <span className="rounded-full bg-bg-tertiary px-3 py-1 font-medium text-text-primary">
        {CLAIM_STATUS_LABELS[claim.status as keyof typeof CLAIM_STATUS_LABELS] ?? status}
      </span>
      <div className="flex flex-wrap justify-end gap-1">
        {options.map((s) => (
          <button key={s} type="button" disabled={busy} className={btn} onClick={() => setTarget(s)}>
            {s.replace('_', ' ')}
          </button>
        ))}
        <button type="button" disabled={busy} className={btn} onClick={packet}>Packet PDF</button>
        {status === 'approved' && !claim.ar_invoice_id && (
          <button type="button" disabled={busy} className={btn}
            onClick={() => run(async () => { await createWarrantyInvoice(claim.id); }, 'Could not create the invoice')}>
            Bill manufacturer
          </button>
        )}
        {status === 'paid' && claim.ar_invoice_id && !claim.ar_payment_id && (
          <button type="button" disabled={busy} className={btn}
            onClick={() => run(async () => { await applyWarrantyPayment(claim.id); }, 'Could not record the deposit')}>
            Record deposit
          </button>
        )}
      </div>
      {missing && missing.length > 0 && (
        <p className="text-right text-warning-500">Missing: {missing.map(missingLabel).join(', ')}</p>
      )}
      {target && (
        <div className="w-full space-y-1.5 rounded-xl border border-border p-2">
          <p className="font-medium text-text-primary">Move to “{target.replace('_', ' ')}”</p>
          {target === 'submitted' && (<>
            <input className={field} placeholder="Manufacturer reference #" value={ref} onChange={(e) => setRef(e.target.value)} />
            <input className={field} type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Submitted date" />
          </>)}
          {target === 'approved' && <input className={field} inputMode="decimal" placeholder="Approved amount ($)" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          {target === 'denied' && <input className={field} placeholder="Denial reason" value={reason} onChange={(e) => setReason(e.target.value)} />}
          {target === 'paid' && (<>
            <input className={field} inputMode="decimal" placeholder="Amount paid ($)" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <input className={field} type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Paid date" />
          </>)}
          <div className="flex justify-end gap-1">
            <button type="button" className={btn} onClick={() => setTarget(null)}>Cancel</button>
            <button type="button" className={btn} disabled={busy} onClick={submit}>Confirm</button>
          </div>
        </div>
      )}
    </div>
  );
}
