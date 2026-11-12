import { useState } from 'react';
import { Flag, CheckCircle2 } from 'lucide-react';
import { reportWrongCall, type WrongCallReason } from '@/lib/pilotScorecardApi';

const REASONS: { value: WrongCallReason; label: string }[] = [
  { value: 'wrong_price', label: 'Quoted a wrong price' },
  { value: 'wrong_booking', label: 'Booked incorrectly / missed a booking' },
  { value: 'missed_emergency', label: 'Missed an emergency' },
  { value: 'false_emergency', label: 'Treated a routine call as an emergency' },
  { value: 'wrong_escalation', label: 'Should (not) have escalated' },
  { value: 'promised_arrival', label: 'Promised an arrival time' },
  { value: 'other', label: 'Something else' },
];

/** "This call was wrong" — creates an UNLABELED eval candidate. The transcript is only stored (PII-scrubbed) if the owner ticks consent. */
export function WrongCallButton({ callId }: { callId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<WrongCallReason>('wrong_price');
  const [note, setNote] = useState('');
  const [share, setShare] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'duplicate'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (state === 'done' || state === 'duplicate') {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
        <CheckCircle2 size={14} className="text-success" />
        {state === 'done' ? 'Thanks — this call was flagged for review.' : 'This call was already flagged.'}
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary">
        <Flag size={14} aria-hidden="true" /> This call was wrong
      </button>
    );
  }
  const submit = async () => {
    setState('saving'); setError(null);
    try {
      const id = await reportWrongCall({ callId, reason, note: note.trim() || undefined, shareForEval: share });
      setState(id ? 'done' : 'duplicate');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not send the report.'); setState('idle'); }
  };
  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-4">
      <label className="block text-xs font-medium text-text-secondary" htmlFor={`wc-reason-${callId}`}>What went wrong?</label>
      <select id={`wc-reason-${callId}`} value={reason} onChange={(e) => setReason(e.target.value as WrongCallReason)} className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary">
        {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} aria-label="Optional details" placeholder="Optional details (phone numbers, emails and addresses are removed automatically)" className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary" />
      <label className="flex items-start gap-2 text-xs text-text-secondary">
        <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} className="mt-0.5" />
        <span>Let Vireek use a privacy-scrubbed copy of this call’s transcript to improve the assistant. Names are not removed automatically. Leave unticked to share nothing from the call.</span>
      </label>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={state === 'saving'} className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60">{state === 'saving' ? 'Sending…' : 'Send report'}</button>
        <button type="button" onClick={() => setOpen(false)} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary">Cancel</button>
      </div>
    </div>
  );
}
