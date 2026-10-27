import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Plus, Trash2, X } from 'lucide-react';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { formatCents } from '@/lib/invoices';
import { PAYMENT_METHOD_LABELS, parseMoneyInput, type PaymentMethod } from '@/lib/invoiceDetail';
import {
  MAX_SPLIT_PAYERS,
  MIN_SPLIT_PAYERS,
  SHARE_TYPE_LABELS,
  SPLIT_PRESETS,
  SPLIT_ROLE_LABELS,
  allocateSplit,
  draftFromPayers,
  newDraftRow,
  rowsFromPreset,
  validateSplitDraft,
  type PayerStanding,
  type ShareType,
  type SplitDraftRow,
  type SplitPayer,
  type SplitPayerInput,
  type SplitRole,
} from '@/lib/invoiceSplit';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent disabled:opacity-50';

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function SplitModal({ title, description, onClose, wide, children }: { title: string; description: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} onClick={onClose} className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" />
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed inset-x-3 bottom-3 z-[120] max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:-translate-x-1/2 sm:-translate-y-1/2 sm:p-6 dark:shadow-card-hover-dark ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}`}
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

function Footer({ onClose, submitting, submitLabel, danger, disabled }: { onClose: () => void; submitting: boolean; submitLabel: string; danger?: boolean; disabled?: boolean }) {
  return (
    <div className="mt-5 flex gap-3">
      <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button type="submit" size="sm" className={`flex-1 ${danger ? '!bg-danger' : ''}`} disabled={submitting || disabled}>
        {submitting ? 'Saving…' : submitLabel}
      </Button>
    </div>
  );
}

// ─── Split editor ───────────────────────────────────────────────────────────
export function SplitPlanDialog({
  totalCents,
  payers,
  standings,
  onClose,
  onSubmit,
}: {
  totalCents: number;
  payers: SplitPayer[];
  standings: PayerStanding[];
  onClose: () => void;
  onSubmit: (payload: SplitPayerInput[]) => Promise<void>;
}) {
  const editing = payers.length > 0;
  const [rows, setRows] = useState<SplitDraftRow[] | null>(() => (editing ? draftFromPayers(payers) : null));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Payers who already paid cannot be removed (the database enforces this too).
  const locked = useMemo(() => new Set(standings.filter((s) => s.paidCents > 0).map((s) => s.payer.id)), [standings]);
  const allocation = useMemo(() => (rows ? allocateSplit(totalCents, rows) : null), [rows, totalCents]);

  useEffect(() => { setError(null); }, [rows]);

  const patch = (key: string, p: Partial<SplitDraftRow>) => setRows((r) => (r ?? []).map((x) => (x.key === key ? { ...x, ...p } : x)));

  if (!rows) {
    return (
      <SplitModal title="Split this invoice" description={`Invoice total ${formatCents(totalCents)}. Pick a starting point — you can change everything next.`} onClose={onClose}>
        <ul className="space-y-2">
          {SPLIT_PRESETS.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setRows(rowsFromPreset(p.id))}
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary p-3 text-left transition-colors hover:border-accent/40 hover:bg-bg-tertiary"
              >
                <span className="block text-sm font-semibold text-text-primary">{p.label}</span>
                <span className="block text-xs text-text-secondary">{p.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </SplitModal>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = validateSplitDraft(rows, totalCents);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(result.payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the split.');
      setSubmitting(false);
    }
  };

  return (
    <SplitModal
      wide
      title={editing ? 'Edit split' : 'Set up split'}
      description="Each payer gets their own secure link to pay their share. The shares must add up to the invoice total."
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-3">
        <ul className="space-y-3">
          {rows.map((r, i) => {
            const isLocked = !!r.id && locked.has(r.id);
            const amount = allocation?.ok ? allocation.amounts[i] : null;
            return (
              <li key={r.key} className="rounded-xl border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase text-text-secondary">Payer {i + 1}</p>
                  <button
                    type="button"
                    onClick={() => setRows((cur) => (cur ?? []).filter((x) => x.key !== r.key))}
                    disabled={rows.length <= MIN_SPLIT_PAYERS || isLocked}
                    title={isLocked ? 'This payer has already paid and cannot be removed' : undefined}
                    aria-label={`Remove payer ${i + 1}`}
                    className="focus-ring rounded-lg p-1 text-text-secondary hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                  <div>
                    <label htmlFor={`role-${r.key}`} className="mb-1.5 block text-sm font-medium text-text-primary">Role</label>
                    <select id={`role-${r.key}`} value={r.role} onChange={(e) => patch(r.key, { role: e.target.value as SplitRole })} className={selectClass}>
                      {(Object.keys(SPLIT_ROLE_LABELS) as SplitRole[]).map((k) => <option key={k} value={k}>{SPLIT_ROLE_LABELS[k]}</option>)}
                    </select>
                  </div>
                  <Input label="Name" value={r.name} maxLength={120} onChange={(e) => patch(r.key, { name: e.target.value })} />
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Input label="Email (optional)" type="email" value={r.email} maxLength={254} onChange={(e) => patch(r.key, { email: e.target.value })} />
                  <Input label="Phone (optional)" type="tel" value={r.phone} maxLength={40} onChange={(e) => patch(r.key, { phone: e.target.value })} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
                  <div>
                    <label htmlFor={`type-${r.key}`} className="mb-1.5 block text-sm font-medium text-text-primary">Share</label>
                    <select id={`type-${r.key}`} value={r.shareType} onChange={(e) => patch(r.key, { shareType: e.target.value as ShareType, shareValue: '' })} className={selectClass}>
                      {(Object.keys(SHARE_TYPE_LABELS) as ShareType[]).map((k) => <option key={k} value={k}>{SHARE_TYPE_LABELS[k]}</option>)}
                    </select>
                  </div>
                  {r.shareType === 'remainder' ? (
                    <p className="self-end pb-3 text-sm text-text-secondary">Whatever is left</p>
                  ) : (
                    <Input
                      label={r.shareType === 'percent' ? 'Percent (%)' : 'Amount ($)'}
                      inputMode="decimal"
                      value={r.shareValue}
                      onChange={(e) => patch(r.key, { shareValue: e.target.value })}
                    />
                  )}
                  <p className="col-span-2 pb-3 text-right text-base font-semibold tabular-nums text-text-primary sm:col-span-1" aria-label={`Payer ${i + 1} owes`}>
                    {amount !== null ? formatCents(amount) : '—'}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={rows.length >= MAX_SPLIT_PAYERS} onClick={() => setRows((cur) => [...(cur ?? []), newDraftRow()])}>
            <Plus size={14} /> Add payer
          </Button>
          <p className="text-sm text-text-secondary">
            Invoice total <span className="font-semibold tabular-nums text-text-primary">{formatCents(totalCents)}</span>
          </p>
        </div>

        {allocation && !allocation.ok && <p className="rounded-xl bg-warning-500/10 px-3 py-2 text-xs text-warning-500">{allocation.error}</p>}
        {allocation?.ok && <p className="rounded-xl bg-success-500/10 px-3 py-2 text-xs text-success-500">Shares add up to the invoice total.</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Footer onClose={onClose} submitting={submitting} submitLabel="Save split" />
      </form>
    </SplitModal>
  );
}

// ─── Record a payment for one payer ─────────────────────────────────────────
export function RecordSplitPaymentDialog({
  payerName,
  remainingCents,
  balanceCents,
  onClose,
  onSubmit,
}: {
  payerName: string;
  remainingCents: number;
  balanceCents: number;
  onClose: () => void;
  onSubmit: (v: { amountCents: number; method: PaymentMethod; reference: string; note: string; paidAt?: string }) => Promise<void>;
}) {
  const [amount, setAmount] = useState((Math.min(remainingCents, balanceCents) / 100).toFixed(2));
  const [method, setMethod] = useState<PaymentMethod>('check');
  const [date, setDate] = useState(todayLocal());
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const parsed = parseMoneyInput(amount, balanceCents);
  const overShare = parsed.ok && parsed.cents > remainingCents;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
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
    <SplitModal title={`Record payment from ${payerName}`} description={`${payerName} still owes ${formatCents(remainingCents)}. Invoice balance is ${formatCents(balanceCents)}.`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Input
          label="Amount ($)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          helperText={overShare ? `More than ${payerName}’s remaining share. Update the split afterwards to rebalance.` : undefined}
          autoFocus
          required
        />
        <div>
          <label htmlFor="split-pay-method" className="mb-1.5 block text-sm font-medium text-text-primary">Method</label>
          <select id="split-pay-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={selectClass}>
            {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
          </select>
        </div>
        <Input label="Date received" type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} required />
        <Input label="Reference (optional)" placeholder="Check #, claim #, transaction ID…" value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
        <Textarea label="Note (optional)" rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Footer onClose={onClose} submitting={submitting} submitLabel="Record payment" />
      </form>
    </SplitModal>
  );
}

// ─── Remove the split ───────────────────────────────────────────────────────
export function RemoveSplitDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the split.');
      setSubmitting(false);
    }
  };

  return (
    <SplitModal title="Remove the split?" description="Every payer link stops working and the invoice goes back to a single payer. Nothing has been collected through the split yet." onClose={onClose}>
      <form onSubmit={submit}>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Footer onClose={onClose} submitting={submitting} submitLabel="Remove split" danger />
      </form>
    </SplitModal>
  );
}
