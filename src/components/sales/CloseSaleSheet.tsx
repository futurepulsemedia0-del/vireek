import { useMemo, useRef, useState } from 'react';
import { Banknote, CheckCircle2, Copy, FileSignature, Landmark, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SignaturePad, type SignaturePadValue } from '@/components/signatures/SignaturePad';
import { useToast } from '@/contexts/ToastContext';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { createFinancingOffer } from '@/lib/financing';
import { newRequestId, parseMoneyToCents } from '@/lib/inPersonPayments';
import { moneyExact, salesErrorMessage, type LadderEntry, type PresentationPayload } from '@/lib/inHomeSales';
import {
  closeSalesWon,
  createInHomeSignatureRequest,
  recordSaleDeposit,
  submitInHomeSignature,
  type InHomeSignatureRequest,
} from '@/lib/inHomeSalesApi';

interface Props {
  open: boolean;
  onClose: () => void;
  payload: PresentationPayload;
  entry: LadderEntry;
  depositCents: number;
  termMonths: number | null;
  /** Reload the presentation payload after any server-side change. */
  onChanged: () => Promise<void>;
}

const CONSENT =
  'I agree to sign this estimate electronically and understand my electronic signature is the legal equivalent of my handwritten signature.';

export function CloseSaleSheet({ open, onClose, payload, entry, depositCents, termMonths, onChanged }: Props) {
  const { toast } = useToast();
  const trapRef = useFocusTrap(open);
  useEscapeToClose(open, onClose);

  const sp = payload.presentation;
  const sold = sp.status === 'sold';

  const [email, setEmail] = useState(payload.quote.customer_email ?? '');
  const [phone, setPhone] = useState(payload.quote.customer_phone ?? payload.job.customer_phone ?? '');
  const [consent, setConsent] = useState(false);
  const [sig, setSig] = useState<SignaturePadValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The signature covers ONE option + total; changing either invalidates it.
  const signKey = `${entry.option.id}:${entry.totalCents}`;
  const [signed, setSigned] = useState<{ key: string; req: InHomeSignatureRequest } | null>(null);
  const reqRef = useRef<{ key: string; req: InHomeSignatureRequest } | null>(null);

  const [method, setMethod] = useState<'cash' | 'check'>('cash');
  const dueNow = Math.max(0, sp.deposit_due_cents - payload.deposit_paid_cents);
  const [amountText, setAmountText] = useState('');
  const [checkNumber, setCheckNumber] = useState('');
  const [checkBank, setCheckBank] = useState('');
  const requestId = useRef(newRequestId());
  const [offerUrl, setOfferUrl] = useState<string | null>(null);

  const canSubmit = consent && sig !== null && (email.trim() !== '' || phone.trim() !== '') && !busy;

  const summary = useMemo(
    () => `${entry.option.name} — ${moneyExact(entry.totalCents)} total${depositCents > 0 ? `, ${moneyExact(depositCents)} deposit` : ''}`,
    [entry, depositCents]
  );

  if (!open) return null;

  async function closeSale() {
    if (!sig) return;
    setBusy(true);
    setError(null);
    try {
      // The signature covers THIS option + total, so it is always captured in this session (never reused from an earlier one).
      let current = reqRef.current && reqRef.current.key === signKey ? reqRef.current : null;
      if (!current) {
        const req = await createInHomeSignatureRequest({
          quoteId: payload.quote.id,
          customerId: sp.customer_id,
          customerName: payload.quote.customer_name,
          email,
          phone,
          title: `Estimate for ${payload.quote.customer_name}`,
          summary,
        });
        current = { key: signKey, req };
        reqRef.current = current;
      }
      if (signed?.key !== signKey) {
        await submitInHomeSignature(current.req, { type: sig.type, data: sig.data, typedFont: sig.typedFont }, payload.quote.customer_name);
        setSigned(current);
      }
      const signatureRequestId = current.req.requestId;
      await closeSalesWon({ id: sp.id, optionId: entry.option.id, signatureRequestId, depositCents, financingTermMonths: termMonths });
      await onChanged();
      toast('Sale closed — signed and saved.', 'success');
    } catch (e) {
      setError(salesErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function takeDeposit() {
    const cents = parseMoneyToCents(amountText || String(dueNow / 100));
    if (cents === null) return setError('Enter a valid amount.');
    setBusy(true);
    setError(null);
    try {
      await recordSaleDeposit({
        presentationId: sp.id,
        method,
        amountCents: cents,
        clientRequestId: requestId.current,
        checkNumber: method === 'check' ? checkNumber : undefined,
        checkBank: method === 'check' ? checkBank : undefined,
      });
      requestId.current = newRequestId();
      setAmountText('');
      await onChanged();
      toast('Deposit recorded.', 'success');
    } catch (e) {
      setError(salesErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendFinancing() {
    if (!sp.install_job_id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createFinancingOffer({
        job_id: sp.install_job_id,
        customer_email: email.trim() || undefined,
        customer_phone: phone.trim() || undefined,
      });
      setOfferUrl(res.application_url);
    } catch {
      setError('Could not create the financing application. You can send it later from the Financing Center.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={sold ? 'Sale closed' : 'Sign and close the sale'}>
      <div ref={trapRef} className="max-h-[94vh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-border bg-bg-primary p-5 sm:rounded-3xl sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-text-primary">
              {sold ? <CheckCircle2 className="text-success-500" size={20} aria-hidden="true" /> : <FileSignature size={20} aria-hidden="true" />}
              {sold ? 'Sale closed' : 'Review & sign'}
            </h2>
            <p className="text-sm text-text-secondary">{sold ? `${moneyExact(sp.sold_total_cents ?? entry.totalCents)} · ${entry.option.name}` : summary}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-full p-2 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
        </div>

        {error && <p role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}

        {!sold && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Customer email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} helperText="Their signed copy is sent here." />
              <Input label="Customer mobile" type="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} helperText="Email or mobile is required." />
            </div>
            <div>
              <p className="mb-1.5 text-sm font-medium text-text-primary">Customer signature</p>
              <SignaturePad defaultName={payload.quote.customer_name} onChange={setSig} />
            </div>
            <label className="flex items-start gap-3 text-sm text-text-primary">
              <input type="checkbox" className="focus-ring mt-1 h-5 w-5 rounded border-border" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{CONSENT}</span>
            </label>
            <Button className="w-full" disabled={!canSubmit} onClick={() => void closeSale()}>
              {busy ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : <FileSignature size={18} aria-hidden="true" />}
              {busy ? 'Saving…' : 'Sign & close sale'}
            </Button>
          </div>
        )}

        {sold && (
          <div className="space-y-5">
            {sp.deposit_due_cents > 0 && (
              <section aria-label="Deposit" className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="mb-3 flex items-center justify-between text-sm">
                  <span className="font-semibold text-text-primary">Deposit {moneyExact(sp.deposit_due_cents)}</span>
                  <span className={dueNow === 0 ? 'font-semibold text-success-500' : 'text-text-secondary'}>
                    {dueNow === 0 ? 'Collected' : `${moneyExact(dueNow)} still due`}
                  </span>
                </div>
                {dueNow > 0 && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Payment method">
                      {([['cash', 'Cash', Banknote], ['check', 'Check', Landmark]] as const).map(([id, label, Icon]) => (
                        <button key={id} type="button" role="radio" aria-checked={method === id} onClick={() => setMethod(id)}
                          className={`focus-ring flex min-h-[48px] items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold ${method === id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
                          <Icon size={16} aria-hidden="true" /> {label}
                        </button>
                      ))}
                    </div>
                    <Input label="Amount" inputMode="decimal" value={amountText} placeholder={(dueNow / 100).toFixed(2)} onChange={(e) => setAmountText(e.target.value)} />
                    {method === 'check' && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Input label="Check number" value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} />
                        <Input label="Bank (optional)" value={checkBank} onChange={(e) => setCheckBank(e.target.value)} />
                      </div>
                    )}
                    <Button className="w-full" disabled={busy} onClick={() => void takeDeposit()}>
                      {busy ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : null} Record deposit
                    </Button>
                    <p className="text-xs text-text-secondary">Card deposits: use Collect Payment on the new job (Tap to Pay).</p>
                  </div>
                )}
              </section>
            )}

            {termMonths !== null && payload.financing.connected && (
              <section aria-label="Financing" className="rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="mb-2 text-sm font-semibold text-text-primary">Financing application</p>
                {offerUrl ? (
                  <div className="flex items-center gap-2">
                    <input readOnly value={offerUrl} aria-label="Financing application link" className="focus-ring min-w-0 flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm" />
                    <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard?.writeText(offerUrl); toast('Link copied.', 'success'); }}><Copy size={14} aria-hidden="true" /> Copy</Button>
                  </div>
                ) : (
                  <Button variant="secondary" className="w-full" disabled={busy} onClick={() => void sendFinancing()}>Send financing application</Button>
                )}
                <p className="mt-2 text-xs text-text-secondary">The lender decides approval and final terms.</p>
              </section>
            )}

            <Button variant="secondary" className="w-full" onClick={onClose}>Done</Button>
          </div>
        )}
      </div>
    </div>
  );
}
