/**
 * Payment protection — /dashboard/payment-protection (contractor side).
 * Hidden unless the flag `homeowner_payment_protection` is ON; the server refuses new holds regardless.
 * Docs: docs/payments/homeowner-payment-protection.md
 */
import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useFeatureFlags } from '@/hooks/useFeatureFlag';
import { supabase } from '@/lib/supabase';
import {
  PP_FLAG, claimCompletion, createHold, fetchHoldDetail, formatMoney, listHolds, respondToDispute, sendRequest, voidHold,
} from '@/lib/paymentProtection';
import type { HoldDetail, HoldRow, HoldState } from '@/lib/paymentProtection';

const STATE_LABEL: Record<HoldState, string> = {
  draft: 'Not sent', awaiting_authorization: 'Waiting for homeowner', held: 'Payment held', completion_claimed: 'Completion submitted',
  disputed: 'In dispute', capturing: 'Releasing…', voiding: 'Cancelling…', released: 'Released', voided: 'Cancelled',
  expired: 'Expired — nobody charged', failed: 'Failed', needs_review: 'Needs review (support)',
};

interface JobOption { id: string; customer_name: string; service_type: string | null }

export function PaymentProtectionPage() {
  const { isEnabled, ready } = useFeatureFlags();
  const { toast } = useToast();
  const [holds, setHolds] = useState<HoldRow[] | null>(null);
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ holdId: string; url: string } | null>(null);
  const [detail, setDetail] = useState<HoldDetail | null>(null);
  const [reply, setReply] = useState('');
  const [form, setForm] = useState({ jobId: '', amount: '' });
  const on = ready && isEnabled(PP_FLAG);

  const reload = useCallback(async () => {
    try {
      const [h, j] = await Promise.all([
        listHolds(),
        supabase.from('jobs').select('id, customer_name, service_type').order('created_at', { ascending: false }).limit(50),
      ]);
      setHolds(h);
      setJobs((j.data ?? []) as JobOption[]);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { if (on) void reload(); }, [on, reload]);

  async function act(key: string, fn: () => Promise<void>, ok: string) {
    setBusy(key);
    try { await fn(); toast(ok, 'success'); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); }
    finally { setBusy(null); }
  }

  const create = () => {
    const cents = Math.round(Number(form.amount) * 100);
    if (!form.jobId || !Number.isFinite(cents) || cents <= 0) return toast('Choose a job and enter an amount.', 'error');
    void act('create', async () => { await createHold(form.jobId, cents); setForm({ jobId: '', amount: '' }); }, 'Protection request created');
  };

  return (
    <DashboardLayout activeLabel="Payment Protection">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><ShieldCheck size={22} aria-hidden="true" />Payment protection</h1>
          <p className="mt-1 text-sm text-text-secondary">
            The homeowner’s card is authorized but not charged. You are paid when they confirm the work, or automatically after the review window if they raise no problem.
            If the work is disputed, Vireek staff review the job timeline.
          </p>
        </header>

        {!ready && <Loader2 className="h-5 w-5 animate-spin text-text-secondary" aria-label="Loading" />}
        {ready && !on && (
          <p role="status" className="rounded-xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
            Payment protection isn’t available on your account yet.
          </p>
        )}

        {on && (
          <>
            <section aria-labelledby="pp-new" className="rounded-xl border border-border bg-bg-secondary p-4">
              <h2 id="pp-new" className="mb-3 text-base font-semibold text-text-primary">Protect a payment</h2>
              <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
                <label className="block text-sm text-text-secondary">Job
                  <select className="mt-1 w-full rounded-control border border-border bg-bg-primary p-2.5 text-text-primary" value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
                    <option value="">Select a job…</option>
                    {jobs.map((j) => <option key={j.id} value={j.id}>{j.customer_name}{j.service_type ? ` — ${j.service_type}` : ''}</option>)}
                  </select>
                </label>
                <Input label="Amount" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                <Button onClick={create} loading={busy === 'create'}>Create</Button>
              </div>
            </section>

            {link && (
              <section role="status" className="rounded-xl border border-accent/30 bg-accent/5 p-4">
                <p className="text-sm text-text-primary">Send this link to the homeowner. It is shown only once.</p>
                <div className="mt-2 flex gap-2">
                  <Input aria-label="Homeowner link" readOnly value={link.url} />
                  <Button variant="secondary" iconOnly aria-label="Copy link" onClick={() => { void navigator.clipboard.writeText(link.url); toast('Link copied', 'success'); }}><Copy size={16} aria-hidden="true" /></Button>
                </div>
              </section>
            )}

            {error && <p role="alert" className="text-danger">{error}</p>}
            {!holds && !error && <Loader2 className="h-5 w-5 animate-spin text-text-secondary" aria-label="Loading" />}
            {holds && holds.length === 0 && <p className="text-sm text-text-secondary">No protected payments yet.</p>}

            <ul className="space-y-3">
              {(holds ?? []).map((h) => (
                <li key={h.id} className="rounded-xl border border-border bg-bg-secondary p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-text-primary">{formatMoney(h.amount_cents, h.currency)}</p>
                      <p className="text-sm text-text-secondary">{STATE_LABEL[h.state]}</p>
                      {h.capture_before && ['held', 'completion_claimed', 'disputed'].includes(h.state) && (
                        <p className="text-xs text-text-muted">Card hold ends {new Date(h.capture_before).toLocaleString()}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {['draft', 'awaiting_authorization'].includes(h.state) && (
                        <Button size="sm" loading={busy === `s${h.id}`} onClick={() => void act(`s${h.id}`, async () => { const r = await sendRequest(h.id); setLink({ holdId: h.id, url: r.url }); }, 'Link ready')}>
                          {h.state === 'draft' ? 'Get link' : 'New link'}
                        </Button>
                      )}
                      {h.state === 'held' && (
                        <Button size="sm" loading={busy === `c${h.id}`} onClick={() => void act(`c${h.id}`, async () => { await claimCompletion(h.id); }, 'Completion submitted')}>Work is complete</Button>
                      )}
                      {['draft', 'awaiting_authorization', 'held', 'completion_claimed'].includes(h.state) && (
                        <Button size="sm" variant="secondary" loading={busy === `v${h.id}`}
                          onClick={() => { if (window.confirm('Cancel this protection and release the homeowner’s card hold?')) void act(`v${h.id}`, async () => { await voidHold(h.id); }, 'Cancelled'); }}>Cancel</Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => void fetchHoldDetail(h.id).then(setDetail).catch((e) => toast(e.message, 'error'))}>Details</Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {detail && (
              <section aria-labelledby="pp-detail" className="rounded-xl border border-border bg-bg-secondary p-4">
                <div className="flex items-center justify-between">
                  <h2 id="pp-detail" className="text-base font-semibold text-text-primary">History</h2>
                  <Button size="xs" variant="ghost" onClick={() => setDetail(null)}>Close</Button>
                </div>
                <ol className="mt-2 space-y-1 text-sm text-text-secondary">
                  {detail.events.map((e, i) => <li key={i}>{new Date(e.at).toLocaleString()} — {e.event.replace(/_/g, ' ')} ({e.actor})</li>)}
                </ol>
                {detail.dispute && (
                  <div className="mt-4 space-y-2 text-sm">
                    <h3 className="font-semibold text-text-primary">Dispute ({detail.dispute.status})</h3>
                    <p className="text-text-secondary">Reason: {detail.dispute.reason_code.replace(/_/g, ' ')}. “{detail.dispute.statement}”</p>
                    <p className="text-xs text-text-muted">Evidence snapshot SHA-256: {detail.dispute.evidence_sha256}</p>
                    {detail.dispute.notes.map((n, i) => <p key={i} className="text-text-secondary"><span className="font-medium text-text-primary">{n.author}:</span> {n.body}</p>)}
                    {detail.dispute.status === 'open' && (
                      <div className="flex gap-2">
                        <Input aria-label="Your response" value={reply} onChange={(e) => setReply(e.target.value)} />
                        <Button size="sm" disabled={reply.trim().length < 3} onClick={() => void act('r', async () => { await respondToDispute(detail.hold.id, reply); setReply(''); setDetail(await fetchHoldDetail(detail.hold.id)); }, 'Response added')}>Send</Button>
                      </div>
                    )}
                    {detail.dispute.resolution_note && <p className="text-text-secondary">Decision: {detail.dispute.resolution?.replace(/_/g, ' ')} — {detail.dispute.resolution_note}</p>}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
