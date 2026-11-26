/**
 * Invoice outcomes (staff/admin) — /staff/invoice-outcomes
 * Global switch + kill switch, fee-terms editor (validated with the same rules as the DB), statement approvals, Stripe TEST record, dispute resolution.
 * Staff-internal screen: English only (owner-facing screens are en + fa). Not live-verified; typecheck/lint/e2e NOT RUN by the author.
 */
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { supabase } from '@/lib/supabase';
import {
  isStaff, staffApproveTerms, staffCreateStripeTestRecord, staffDisputeSet, staffSaveTerms, staffSetGlobal, staffTransition, formatMoney,
  type DisputeRow, type StatementRow,
} from '@/lib/invoiceOutcomeApi';
import { validateFeeTerms, type FeeTerms, type OutcomeModel } from '../../supabase/functions/_shared/results-plan/invoiceAttribution';

interface TermsDraft { userId: string; version: string; model: OutcomeModel; effectiveFrom: string; base: string; pct: string; perInvoice: string; floor: string; cap: string; max: string; pilot: string; noFeeDays: string; docVersion: string }
const emptyDraft: TermsDraft = { userId: '', version: '1', model: 'recovered_pct', effectiveFrom: '', base: '0', pct: '0', perInvoice: '0', floor: '0', cap: '', max: '', pilot: '', noFeeDays: '0', docVersion: '1' };
const num = (s: string): number => (s.trim() === '' ? NaN : Number(s));
const orNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));
const iso = (s: string): string | null => (s.trim() === '' ? null : new Date(s).toISOString());
const field = 'block w-full rounded-md border px-2 py-1 text-sm text-text-primary';

export function StaffInvoiceOutcomesPage() {
  const { toast } = useToast();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [global, setGlobal] = useState<{ feature_enabled: boolean; kill_switch: boolean } | null>(null);
  const [statements, setStatements] = useState<Array<StatementRow & { user_id: string; stripe_record_id: string | null }>>([]);
  const [disputes, setDisputes] = useState<Array<DisputeRow & { user_id: string }>>([]);
  const [draft, setDraft] = useState<TermsDraft>(emptyDraft);
  const [terms, setTerms] = useState<Array<{ id: string; user_id: string; version: number; status: string; model: string }>>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [g, s, d, t] = await Promise.all([
      supabase.from('invoice_outcome_global').select('feature_enabled,kill_switch').maybeSingle(),
      supabase.from('invoice_outcome_statements').select('id,user_id,period,state,currency,total_cents,base_fee_cents,outcome_fee_cents,approved_at,terms_version,stripe_record_id,snapshot').order('period', { ascending: false }).limit(50),
      supabase.from('invoice_outcome_disputes').select('id,user_id,line_id,invoice_id,reason,state,opened_at,ack_due_at,resolve_due_at,acknowledged_at,resolved_at,resolution_note').in('state', ['open', 'under_review']).order('resolve_due_at').limit(50),
      supabase.from('invoice_outcome_fee_terms').select('id,user_id,version,status,model').order('created_at', { ascending: false }).limit(50),
    ]);
    setGlobal(g.data as typeof global);
    setStatements((s.data ?? []) as typeof statements);
    setDisputes((d.data ?? []) as typeof disputes);
    setTerms((t.data ?? []) as typeof terms);
  }, []);
  useEffect(() => { void isStaff().then((ok) => { setAllowed(ok); if (ok) void load(); }); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'error'); }
    finally { setBusy(false); }
  };

  const toTerms = (): FeeTerms => ({
    version: num(draft.version), effectiveFrom: iso(draft.effectiveFrom) ?? '', effectiveTo: null, model: draft.model, baseFeeCents: num(draft.base), pctBps: num(draft.pct),
    perInvoiceCents: num(draft.perInvoice), outcomeFloorCents: num(draft.floor), outcomeCapCents: orNull(draft.cap), monthlyMaxTotalCents: orNull(draft.max),
    pilotFreeUntil: iso(draft.pilot), noFeeFirstDays: num(draft.noFeeDays),
  });
  const problems = validateFeeTerms(toTerms());

  if (allowed === null) return <DashboardLayout><main className="p-4" aria-busy="true">Loading…</main></DashboardLayout>;
  if (!allowed) return <DashboardLayout><main className="p-4"><EmptyState variant="no-permission" title="Staff only" /></main></DashboardLayout>;

  return (
    <DashboardLayout>
      <main className="mx-auto grid max-w-5xl gap-4 p-4">
        <h1 className="text-2xl font-bold text-text-primary">Invoice outcome pricing (admin)</h1>

        <Card>
          <h2 className="text-lg font-semibold text-text-primary">Feature switches</h2>
          <p className="text-sm text-text-secondary">Default OFF. The kill switch blocks every transition except void.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button disabled={busy || !global} variant={global?.feature_enabled ? 'secondary' : 'primary'} onClick={() => void act(() => staffSetGlobal(!global?.feature_enabled, global?.kill_switch ?? false), 'Updated')}>
              {global?.feature_enabled ? 'Switch feature OFF' : 'Switch feature ON'}
            </Button>
            <Button disabled={busy || !global} variant="secondary" onClick={() => void act(() => staffSetGlobal(global?.feature_enabled ?? false, !global?.kill_switch), 'Updated')}>
              {global?.kill_switch ? 'Release kill switch' : 'Engage kill switch'}
            </Button>
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-text-primary">New fee terms (draft)</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {([['userId', 'Account (user id)'], ['version', 'Version'], ['effectiveFrom', 'Effective from (date)'], ['base', 'Base fee (cents)'], ['pct', 'Percent (basis points)'], ['perInvoice', 'Per invoice (cents)'],
              ['floor', 'Outcome floor (cents)'], ['cap', 'Outcome cap (cents, optional)'], ['max', 'Monthly max total (cents, optional)'], ['pilot', 'Pilot free until (date, optional)'], ['noFeeDays', 'No outcome fee first N days']] as const).map(([k, label]) => (
              <label key={k} className="text-sm text-text-secondary">{label}
                <input className={field} value={draft[k]} type={k === 'effectiveFrom' || k === 'pilot' ? 'date' : 'text'} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              </label>
            ))}
            <label className="text-sm text-text-secondary">Outcome model
              <select className={field} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value as OutcomeModel })}>
                <option value="recovered_pct">% of confirmed recovered revenue</option><option value="first_pass_per_invoice">Per invoice accepted first-pass above baseline</option><option value="none">None</option>
              </select>
            </label>
          </div>
          {problems.length > 0 && <p role="alert" className="mt-2 text-sm text-text-primary">Fix: {problems.join(', ')}</p>}
          <Button className="mt-2" disabled={busy || problems.length > 0 || draft.userId.trim() === ''} onClick={() => void act(() => staffSaveTerms({
            user_id: draft.userId.trim(), version: num(draft.version), effective_from: iso(draft.effectiveFrom), model: draft.model, base_fee_cents: num(draft.base), pct_bps: num(draft.pct),
            per_invoice_cents: num(draft.perInvoice), outcome_floor_cents: num(draft.floor), outcome_cap_cents: orNull(draft.cap), monthly_max_total_cents: orNull(draft.max),
            pilot_free_until: iso(draft.pilot), no_fee_first_days: num(draft.noFeeDays),
          }), 'Draft saved')}>Save draft</Button>
          <ul className="mt-3 text-sm text-text-secondary">
            {terms.filter((x) => x.status === 'draft').map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-2"><span>{x.user_id.slice(0, 8)} · v{x.version} · {x.model}</span>
                <Button variant="secondary" disabled={busy} onClick={() => void act(() => staffApproveTerms(x.id, num(draft.docVersion)), 'Approved')}>Approve (contract doc v{draft.docVersion})</Button></li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-text-primary">Statements</h2>
          <ul className="mt-2 grid gap-2">
            {statements.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-primary">
                <span>{s.user_id.slice(0, 8)} · {s.period} · {s.state} · {formatMoney(s.total_cents, s.currency, 'en')}{s.stripe_record_id ? ` · ${s.stripe_record_id}` : ''}</span>
                <span className="flex flex-wrap gap-2">
                  {s.state === 'draft' && <Button disabled={busy} onClick={() => void act(() => staffTransition(s.id, 'approved'), 'Approved')}>Approve</Button>}
                  {s.state === 'approved' && !s.stripe_record_id && <Button variant="secondary" disabled={busy} onClick={() => void act(() => staffCreateStripeTestRecord(s.id), 'Stripe TEST record created')}>Create Stripe TEST record</Button>}
                  {s.state === 'approved' && s.stripe_record_id && <Button variant="secondary" disabled={busy} onClick={() => void act(() => staffTransition(s.id, 'invoiced', s.stripe_record_id ?? undefined), 'Invoiced')}>Mark invoiced</Button>}
                  {s.state === 'invoiced' && <Button variant="secondary" disabled={busy} onClick={() => void act(() => staffTransition(s.id, 'paid'), 'Paid')}>Mark paid</Button>}
                  {!['paid', 'void'].includes(s.state) && <Button variant="ghost" disabled={busy} onClick={() => void act(() => staffTransition(s.id, 'void'), 'Voided')}>Void</Button>}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-text-primary">Open disputes (by deadline)</h2>
          <label className="mt-2 block text-sm text-text-secondary" htmlFor="res-note">Resolution note (required to uphold or reject)</label>
          <input id="res-note" className={field} value={note} onChange={(e) => setNote(e.target.value)} />
          <ul className="mt-2 grid gap-2">
            {disputes.map((d) => (
              <li key={d.id} className="text-sm text-text-primary">
                <p>{d.user_id.slice(0, 8)} · {d.state} · due {new Date(d.resolve_due_at).toLocaleDateString('en')}: {d.reason}</p>
                <span className="flex flex-wrap gap-2">
                  {d.state === 'open' && <Button variant="secondary" disabled={busy} onClick={() => void act(() => staffDisputeSet(d.id, 'under_review', note), 'Acknowledged')}>Acknowledge</Button>}
                  <Button disabled={busy || note.trim().length < 5} onClick={() => void act(() => staffDisputeSet(d.id, 'upheld', note), 'Upheld')}>Uphold (remove line)</Button>
                  <Button variant="secondary" disabled={busy || note.trim().length < 5} onClick={() => void act(() => staffDisputeSet(d.id, 'rejected', note), 'Rejected')}>Reject (line stands)</Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </main>
    </DashboardLayout>
  );
}

export default StaffInvoiceOutcomesPage;
