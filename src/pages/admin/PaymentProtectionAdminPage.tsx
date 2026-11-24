// /staff/payment-protection — Vireek staff only. Licensing gate, limits, kill switch, dispute review.
// Convenience only: every rule is enforced again by staff_pp_* RPCs (is_vireek_staff) and the controls CHECK constraint.
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  fetchHoldDetail, formatMoney, staffGetControls, staffKill, staffListDisputes, staffResolveDispute, staffUpdateControls,
} from '@/lib/paymentProtection';
import type { HoldDetail, OpenDisputeRow, PpControls } from '@/lib/paymentProtection';

export function PaymentProtectionAdminPage() {
  const { toast } = useToast();
  const [c, setC] = useState<PpControls | null>(null);
  const [disputes, setDisputes] = useState<OpenDisputeRow[]>([]);
  const [detail, setDetail] = useState<HoldDetail | null>(null);
  const [reason, setReason] = useState('');
  const [f, setF] = useState({ ref: '', max: '', hours: '' });
  const [res, setRes] = useState({ kind: 'release_full', amount: '', note: '' });
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try { const [a, d] = await Promise.all([staffGetControls(), staffListDisputes()]); setC(a); setDisputes(d); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  async function act(fn: () => Promise<void>, ok: string) {
    try { await fn(); toast(ok, 'success'); await reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed.', 'error'); }
  }
  const needReason = () => { if (reason.trim().length < 10) { toast('Write a reason of at least 10 characters.', 'error'); return true; } return false; };

  if (!c) return <div className="min-h-screen bg-bg-primary"><Header /><div className="flex justify-center py-20">{error ? <p role="alert" className="text-danger">{error}</p> : <Loader2 className="h-6 w-6 animate-spin text-text-secondary" />}</div></div>;

  return (
    <div className="min-h-screen bg-bg-primary">
      <Header />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        <h1 className="text-2xl font-bold text-text-primary">Payment protection controls</h1>
        <p className="text-sm text-text-secondary">Status: {c.enabled ? (c.killed_at ? 'ENABLED but KILLED' : 'ENABLED') : 'OFF'}. It cannot be enabled until a licensing/counsel reference, a maximum amount and an auto-release window are saved.</p>

        <section className="space-y-3 rounded-xl border border-border bg-bg-secondary p-4">
          <Input label="Reason (required, min 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Licensing / counsel reference" placeholder={c.licensing_confirmed_ref ?? 'TODO(counsel)'} value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} />
            <Input label="Max amount (major units)" placeholder={String(c.max_amount_cents / 100)} value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} />
            <Input label="Auto-release after (hours)" placeholder={String(c.auto_release_hours ?? 'TODO(owner)')} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => { if (needReason()) return; const p: Record<string, unknown> = {}; if (f.ref.trim()) p.licensing_confirmed_ref = f.ref.trim(); if (f.max.trim()) p.max_amount_cents = Math.round(Number(f.max) * 100); if (f.hours.trim()) p.auto_release_hours = Number(f.hours); void act(() => staffUpdateControls(p, reason.trim()), 'Saved'); }}>Save limits</Button>
            <Button variant="secondary" onClick={() => { if (needReason()) return; void act(() => staffUpdateControls({ enabled: !c.enabled }, reason.trim()), c.enabled ? 'Turned off' : 'Turned on'); }}>{c.enabled ? 'Turn OFF' : 'Turn ON'}</Button>
            <Button variant="danger" onClick={() => { if (needReason()) return; if (window.confirm('Stop all new holds and automatic releases now?')) void act(() => staffKill(reason.trim(), !!c.killed_at), c.killed_at ? 'Kill switch released' : 'Killed'); }}>{c.killed_at ? 'Release kill switch' : 'Kill switch'}</Button>
          </div>
        </section>

        <section aria-labelledby="pp-disputes" className="space-y-3">
          <h2 id="pp-disputes" className="text-lg font-semibold text-text-primary">Open disputes ({disputes.length})</h2>
          {disputes.length === 0 && <p className="text-sm text-text-secondary">None.</p>}
          {disputes.map((d) => (
            <div key={d.dispute_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary p-3">
              <p className="text-sm text-text-primary">{formatMoney(d.amount_cents, d.currency)} — {d.reason_code.replace(/_/g, ' ')}{d.capture_before ? ` — hold ends ${new Date(d.capture_before).toLocaleString()}` : ''}</p>
              <Button size="sm" variant="secondary" onClick={() => void fetchHoldDetail(d.hold_id).then(setDetail)}>Review</Button>
            </div>
          ))}
        </section>

        {detail?.dispute && (
          <section className="space-y-3 rounded-xl border border-border bg-bg-secondary p-4">
            <h2 className="text-lg font-semibold text-text-primary">Review</h2>
            <p className="text-sm text-text-secondary">Homeowner: “{detail.dispute.statement}”</p>
            {detail.dispute.notes.map((n, i) => <p key={i} className="text-sm text-text-secondary"><strong className="text-text-primary">{n.author}:</strong> {n.body}</p>)}
            <details><summary className="cursor-pointer text-sm text-accent">Job timeline evidence (SHA-256 {detail.dispute.evidence_sha256.slice(0, 12)}…)</summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-control bg-bg-tertiary p-3 text-xs text-text-secondary">{JSON.stringify(detail.dispute.evidence, null, 2)}</pre>
            </details>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm text-text-secondary">Decision
                <select className="mt-1 w-full rounded-control border border-border bg-bg-primary p-2.5 text-text-primary" value={res.kind} onChange={(e) => setRes({ ...res, kind: e.target.value })}>
                  <option value="release_full">Pay the contractor in full</option><option value="release_partial">Partial payment</option><option value="void">Release the card hold (no payment)</option>
                </select></label>
              {res.kind === 'release_partial' && <Input label="Amount to pay (major units)" value={res.amount} onChange={(e) => setRes({ ...res, amount: e.target.value })} />}
              <Input label="Decision note (shown to both parties)" value={res.note} onChange={(e) => setRes({ ...res, note: e.target.value })} />
            </div>
            <Button onClick={() => { if (!window.confirm('Apply this decision? Money moves immediately.')) return;
              void act(async () => { await staffResolveDispute(detail.hold.id, res.kind as 'release_full' | 'release_partial' | 'void', res.note.trim(), res.kind === 'release_partial' ? Math.round(Number(res.amount) * 100) : undefined); setDetail(null); }, 'Decision applied'); }}>Apply decision</Button>
          </section>
        )}
      </main>
    </div>
  );
}
