import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Undo2, X } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { useToast } from '@/contexts/ToastContext';
import {
  REASON_CODES,
  REASON_META,
  RefundError,
  dollarsToCents,
  formatMoney,
  issueRefund,
  newIdempotencyKey,
  validateRefundAmount,
  type ReasonCode,
  type RefundablePayment,
} from '@/lib/refunds';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

// Refunds at or above this amount require typing a phrase before they are sent.
const TYPE_TO_CONFIRM_CENTS = 50_000;

interface Props {
  payment: RefundablePayment;
  onClose: () => void;
  onDone: () => void;
}

export function RefundDialog({ payment, onClose, onDone }: Props) {
  const { toast } = useToast();
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState<ReasonCode>('quality_issue');
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [touched, setTouched] = useState(false);
  // One key per attempt: re-sending after a dropped connection replays the same refund instead of creating a second one.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const dialogRef = useFocusTrap(step === 'form');
  useEscapeToClose(step === 'form', onClose);

  const canNotify = Boolean(payment.customer_email || payment.customer_phone);
  const amountCents = mode === 'full' ? payment.refundable_cents : dollarsToCents(amountText);
  const amountError = mode === 'partial' ? validateRefundAmount(amountCents, payment.refundable_cents, payment.currency) : null;
  const noteError = reason === 'other' && !note.trim() ? 'Add a short note when the reason is “Other”.' : null;
  const canReview = amountCents !== null && !amountError && !noteError;
  const money = (cents: number) => formatMoney(cents, payment.currency);

  async function handleConfirm() {
    if (amountCents === null) return;
    try {
      const outcome = await issueRefund({
        paymentRequestId: payment.payment_request_id,
        amountCents,
        reasonCode: reason,
        reasonNote: note.trim() || null,
        notifyCustomer: notify && canNotify,
        idempotencyKey,
      });
      if (outcome.warning === 'status_unknown') {
        toast(outcome.message ?? 'Stripe has not confirmed this refund yet — check History shortly.', 'error');
      } else if (outcome.warning === 'accounting_pending') {
        toast('Refund sent to Stripe, but the ledger entry needs a retry — open History and press Resume.', 'error');
      } else {
        toast(`Refund of ${money(amountCents)} issued`, 'success');
      }
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not issue the refund', 'error');
      // A definite server answer means this attempt is over; a dropped connection keeps the key so a retry is safe.
      if (err instanceof RefundError && err.status) setIdempotencyKey(newIdempotencyKey());
      setStep('form');
    }
  }

  return (
    <>
      <AnimatePresence>
        {step === 'form' && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={onClose}
              className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              ref={dialogRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-labelledby="refund-dialog-title"
              className="fixed left-1/2 top-1/2 z-[105] max-h-[90vh] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:p-6 dark:shadow-card-hover-dark"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Undo2 size={20} />
                  </span>
                  <div>
                    <h2 id="refund-dialog-title" className="text-base font-semibold text-text-primary">Refund {payment.customer_name}</h2>
                    <p className="text-xs text-text-secondary">
                      Paid {money(payment.amount_cents)} · {money(payment.refundable_cents)} refundable
                    </p>
                  </div>
                </div>
                <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
                  <X size={18} />
                </button>
              </div>

              <div className="mt-5 space-y-4">
                <fieldset>
                  <legend className="mb-1.5 text-xs font-medium text-text-secondary">Amount</legend>
                  <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                      <input type="radio" name="refund-mode" checked={mode === 'full'} onChange={() => setMode('full')} />
                      Full refund ({money(payment.refundable_cents)})
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                      <input type="radio" name="refund-mode" checked={mode === 'partial'} onChange={() => setMode('partial')} />
                      Partial refund
                    </label>
                  </div>
                  {mode === 'partial' && (
                    <div className="mt-2">
                      <input
                        inputMode="decimal"
                        autoFocus
                        className={inputClass}
                        placeholder="0.00"
                        aria-label="Refund amount"
                        aria-invalid={touched && Boolean(amountError)}
                        value={amountText}
                        onChange={(e) => setAmountText(e.target.value)}
                      />
                      {(touched || amountText) && amountError && <p className="mt-1 text-xs text-danger">{amountError}</p>}
                    </div>
                  )}
                </fieldset>

                <div>
                  <label htmlFor="refund-reason" className="mb-1.5 block text-xs font-medium text-text-secondary">Reason</label>
                  <select id="refund-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value as ReasonCode)}>
                    {REASON_CODES.map((code) => (
                      <option key={code} value={code}>{REASON_META[code].label}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-text-secondary">{REASON_META[reason].hint}</p>
                </div>

                <div>
                  <label htmlFor="refund-note" className="mb-1.5 block text-xs font-medium text-text-secondary">
                    Internal note {reason === 'other' ? '(required)' : '(optional)'}
                  </label>
                  <textarea
                    id="refund-note"
                    rows={2}
                    maxLength={500}
                    className={inputClass}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    aria-invalid={touched && Boolean(noteError)}
                  />
                  {touched && noteError && <p className="mt-1 text-xs text-danger">{noteError}</p>}
                </div>

                <label className={`flex items-start gap-2 text-sm ${canNotify ? 'cursor-pointer text-text-primary' : 'text-text-secondary'}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={!canNotify}
                    checked={notify && canNotify}
                    onChange={(e) => setNotify(e.target.checked)}
                  />
                  <span>
                    Notify the customer
                    <span className="block text-xs text-text-secondary">
                      {canNotify
                        ? [payment.customer_email, payment.customer_phone].filter(Boolean).join(' · ')
                        : 'No email or phone on file for this payment.'}
                    </span>
                  </span>
                </label>
              </div>

              <div className="mt-6 flex gap-3">
                <Button variant="secondary" size="sm" className="flex-1" onClick={onClose}>Cancel</Button>
                <Button
                  variant="primary"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setTouched(true);
                    if (canReview) setStep('confirm');
                  }}
                >
                  Review refund
                </Button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={step === 'confirm'}
        title={`Refund ${amountCents !== null ? money(amountCents) : ''} to ${payment.customer_name}?`}
        description="The money returns to the customer's original payment method and is pulled back from your connected Stripe balance. A credit memo and ledger entry are created automatically. This cannot be undone."
        confirmPhrase={amountCents !== null && amountCents >= TYPE_TO_CONFIRM_CENTS ? 'refund' : undefined}
        confirmLabel="Yes, issue refund"
        onConfirm={handleConfirm}
        onCancel={() => setStep('form')}
      />
    </>
  );
}
