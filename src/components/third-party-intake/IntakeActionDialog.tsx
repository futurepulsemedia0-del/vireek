import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  ACTION_META,
  EMPTY_ACTION_INPUT,
  intakeToEditForm,
  toEditFields,
  validateActionInput,
  validateEditForm,
  type ActionErrors,
  type ActionInput,
  type EditFormValues,
  type IntakeAction,
  type ThirdPartyWorkOrder,
} from '@/lib/thirdPartyIntake';

interface Props {
  row: ThirdPartyWorkOrder | null;
  action: IntakeAction | null;
  busy: boolean;
  serverError: string | null;
  onCancel: () => void;
  onSubmit: (action: IntakeAction, payload: { input: ActionInput } | { fields: Record<string, string> }) => void;
}

/** Bottom sheet on phones, centred dialog from `sm` up. Remount (key) per request+action to reset fields. */
export function IntakeActionDialog({ row, action, busy, serverError, onCancel, onSubmit }: Props) {
  const open = Boolean(row && action);
  const ref = useFocusTrap(open);
  useEscapeToClose(open, onCancel);

  return (
    <AnimatePresence>
      {open && row && action && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={busy ? undefined : onCancel}
            className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            ref={ref}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="intake-action-title"
            initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-0 bottom-0 z-[120] max-h-[92vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-6"
          >
            <DialogBody key={`${row.id}:${action}`} row={row} action={action} busy={busy} serverError={serverError} onCancel={onCancel} onSubmit={onSubmit} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function DialogBody({ row, action, busy, serverError, onCancel, onSubmit }: Omit<Props, 'row' | 'action'> & { row: ThirdPartyWorkOrder; action: IntakeAction }) {
  const meta = ACTION_META[action];
  const [input, setInput] = useState<ActionInput>(EMPTY_ACTION_INPUT);
  const [errors, setErrors] = useState<ActionErrors>({});
  const [edit, setEdit] = useState<EditFormValues>(() => intakeToEditForm(row));
  const [editErrors, setEditErrors] = useState<Partial<Record<keyof EditFormValues, string>>>({});
  const set = <K extends keyof ActionInput>(k: K, v: string) => setInput((p) => ({ ...p, [k]: v }));
  const setE = <K extends keyof EditFormValues>(k: K, v: string) => setEdit((p) => ({ ...p, [k]: v }));

  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (busy) return;
    if (action === 'edit') {
      const errs = validateEditForm(edit);
      setEditErrors(errs);
      if (Object.keys(errs).length) return;
      onSubmit(action, { fields: toEditFields(edit) });
      return;
    }
    const errs = validateActionInput(action, input);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onSubmit(action, { input });
  };

  return (
    <form onSubmit={submit} noValidate>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="intake-action-title" className="text-base font-semibold text-text-primary">{meta.title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">{meta.description}</p>
        </div>
        <button type="button" onClick={onCancel} disabled={busy} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-4 space-y-3">
        {action === 'edit' ? (
          <>
            <Input label="Title" required value={edit.title} error={editErrors.title} onChange={(e) => setE('title', e.target.value)} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Partner reference" value={edit.external_ref} onChange={(e) => setE('external_ref', e.target.value)} />
              <Input label="Policy number" value={edit.policy_number} onChange={(e) => setE('policy_number', e.target.value)} />
              <Input label="Customer name" value={edit.customer_name} onChange={(e) => setE('customer_name', e.target.value)} />
              <Input label="Customer phone" type="tel" inputMode="tel" value={edit.customer_phone} error={editErrors.customer_phone} onChange={(e) => setE('customer_phone', e.target.value)} />
              <Input label="Customer email" type="email" value={edit.customer_email} error={editErrors.customer_email} onChange={(e) => setE('customer_email', e.target.value)} />
              <Input label="Service type" value={edit.service_type} onChange={(e) => setE('service_type', e.target.value)} />
            </div>
            <Input label="Service address" value={edit.service_address} onChange={(e) => setE('service_address', e.target.value)} />
            <Input label="Not-to-exceed (USD)" inputMode="decimal" value={edit.nte} error={editErrors.nte} onChange={(e) => setE('nte', e.target.value)} />
          </>
        ) : (
          <>
            {meta.amount && (
              <Input
                label={action === 'quote' ? 'Quoted amount (USD)' : 'Authorized amount (USD)'}
                required={meta.amount === 'required'}
                inputMode="decimal"
                placeholder={row.nte_cents !== null ? (row.nte_cents / 100).toFixed(2) : '0.00'}
                value={input.amount}
                error={errors.amount}
                helperText={meta.amount === 'optional' ? 'Leave blank to use the partner’s not-to-exceed.' : undefined}
                onChange={(e) => set('amount', e.target.value)}
              />
            )}
            {meta.reference && (
              <Input label="Authorization number (optional)" value={input.reference} error={errors.reference} onChange={(e) => set('reference', e.target.value)} />
            )}
            {meta.when && (
              <Input label="Visit date and time" type="datetime-local" required value={input.when} error={errors.when} onChange={(e) => set('when', e.target.value)} />
            )}
            {meta.note !== 'none' && (
              <Textarea
                label={meta.noteLabel}
                required={meta.note === 'required'}
                rows={3}
                maxLength={2000}
                value={input.note}
                error={errors.note}
                onChange={(e) => set('note', e.target.value)}
              />
            )}
          </>
        )}
      </div>

      {serverError && (
        <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{serverError}</p>
      )}

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={busy}>Back</Button>
        <Button
          type="submit"
          size="sm"
          disabled={busy}
          className={meta.tone === 'danger' ? '!bg-danger' : ''}
        >
          {busy ? 'Saving…' : meta.confirmLabel}
        </Button>
      </div>
    </form>
  );
}
