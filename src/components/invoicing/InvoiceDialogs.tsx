import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { formatCents } from '@/lib/invoices';
import {
  PAYMENT_METHOD_LABELS,
  parseMoneyInput,
  refundableForPayment,
  type InvoicePayment,
  type InvoiceRefund,
  type PaymentMethod,
} from '@/lib/invoiceDetail';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent disabled:opacity-50';

function ModalShell({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm"
      />
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-x-3 bottom-3 z-[120] max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:p-6 dark:shadow-card-hover-dark"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">{description}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </motion.div>
    </>
  );
}

function Footer({ onClose, submitting, submitLabel, danger }: { onClose: () => void; submitting: boolean; submitLabel: string; danger?: boolean }) {
  return (
    <div className="mt-5 flex gap-3">
      <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button type="submit" size="sm" className={`flex-1 ${danger ? '!bg-danger' : ''}`} disabled={submitting}>
        {submitting ? 'Saving…' : submitLabel}
      </Button>
    </div>
  );
}

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ─── Record payment ─────────────────────────────────────────────────────────
export function RecordPaymentDialog({
  balanceCents,
  onClose,
  onSubmit,
}: {
  balanceCents: number;
  onClose: () => void;
  onSubmit: (v: { amountCents: number; method: PaymentMethod; reference: string; note: string; paidAt?: string }) => Promise<void>;
}) {
  const [amount, setAmount] = useState((balanceCents / 100).toFixed(2));
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [date, setDate] = useState(todayLocal());
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseMoneyInput(amount, balanceCents);
    if (!parsed.ok) { setError(parsed.error); return; }
    if (!date || date > todayLocal()) { setError('Choose today or an earlier date.'); return; }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        amountCents: parsed.cents,
        method,
        reference,
        note,
        paidAt: date === todayLocal() ? undefined : new Date(`${date}T12:00:00`).toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the payment.');
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="Record payment" description={`Balance due ${formatCents(balanceCents)}. Partial payments are fine.`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Input label="Amount ($)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus required />
        <div>
          <label htmlFor="pay-method" className="mb-1.5 block text-sm font-medium text-text-primary">Method</label>
          <select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={selectClass}>
            {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => (
              <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
            ))}
          </select>
        </div>
        <Input label="Date received" type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} required />
        <Input label="Reference (optional)" placeholder="Check #, transaction ID…" value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
        <Textarea label="Note (optional)" rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Footer onClose={onClose} submitting={submitting} submitLabel="Record payment" />
      </form>
    </ModalShell>
  );
}

// ─── Refund ─────────────────────────────────────────────────────────────────
export function RefundDialog({
  payments,
  refunds,
  initialPaymentId,
  onClose,
  onSubmit,
}: {
  payments: InvoicePayment[];
  refunds: InvoiceRefund[];
  initialPaymentId?: string;
  onClose: () => void;
  onSubmit: (v: { paymentId: string; amountCents: number; reason: string }) => Promise<void>;
}) {
  const refundable = useMemo(
    () => payments.map((p) => ({ payment: p, left: refundableForPayment(p, refunds) })).filter((x) => x.left > 0),
    [payments, refunds],
  );
  const [paymentId, setPaymentId] = useState(initialPaymentId && refundable.some((x) => x.payment.id === initialPaymentId) ? initialPaymentId : (refundable[0]?.payment.id ?? ''));
  const left = refundable.find((x) => x.payment.id === paymentId)?.left ?? 0;
  const [amount, setAmount] = useState((left / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { setAmount((left / 100).toFixed(2)); }, [left, paymentId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!paymentId) { setError('Choose a payment to refund.'); return; }
    const parsed = parseMoneyInput(amount, left);
    if (!parsed.ok) { setError(parsed.error); return; }
    if (!reason.trim()) { setError('Add a reason — it is kept in the audit trail.'); return; }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ paymentId, amountCents: parsed.cents, reason });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the refund.');
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      title="Record refund"
      description="Logs a refund you have already sent to the customer (cash, check, card terminal, etc.). Vireek does not move money."
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="refund-payment" className="mb-1.5 block text-sm font-medium text-text-primary">Payment</label>
          <select id="refund-payment" value={paymentId} onChange={(e) => setPaymentId(e.target.value)} className={selectClass}>
            {refundable.map(({ payment, left: l }) => (
              <option key={payment.id} value={payment.id}>
                {new Date(payment.paid_at).toLocaleDateString()} · {PAYMENT_METHOD_LABELS[payment.method]} · {formatCents(l)} refundable
              </option>
            ))}
          </select>
        </div>
        <Input label="Amount ($)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} helperText={`Up to ${formatCents(left)}`} required />
        <Textarea label="Reason" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} required />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Footer onClose={onClose} submitting={submitting} submitLabel="Record refund" danger />
      </form>
    </ModalShell>
  );
}

// ─── Void ───────────────────────────────────────────────────────────────────
export function VoidDialog({ invoiceNumber, onClose, onSubmit }: { invoiceNumber: string; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) { setError('A reason is required.'); return; }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(reason);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not void the invoice.');
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Void ${invoiceNumber}?`} description="A voided invoice can no longer be paid or sent, and its public link stops working. This cannot be undone." onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Textarea label="Reason" rows={3} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus required />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Footer onClose={onClose} submitting={submitting} submitLabel="Void invoice" danger />
      </form>
    </ModalShell>
  );
}
