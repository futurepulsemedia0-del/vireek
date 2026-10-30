import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Zap, X, Loader as Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { useToast } from '@/contexts/ToastContext';
import {
  InstantPayoutError,
  describeFeeSchedule,
  dollarsToCents,
  formatMoney,
  newIdempotencyKey,
  quoteInstantPayoutFee,
  requestInstantPayout,
  validateInstantPayoutAmount,
  type InstantPayoutEligibility,
} from '@/lib/instantPayouts';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

// Payouts at or above this amount require typing a phrase before they are sent.
const TYPE_TO_CONFIRM_CENTS = 500_000;
const CONFIRM_PHRASE = 'instant payout';

interface Props {
  eligibility: InstantPayoutEligibility;
  onClose: () => void;
  /** `refresh` = the server state changed (or may have), so the card should reload. */
  onDone: (refresh: boolean) => void;
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className={strong ? 'text-sm font-semibold text-text-primary' : 'text-sm text-text-secondary'}>{label}</dt>
      <dd className={strong ? 'text-base font-bold text-text-primary' : 'text-sm font-medium text-text-primary'}>{value}</dd>
    </div>
  );
}

export function InstantPayoutDialog({ eligibility, onClose, onDone }: Props) {
  const { toast } = useToast();
  const { pricing, destination, maxPayoutCents } = eligibility;
  const [mode, setMode] = useState<'full' | 'custom'>('full');
  const [amountText, setAmountText] = useState('');
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [touched, setTouched] = useState(false);
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // One key per attempt: re-sending after a dropped connection replays the same payout instead of creating a second one.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const dialogRef = useFocusTrap(true);
  useEscapeToClose(!submitting, onClose);

  const amountCents = mode === 'full' ? maxPayoutCents : dollarsToCents(amountText);
  const amountError = mode === 'custom' ? validateInstantPayoutAmount(amountCents, pricing, maxPayoutCents) : null;
  const feeCents = useMemo(() => (amountCents !== null && !amountError ? quoteInstantPayoutFee(amountCents, pricing) : 0), [amountCents, amountError, pricing]);
  const canReview = amountCents !== null && !amountError && destination !== null;
  const needsPhrase = amountCents !== null && amountCents >= TYPE_TO_CONFIRM_CENTS;
  const phraseOk = !needsPhrase || typed.trim().toLowerCase() === CONFIRM_PHRASE;

  async function handleConfirm() {
    if (!canReview || amountCents === null || submitting || !phraseOk) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const outcome = await requestInstantPayout({ amountCents, expectedFeeCents: feeCents, idempotencyKey });
      if (outcome.warning === 'status_unknown') {
        toast(outcome.message ?? 'Stripe has not confirmed this payout yet — check Recent payouts shortly.', 'error');
      } else {
        const fee = outcome.payout.fee_cents;
        toast(`${formatMoney(outcome.payout.amount_cents)} is on its way${fee > 0 ? ` (fee ${formatMoney(fee)})` : ''}`, 'success');
      }
      onDone(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start the payout';
      setServerError(message);
      // A definite server answer ends this attempt; a dropped connection keeps the key so a retry is safe.
      if (err instanceof InstantPayoutError && err.status) setIdempotencyKey(newIdempotencyKey());
      // Quote/balance moved under the user: go back, reload, and let them review the new numbers.
      if (err instanceof InstantPayoutError && (err.code === 'quote_changed' || err.code === 'amount_exceeds_balance')) {
        toast(message, 'error');
        onDone(true);
        return;
      }
      setStep('form');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => !submitting && onClose()}
        className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm"
      />
      <motion.div
        key="dialog"
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="instant-payout-title"
        className="fixed left-1/2 top-1/2 z-[105] max-h-[90vh] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:p-6 dark:shadow-card-hover-dark"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Zap size={20} />
            </span>
            <div>
              <h2 id="instant-payout-title" className="text-base font-semibold text-text-primary">
                {step === 'form' ? 'Instant payout' : 'Confirm instant payout'}
              </h2>
              <p className="text-xs text-text-secondary">{formatMoney(eligibility.availableCents)} available in Stripe</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        {serverError && (
          <p role="alert" className="mt-4 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">
            {serverError}
          </p>
        )}

        {step === 'form' ? (
          <>
            <fieldset className="mt-5">
              <legend className="mb-1.5 text-xs font-medium text-text-secondary">Amount</legend>
              <div className="flex flex-col gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                  <input type="radio" name="instant-payout-mode" checked={mode === 'full'} onChange={() => setMode('full')} />
                  Everything available ({formatMoney(maxPayoutCents)})
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                  <input type="radio" name="instant-payout-mode" checked={mode === 'custom'} onChange={() => setMode('custom')} />
                  Custom amount
                </label>
              </div>
              {mode === 'custom' && (
                <div className="mt-2">
                  <input
                    inputMode="decimal"
                    autoFocus
                    className={inputClass}
                    placeholder="0.00"
                    aria-label="Payout amount"
                    aria-invalid={touched && Boolean(amountError)}
                    value={amountText}
                    onChange={(e) => setAmountText(e.target.value)}
                  />
                  {(touched || amountText) && amountError && <p className="mt-1 text-xs text-danger">{amountError}</p>}
                </div>
              )}
            </fieldset>

            <dl className="mt-4 divide-y divide-border rounded-xl border border-border bg-bg-primary px-4 py-2">
              <Row label="To your bank / card" value={amountCents !== null && !amountError ? formatMoney(amountCents) : '—'} />
              <Row label={`Instant fee · ${describeFeeSchedule(pricing)}`} value={amountCents !== null && !amountError ? (feeCents > 0 ? formatMoney(feeCents) : 'Free') : '—'} />
              <Row label="Taken from your balance" value={amountCents !== null && !amountError ? formatMoney(amountCents + feeCents) : '—'} strong />
            </dl>
            <p className="mt-2 text-xs text-text-secondary">
              To {destination?.label ?? 'your account'} · typically arrives within 30 minutes, any day, any time.
            </p>

            <div className="mt-6 flex gap-3">
              <Button variant="secondary" size="sm" className="flex-1" onClick={onClose}>Cancel</Button>
              <Button
                variant="primary"
                size="sm"
                className="flex-1"
                onClick={() => {
                  setTouched(true);
                  if (canReview) {
                    setServerError(null);
                    setStep('review');
                  }
                }}
              >
                Review payout
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-5 text-sm leading-relaxed text-text-secondary">
              You are about to send <span className="font-semibold text-text-primary">{amountCents !== null ? formatMoney(amountCents) : ''}</span> to{' '}
              <span className="font-semibold text-text-primary">{destination?.label}</span>. Instant payouts can&apos;t be canceled once sent.
            </p>
            <dl className="mt-4 divide-y divide-border rounded-xl border border-border bg-bg-primary px-4 py-2">
              <Row label="To your bank / card" value={amountCents !== null ? formatMoney(amountCents) : '—'} />
              <Row label="Instant fee" value={feeCents > 0 ? formatMoney(feeCents) : 'Free'} />
              <Row label="Taken from your balance" value={amountCents !== null ? formatMoney(amountCents + feeCents) : '—'} strong />
            </dl>

            {needsPhrase && (
              <div className="mt-4">
                <label htmlFor="instant-payout-phrase" className="mb-1.5 block text-xs font-medium text-text-secondary">
                  Type &quot;{CONFIRM_PHRASE}&quot; to confirm
                </label>
                <input id="instant-payout-phrase" autoFocus className={inputClass} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={CONFIRM_PHRASE} />
              </div>
            )}

            <div className="mt-6 flex gap-3">
              <Button variant="secondary" size="sm" className="flex-1" onClick={() => setStep('form')} disabled={submitting}>Back</Button>
              <Button variant="primary" size="sm" className="flex-1" onClick={handleConfirm} disabled={submitting || !phraseOk}>
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {submitting ? 'Sending…' : 'Confirm instant payout'}
              </Button>
            </div>
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
