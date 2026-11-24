/**
 * Homeowner page — /protect/:token. No login: access is the one-time token in the link (only its SHA-256 is stored).
 * Wording: never call this "escrow" (docs/payments/homeowner-payment-protection.md §2).
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { formatMoney, homeownerCall, canHomeownerDispute } from '@/lib/paymentProtection';
import type { HomeownerView } from '@/lib/paymentProtection';

const REASONS: Array<[string, string]> = [
  ['work_not_done', 'The work was not done'], ['work_incomplete', 'The work is incomplete'], ['quality', 'The quality is not acceptable'],
  ['no_show', 'Nobody showed up'], ['price_mismatch', 'The price is not what we agreed'], ['other', 'Something else'],
];

export function ProtectPage() {
  const { token = '' } = useParams();
  const [hold, setHold] = useState<HomeownerView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('work_incomplete');
  const [statement, setStatement] = useState('');

  useEffect(() => { document.title = 'Payment protection'; const m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex'; document.head.appendChild(m); return () => { m.remove(); }; }, []);

  const load = useCallback(async (sync: boolean) => {
    try {
      const r = await homeownerCall<{ hold: HomeownerView | null }>(token, sync ? 'sync' : 'view');
      setHold(r.hold);
    } catch { setHold(null); }
  }, [token]);
  useEffect(() => { void load(new URLSearchParams(window.location.search).has('returned')); }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setMessage(null);
    try { await fn(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Something went wrong. Please try again.'); } finally { setBusy(false); }
  }

  if (hold === undefined) return <main className="flex min-h-screen items-center justify-center bg-bg-primary"><Loader2 className="h-6 w-6 animate-spin text-text-secondary" aria-label="Loading" /></main>;
  if (hold === null) return <main className="mx-auto max-w-md px-4 py-16 text-center text-text-primary"><h1 className="text-xl font-semibold">This link isn’t valid</h1><p className="mt-2 text-sm text-text-secondary">It may have expired. Please ask your contractor for a new one.</p></main>;

  const amount = formatMoney(hold.amount_cents, hold.currency);
  return (
    <main className="mx-auto max-w-md space-y-5 px-4 py-10">
      <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary"><ShieldCheck size={20} aria-hidden="true" />Payment protection</h1>
      <p className="text-sm text-text-secondary">{hold.business_name}{hold.service_type ? ` — ${hold.service_type}` : ''}: <strong className="text-text-primary">{amount}</strong></p>

      {message && <p role="alert" className="rounded-control border border-danger/40 p-3 text-sm text-danger">{message}</p>}

      {hold.state === 'awaiting_authorization' && (
        <section className="space-y-3">
          <p className="text-sm text-text-secondary">Your card is authorized for {amount} but <strong>not charged yet</strong>. The contractor is paid only after you confirm the work (or after the review window if you raise no problem).</p>
          <Button fullWidth loading={busy} onClick={() => void run(async () => { const r = await homeownerCall<{ url: string }>(token, 'authorize'); window.location.assign(r.url); })}>Authorize {amount}</Button>
        </section>
      )}

      {['held', 'completion_claimed'].includes(hold.state) && (
        <section className="space-y-3">
          <p className="text-sm text-text-secondary">
            {hold.state === 'held' ? 'Your payment is reserved on your card. The contractor will tell us when the work is finished.'
              : `The contractor says the work is finished. Confirm to pay${hold.release_due_at ? `, or raise a problem before ${new Date(hold.release_due_at).toLocaleString()} — after that the payment is released automatically` : ''}.`}
          </p>
          {hold.state === 'completion_claimed' && !disputing && (
            <Button fullWidth loading={busy} onClick={() => void run(async () => { await homeownerCall(token, 'confirm'); await load(false); })}>Work is complete — release {amount}</Button>
          )}
          {canHomeownerDispute(hold.state) && !disputing && <Button fullWidth variant="secondary" onClick={() => setDisputing(true)}>There is a problem</Button>}
          {disputing && (
            <div className="space-y-3">
              <label className="block text-sm text-text-secondary">What went wrong?
                <select className="mt-1 w-full rounded-control border border-border bg-bg-primary p-2.5 text-text-primary" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <Textarea label="Describe the problem" value={statement} onChange={(e) => setStatement(e.target.value)} maxLength={2000} />
              <Button fullWidth loading={busy} disabled={statement.trim().length < 10} onClick={() => void run(async () => { await homeownerCall(token, 'dispute', { reason, statement }); setDisputing(false); await load(false); })}>Send to review</Button>
            </div>
          )}
        </section>
      )}

      {hold.state === 'disputed' && <p role="status" className="text-sm text-text-secondary">Your problem has been sent for review. Your card is not charged while we look at it.</p>}
      {['capturing', 'voiding'].includes(hold.state) && <p role="status" className="text-sm text-text-secondary">Working on it… refresh in a moment.</p>}
      {hold.state === 'released' && <p role="status" className="text-sm text-text-secondary">Thank you — the payment has been completed.</p>}
      {['voided', 'expired', 'failed'].includes(hold.state) && <p role="status" className="text-sm text-text-secondary">This payment was not charged. Any hold on your card is released by your bank, which can take a few days.</p>}
      {hold.state === 'needs_review' && <p role="status" className="text-sm text-text-secondary">We’re checking this payment and will follow up.</p>}
    </main>
  );
}
