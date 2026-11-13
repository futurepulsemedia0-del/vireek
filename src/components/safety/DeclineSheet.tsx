// Recreated: verify against original intent
import { useRef, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { requestDecline } from '@/lib/siteSafety';

interface Props {
  jobId: string;
  onClose: () => void;
  onDone?: () => void;
}

const REASONS: { value: 'felt_unsafe' | 'precaution_not_met' | 'hazard_found' | 'other'; label: string }[] = [
  { value: 'felt_unsafe', label: 'I do not feel safe' },
  { value: 'precaution_not_met', label: 'A required precaution is not in place' },
  { value: 'hazard_found', label: 'I found a hazard on site' },
  { value: 'other', label: 'Other' },
];

/** Decline or reschedule an unsafe job. There is never a penalty for using this; the text says so. */
export function DeclineSheet({ jobId, onClose, onDone }: Props) {
  const { toast } = useToast();
  const [action, setAction] = useState<'decline' | 'reschedule'>('reschedule');
  const [reason, setReason] = useState<(typeof REASONS)[number]['value']>('felt_unsafe');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const submit = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const res = await requestDecline(jobId, action, reason, note.trim() || undefined);
      toast(res.existing ? 'Your request was already sent to the dispatcher.' : 'Sent to your dispatcher. No penalty applies.', 'success');
      onDone?.();
      onClose();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not send the request. Try again.', 'error');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <section role="dialog" aria-modal="false" aria-labelledby="decline-title" className="rounded-xl border border-border bg-bg-secondary p-4">
      <h3 id="decline-title" className="text-sm font-semibold text-text-primary">Decline or reschedule this job</h3>
      <p className="mt-1 text-xs text-text-secondary">There is no penalty for declining or rescheduling work you believe is unsafe. Your dispatcher is told straight away.</p>

      <fieldset className="mt-3">
        <legend className="text-xs font-semibold text-text-secondary">What do you need?</legend>
        <div className="mt-1 flex gap-4">
          {(['reschedule', 'decline'] as const).map((a) => (
            <label key={a} className="flex items-center gap-1.5 text-sm text-text-primary">
              <input type="radio" name="decline-action" checked={action === a} onChange={() => setAction(a)} />
              {a === 'reschedule' ? 'Reschedule' : 'Decline'}
            </label>
          ))}
        </div>
      </fieldset>

      <label htmlFor="decline-reason" className="mt-3 block text-xs font-semibold text-text-secondary">Reason</label>
      <select id="decline-reason" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} className="focus-ring mt-1 min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary">
        {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>

      <label htmlFor="decline-note" className="mt-3 block text-xs font-semibold text-text-secondary">Note (optional)</label>
      <textarea id="decline-note" value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="focus-ring min-h-[44px] rounded-lg px-4 text-sm font-semibold text-text-secondary">Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={busy} className="focus-ring min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Sending…' : 'Send to dispatcher'}</button>
      </div>
    </section>
  );
}
