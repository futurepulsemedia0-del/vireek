import { useState } from 'react';
import { AlertTriangle, Check, Copy, Loader2, ShieldAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  IMPERSONATION_MINUTES,
  REASON_MAX,
  endImpersonation,
  startImpersonation,
  validateImpersonationRequest,
  type ImpersonationGrant,
} from '@/lib/staffCustomers';

interface ImpersonateDialogProps {
  open: boolean;
  accountId: string;
  accountLabel: string;
  onClose: () => void;
}

export function ImpersonateDialog({ open, accountId, accountLabel, onClose }: ImpersonateDialogProps) {
  const { toast } = useToast();
  const ref = useFocusTrap(open);
  const [reason, setReason] = useState('');
  const [ticketRef, setTicketRef] = useState('');
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [grant, setGrant] = useState<ImpersonationGrant | null>(null);
  const [copied, setCopied] = useState(false);
  const [ending, setEnding] = useState(false);

  if (!open) return null;

  const reset = () => {
    setReason('');
    setTicketRef('');
    setAck(false);
    setErrors([]);
    setGrant(null);
    setCopied(false);
  };

  const cancel = () => {
    if (starting || ending) return;
    reset();
    onClose();
  };

  const start = async () => {
    const problems = validateImpersonationRequest({ reason, ticketRef });
    setErrors(problems);
    if (problems.length > 0 || !ack) return;
    setStarting(true);
    try {
      setGrant(await startImpersonation(accountId, reason.trim(), ticketRef));
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Could not start the session.']);
    } finally {
      setStarting(false);
    }
  };

  const copy = async () => {
    if (!grant) return;
    try {
      await navigator.clipboard.writeText(grant.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Copy failed. Select the link text and copy it manually.', 'error');
    }
  };

  const finish = async () => {
    if (!grant) return;
    setEnding(true);
    try {
      await endImpersonation(grant.sessionId);
    } catch {
      toast('The session could not be marked as ended. It will expire on its own.', 'error');
    } finally {
      setEnding(false);
      reset();
      onClose();
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm" onClick={grant ? undefined : cancel} aria-hidden="true" />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Sign in as customer"
        onKeyDown={(e) => e.key === 'Escape' && !grant && cancel()}
        className="fixed left-1/2 top-1/2 z-[120] flex max-h-[90vh] w-[94vw] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-warning-500/10 text-warning-500"><ShieldAlert size={18} /></span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-text-primary">Sign in as customer</h2>
              <p className="truncate text-xs text-text-secondary">{accountLabel}</p>
            </div>
          </div>
          {!grant && (
            <button type="button" onClick={cancel} aria-label="Close" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
          )}
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          {grant ? (
            <>
              <div className="flex items-start gap-3 rounded-xl bg-warning-500/10 p-4">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning-500" />
                <p className="text-sm text-text-primary">
                  Open this link in a <strong>private / incognito window</strong>. Opening it in this browser replaces your own staff session.
                  Everything you do there is done as the customer and is logged. Target session length: {IMPERSONATION_MINUTES} minutes.
                </p>
              </div>
              <div className="break-all rounded-xl bg-bg-tertiary p-3 font-mono text-[11px] text-text-secondary" aria-label="One-time sign-in link">{grant.link}</div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => void copy()}>
                  {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy link'}
                </Button>
                <Button type="button" onClick={() => void finish()} disabled={ending}>
                  {ending && <Loader2 size={14} className="animate-spin" />} Done — end session
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-text-secondary">
                This signs you in as the account owner. The customer can see in their own activity log that Vireek Support accessed their account, and your reason is stored permanently.
              </p>
              <Textarea
                label="Why do you need access?"
                rows={4}
                maxLength={REASON_MAX}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Customer reports missed calls not showing; reproducing issue from ticket."
                helperText={`${reason.trim().length}/${REASON_MAX}`}
              />
              <Input label="Ticket reference (optional)" value={ticketRef} maxLength={40} onChange={(e) => setTicketRef(e.target.value)} placeholder="ZD-1042" />
              <label className="flex items-start gap-2 text-sm text-text-primary">
                <input type="checkbox" className="focus-ring mt-0.5 h-4 w-4 rounded border-border" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                I understand this session is logged, visible to the customer, and must only be used to resolve their request.
              </label>
              {errors.length > 0 && (
                <ul role="alert" className="space-y-0.5">
                  {errors.map((m) => (
                    <li key={m} className="text-xs text-danger">{m}</li>
                  ))}
                </ul>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={cancel} disabled={starting}>Cancel</Button>
                <Button type="button" onClick={() => void start()} disabled={starting || !ack || reason.trim().length === 0}>
                  {starting && <Loader2 size={14} className="animate-spin" />} Create sign-in link
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
