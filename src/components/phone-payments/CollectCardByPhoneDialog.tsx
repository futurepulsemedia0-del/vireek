import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleX, Lock, ShieldCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  cancelPhonePayment, cardLabel, fetchSession, isActive, money, PhonePaymentError, startPhonePayment,
  STATUS_LABELS, type PhonePaymentSession,
} from '@/lib/phonePayments';

interface JobOption {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  service_type: string | null;
  invoice_amount: number | null;
}

interface Props {
  open: boolean;
  vapiCallId: string;
  callerPhone: string | null;
  onClose: () => void;
}

const digits = (p: string | null) => (p ?? '').replace(/\D/g, '').slice(-10);
const FAILURE_COPY: Record<string, string> = {
  payment_declined: 'The card was declined.', needs_authentication: 'The card needs extra verification that cannot be done by phone.',
  caller_timeout: 'No card details were entered in time.', caller_cancelled: 'The caller cancelled.', invalid_input: 'The card details could not be validated.',
  provider_error: 'The payment provider reported a problem.', balance_changed: 'The balance changed during the call, so nothing was charged.',
  recording_pause_failed: 'Recording could not be paused, so secure capture was blocked.', redirect_failed: 'The caller could not be moved to the secure line.',
  expired: 'The secure session expired.', cancelled: 'Cancelled.',
};

export function CollectCardByPhoneDialog({ open, vapiCallId, callerPhone, onClose }: Props) {
  const ref = useFocusTrap(open);
  useEscapeToClose(open, onClose);
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [jobId, setJobId] = useState('');
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<PhonePaymentSession | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;
    setSessionId(null); setSession(null); setError(null); setJobId('');
    setLoadingJobs(true);
    void supabase.from('jobs').select('id, customer_name, customer_phone, service_type, invoice_amount')
      .gt('invoice_amount', 0).neq('invoice_status', 'paid').order('created_at', { ascending: false }).limit(25)
      .then(({ data }) => {
        const mine = digits(callerPhone);
        const list = ((data ?? []) as JobOption[]).sort((a, b) => Number(digits(b.customer_phone) === mine && !!mine) - Number(digits(a.customer_phone) === mine && !!mine));
        setJobs(list);
        if (list[0] && mine && digits(list[0].customer_phone) === mine) setJobId(list[0].id);
        setLoadingJobs(false);
      });
  }, [open, callerPhone]);

  const poll = useCallback(async (id: string) => {
    try { const s = await fetchSession(id); if (s) setSession(s); } catch { /* keep last known state */ }
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    void poll(sessionId);
    timer.current = setInterval(() => void poll(sessionId), 2000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [sessionId, poll]);

  useEffect(() => {
    if (session && !isActive(session.status) && timer.current) clearInterval(timer.current);
  }, [session]);

  if (!open) return null;

  const start = async () => {
    setBusy(true); setError(null);
    try { const r = await startPhonePayment(vapiCallId, jobId); setSessionId(r.sessionId); }
    catch (e) { setError(e instanceof PhonePaymentError ? e.message : 'The secure payment could not be started.'); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!sessionId) return;
    setBusy(true);
    try { await cancelPhonePayment(sessionId); await poll(sessionId); } catch (e) { setError(e instanceof PhonePaymentError ? e.message : 'Could not cancel.'); }
    finally { setBusy(false); }
  };

  const active = session ? isActive(session.status) : false;
  const finished = session && !active;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="cc-title" className="w-full max-w-md rounded-2xl border border-border bg-bg-primary p-6 shadow-xl">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent"><Lock size={18} /></span>
          <h2 id="cc-title" className="text-lg font-semibold text-text-primary">Collect card by phone</h2>
        </div>

        {!sessionId && (
          <>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary">
              The caller is moved to a secure keypad line and types their card with their phone. You will not hear or see the digits, call recording is paused, and Vireek never receives the card number.
              {' '}The amount is the job's open balance, checked on the server.
            </p>
            <label htmlFor="cc-job" className="mt-4 block text-sm font-medium text-text-primary">Job to charge</label>
            <select id="cc-job" value={jobId} onChange={(e) => setJobId(e.target.value)} disabled={loadingJobs || busy}
              className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary">
              <option value="">{loadingJobs ? 'Loading jobs…' : jobs.length ? 'Choose a job' : 'No unpaid jobs found'}</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {(j.customer_name ?? 'Customer')} — {j.service_type ?? 'Service'} — {money(Math.round(Number(j.invoice_amount ?? 0) * 100))}
                </option>
              ))}
            </select>
            {error && <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-text-primary">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>Close</Button>
              <Button type="button" size="sm" onClick={() => void start()} disabled={!jobId || busy}>
                <ShieldCheck size={15} />{busy ? 'Starting…' : 'Start secure capture'}
              </Button>
            </div>
          </>
        )}

        {sessionId && (
          <div className="mt-4" aria-live="polite">
            <div className="rounded-xl border border-border bg-bg-secondary px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-text-secondary">Status</p>
              <p className="mt-0.5 text-base font-semibold text-text-primary">{session ? STATUS_LABELS[session.status] : 'Starting…'}</p>
              {session && <p className="mt-1 text-sm text-text-secondary">{money(session.amount_cents)}{session.card_last4 ? ` · ${cardLabel(session.card_brand, session.card_last4)}` : ''}</p>}
            </div>
            <ul className="mt-3 space-y-1.5 text-sm text-text-secondary">
              <li>{session?.recording_paused_at ? '✓' : '○'} Call recording paused</li>
              <li>{session?.capture_started_at ? '✓' : '○'} Caller on secure keypad line</li>
              <li>{session && ['tokenized', 'charging', 'succeeded'].includes(session.status) ? '✓' : '○'} Card tokenized by the provider</li>
              <li>{session?.status === 'succeeded' ? '✓' : '○'} Payment completed</li>
              <li>{session?.recording_resumed_at ? '✓' : '○'} Call recording resumed</li>
            </ul>
            {finished && session.status === 'succeeded' && (
              <p role="status" className="mt-3 flex items-center gap-2 rounded-xl border border-success-500/30 bg-success-500/10 px-3 py-2 text-sm text-text-primary"><CircleCheck size={16} />Payment received. A receipt is being sent.</p>
            )}
            {finished && session.status !== 'succeeded' && (
              <p role="alert" className="mt-3 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-text-primary"><CircleX size={16} />{FAILURE_COPY[session.failure_code ?? ''] ?? 'The payment did not complete.'}</p>
            )}
            {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              {active && session?.status === 'capturing' && <Button type="button" variant="secondary" size="sm" onClick={() => void cancel()} disabled={busy}>Cancel capture</Button>}
              <Button type="button" size="sm" onClick={onClose} disabled={active && session?.status !== 'capturing'}>{finished ? 'Done' : 'Close'}</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
