import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Banknote, CreditCard, FileText, Loader2, Nfc, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { SkeletonCardList } from '@/components/Skeleton';
import { EmptyStateError } from '@/components/EmptyState';
import {
  JobPayment, JobPaymentSummary, ManualMethod, PaymentError,
  cancelCardPayment, computeCashChange, createCardIntent, describePaymentError, fetchJobPaymentSummary,
  finalizeCardPayment, formatCents, MIN_CARD_CENTS, newRequestId, parseMoneyToCents, recordManualPayment,
  validateCheckNumber,
} from '@/lib/inPersonPayments';
import { tapToPayDriver } from '@/lib/terminalDriver';

type Mode = null | 'card' | ManualMethod;

function Sheet({ title, onClose, busy, children }: { title: string; onClose: () => void; busy: boolean; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-bg-primary p-4 pb-8">
        <h2 className="mb-3 text-base font-semibold text-text-primary">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const METHOD_LABEL: Record<string, string> = { card_present: 'Card (Tap to Pay)', cash: 'Cash', check: 'Check' };

function PaymentRow({ p }: { p: JobPayment }) {
  const detail =
    p.method === 'check' ? `#${p.check_number ?? '—'}${p.check_bank ? ` · ${p.check_bank}` : ''}`
    : p.method === 'card_present' ? `${p.card_brand ?? 'Card'}${p.card_last4 ? ` ••${p.card_last4}` : ''}`
    : p.tendered_cents && p.tendered_cents > p.amount_cents ? `Received ${formatCents(p.tendered_cents)}` : '';
  const tag = p.status === 'voided' ? 'Voided' : p.status === 'pending' ? 'Pending' : p.deposit_status === 'undeposited' ? 'Undeposited' : p.deposit_status === 'deposited' ? 'Deposited' : '';
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <p className={`font-medium ${p.status === 'voided' ? 'text-text-secondary line-through' : 'text-text-primary'}`}>{METHOD_LABEL[p.method]}</p>
        <p className="truncate text-xs text-text-secondary">{[detail, new Date(p.received_at).toLocaleString()].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="text-right">
        <p className="font-semibold text-text-primary">{formatCents(p.amount_cents)}</p>
        {tag && <p className="text-xs text-text-secondary">{tag}</p>}
      </div>
    </li>
  );
}

export function JobPaymentPanel({ jobId, onChanged }: { jobId: string; onChanged?: () => void }) {
  const [summary, setSummary] = useState<JobPaymentSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try { setSummary(await fetchJobPaymentSummary(jobId)); } catch { setLoadError(true); }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  const done = useCallback(async (n?: { tone: 'success' | 'warning'; text: string }) => {
    setMode(null);
    if (n) setNotice(n);
    await load();
    onChanged?.();
  }, [load, onChanged]);

  if (loadError) return <EmptyStateError icon={AlertTriangle} title="Couldn't load payments" onRetry={load} />;
  if (!summary) return <SkeletonCardList count={1} rows={3} />;

  const canTapToPay = tapToPayDriver.isSupported() && summary.card_ready;
  const due = summary.balance_cents;

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-3" aria-label="Payment">
      <h2 className="mb-2 text-sm font-semibold text-text-primary">Payment</h2>
      <dl className="grid grid-cols-3 gap-2 text-center">
        {[['Invoice', summary.invoice_cents], ['Paid', summary.paid_cents], ['Balance due', due]].map(([l, v]) => (
          <div key={l as string} className="rounded-md bg-bg-primary p-2">
            <dt className="text-xs text-text-secondary">{l}</dt>
            <dd className="text-sm font-semibold text-text-primary">{formatCents(v as number)}</dd>
          </div>
        ))}
      </dl>

      {notice && (
        <p role="status" className={`mt-2 flex items-start gap-2 rounded-md p-2 text-xs ${notice.tone === 'success' ? 'bg-success-500/10 text-success-500' : 'bg-warning-500/10 text-warning-500'}`}>
          {notice.tone === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />}
          <span>{notice.text}</span>
        </p>
      )}

      {summary.invoice_cents <= 0 ? (
        <p className="mt-3 text-sm text-text-secondary">Set an invoice amount on this job before taking payment.</p>
      ) : due > 0 ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Button size="sm" disabled={!canTapToPay} onClick={() => setMode('card')}><Nfc className="h-4 w-4" /> Tap</Button>
          <Button size="sm" variant="secondary" onClick={() => setMode('cash')}><Banknote className="h-4 w-4" /> Cash</Button>
          <Button size="sm" variant="secondary" onClick={() => setMode('check')}><FileText className="h-4 w-4" /> Check</Button>
        </div>
      ) : (
        <p className="mt-3 flex items-center gap-1 text-sm font-medium text-success-500"><CheckCircle2 className="h-4 w-4" /> Paid in full</p>
      )}
      {due > 0 && summary.invoice_cents > 0 && !canTapToPay && (
        <p className="mt-2 text-xs text-text-secondary">
          {tapToPayDriver.isSupported() ? 'Card payments need Stripe to be fully connected.' : 'Tap to Pay is available in the Vireek Field app on your phone.'}
        </p>
      )}

      {summary.payments.length > 0 && <ul className="mt-3 divide-y divide-border">{summary.payments.map((p) => <PaymentRow key={p.id} p={p} />)}</ul>}

      {mode === 'card' && <CardSheet jobId={jobId} balance={due} onClose={() => setMode(null)} onDone={done} />}
      {(mode === 'cash' || mode === 'check') && <ManualSheet jobId={jobId} method={mode} balance={due} onClose={() => setMode(null)} onDone={done} />}
    </section>
  );
}

/* ----------------------------- cash / check ----------------------------- */

function ManualSheet({ jobId, method, balance, onClose, onDone }: {
  jobId: string; method: ManualMethod; balance: number; onClose: () => void;
  onDone: (n?: { tone: 'success' | 'warning'; text: string }) => Promise<void>;
}) {
  const requestId = useRef(newRequestId());
  const [amount, setAmount] = useState((balance / 100).toFixed(2));
  const [checkNumber, setCheckNumber] = useState('');
  const [bank, setBank] = useState('');
  const [payer, setPayer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entered = parseMoneyToCents(amount);
  const cash = method === 'cash' && entered ? computeCashChange(entered, balance) : null;
  const checkValidation = method === 'check' ? validateCheckNumber(checkNumber) : null;

  async function submit() {
    setError(null);
    if (!entered) return setError('Enter a valid amount.');
    if (checkValidation && !checkValidation.ok) return setError(checkValidation.error);
    const applied = cash ? cash.appliedCents : entered;
    if (applied > balance) return setError(describePaymentError('exceeds_balance'));
    setBusy(true);
    try {
      const res = await recordManualPayment({
        jobId, method, amountCents: applied, clientRequestId: requestId.current,
        tenderedCents: method === 'cash' ? entered : undefined,
        checkNumber: checkValidation?.ok ? checkValidation.value : undefined,
        checkBank: bank || undefined, checkPayer: payer || undefined, note: note || undefined,
      });
      if (!res.success) { setError(describePaymentError(res.error)); return; }
      const warn = res.invoice_gate_blocked ? 'Payment recorded, but the invoice can’t be marked paid until the job’s required proof is complete.'
        : res.warning === 'check_number_seen_elsewhere' ? 'Payment recorded. This check number was used on another job recently — double-check it.' : null;
      const change = cash && cash.changeCents > 0 ? ` Give ${formatCents(cash.changeCents)} change.` : '';
      await onDone(warn ? { tone: 'warning', text: warn + change } : { tone: 'success', text: `${formatCents(applied)} ${method} recorded.${change}` });
    } catch {
      setError('Network problem. Your entry is safe — tap Record again to retry without double-charging.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={method === 'cash' ? 'Record cash payment' : 'Record check payment'} onClose={onClose} busy={busy}>
      <div className="space-y-3">
        <Input label={method === 'cash' ? 'Cash received' : 'Check amount'} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        {cash && (
          <p className="text-sm text-text-secondary" aria-live="polite">
            Applied {formatCents(cash.appliedCents)}{cash.changeCents > 0 && <> · <strong className="text-text-primary">Change due {formatCents(cash.changeCents)}</strong></>}
          </p>
        )}
        {method === 'check' && (
          <>
            <Input label="Check number" required value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} maxLength={20} />
            <Input label="Bank (optional)" value={bank} onChange={(e) => setBank(e.target.value)} maxLength={80} />
            <Input label="Name on check (optional)" value={payer} onChange={(e) => setPayer(e.target.value)} maxLength={120} />
          </>
        )}
        <Textarea label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button className="flex-1" onClick={submit} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Record</Button>
        </div>
      </div>
    </Sheet>
  );
}

/* ------------------------------- Tap to Pay ------------------------------- */

type Phase = 'idle' | 'preparing' | 'waiting' | 'finalizing' | 'error';

function CardSheet({ jobId, balance, onClose, onDone }: {
  jobId: string; balance: number; onClose: () => void;
  onDone: (n?: { tone: 'success' | 'warning'; text: string }) => Promise<void>;
}) {
  const requestId = useRef(newRequestId());
  const [amount, setAmount] = useState((balance / 100).toFixed(2));
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== 'idle' && phase !== 'error';

  async function start() {
    setError(null);
    const cents = parseMoneyToCents(amount);
    if (!cents || cents < MIN_CARD_CENTS) return setError('Card payments must be at least $0.50.');
    if (cents > balance) return setError(describePaymentError('exceeds_balance'));
    let paymentId: string | null = null;
    try {
      setPhase('preparing');
      await tapToPayDriver.prepare();
      const intent = await createCardIntent({ jobId, amountCents: cents, clientRequestId: requestId.current });
      paymentId = intent.job_payment_id;
      setPhase('waiting');
      await tapToPayDriver.collectAndConfirm(intent.client_secret);
      setPhase('finalizing');
      const res = await finalizeCardPayment(paymentId);
      if (res.status === 'succeeded') {
        await onDone(res.invoice_gate_blocked
          ? { tone: 'warning', text: 'Card payment received, but the invoice can’t be marked paid until the job’s required proof is complete.' }
          : { tone: 'success', text: `${formatCents(cents)} card payment received.` });
      } else {
        await onDone({ tone: 'warning', text: 'Card payment is still processing. It will update here shortly.' });
      }
    } catch (e) {
      if (paymentId) {
        await tapToPayDriver.cancel();
        try { await cancelCardPayment(paymentId); } catch { /* server reconciles via webhook */ }
      }
      requestId.current = newRequestId(); // a fresh attempt must never reuse a failed id
      setError(e instanceof PaymentError ? e.message : e instanceof Error && e.message ? e.message : 'The card could not be read. Please try again.');
      setPhase('error');
    }
  }

  const label: Record<Phase, string> = {
    idle: 'Start Tap to Pay', error: 'Try again', preparing: 'Getting ready…', waiting: 'Hold card or phone near the back of this device…', finalizing: 'Confirming payment…',
  };

  return (
    <Sheet title="Tap to Pay" onClose={onClose} busy={busy}>
      <div className="space-y-3">
        <Input label="Amount to charge" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} autoFocus />
        <p className="text-xs text-text-secondary">Balance due {formatCents(balance)}. Partial payments are allowed.</p>
        {busy && <p role="status" className="flex items-center gap-2 text-sm text-text-primary"><Loader2 className="h-4 w-4 animate-spin" /> {label[phase]}</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={busy}>Close</Button>
          <Button className="flex-1" onClick={start} disabled={busy}><CreditCard className="h-4 w-4" /> {phase === 'error' ? label.error : label.idle}</Button>
        </div>
      </div>
    </Sheet>
  );
}
