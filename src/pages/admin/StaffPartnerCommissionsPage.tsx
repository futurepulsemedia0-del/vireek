// /staff/partner-commissions — partner commission terms, ledger, payouts and voids (Vireek employees only).
// Data + writes: staff_partner_* / set_partner_commission_terms / pay_partner_approved_commissions /
// void_partner_commission_entry RPCs (20290303000000 + 20290303000100). Each re-checks is_vireek_staff().
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Wallet } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import {
  AFFILIATE_MAX_COMMISSION_PCT,
  AFFILIATE_MAX_MONTHS,
  AFFILIATE_MIN_PAYOUT_CENTS,
  AFFILIATE_OVERRIDE_MIN_REASON_CHARS,
  validateCommissionTerms,
} from '@/lib/affiliateCommission';
import { formatUsdCents, type LedgerEntry, type PartnerCommissionRow, type PartnerLedger } from '@/lib/partnerCommissionStaff';
import {
  approveLegacyEstimate,
  fetchPartnerLedger,
  fetchPartnerOverview,
  payPartner,
  setPartnerTerms,
  voidLedgerEntry,
} from '@/lib/partnerCommissionStaffApi';

function SEO() {
  useSEO({
    title: 'Partner commissions — Staff',
    description: 'Internal: partner commission terms, ledger and payouts.',
    canonical: 'https://vireek.com/staff/partner-commissions',
  });
  return null;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export function StaffPartnerCommissionsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState<PartnerCommissionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PartnerCommissionRow | null>(null);
  const [ledger, setLedger] = useState<PartnerLedger | null>(null);
  const [busy, setBusy] = useState(false);
  const [rate, setRate] = useState('');
  const [months, setMonths] = useState('');
  const [reason, setReason] = useState('');

  const loadOverview = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchPartnerOverview();
      setRows(data);
      setSelected((cur) => (cur ? data.find((r) => r.id === cur.id) ?? null : cur));
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  const loadLedger = useCallback(async (id: string) => {
    setLedger(null);
    try {
      setLedger(await fetchPartnerLedger(id));
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }, [toast]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const open = (p: PartnerCommissionRow) => {
    setSelected(p);
    setRate(String(p.commission_rate));
    setMonths(String(p.commission_months));
    setReason('');
    void loadLedger(p.id);
  };

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      toast(await fn(), 'success');
      await loadOverview();
      if (selected) await loadLedger(selected.id);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveTerms = () => {
    if (!selected) return;
    const r = Number(rate);
    const m = Number(months);
    const trimmed = reason.trim();
    if (trimmed.length < AFFILIATE_OVERRIDE_MIN_REASON_CHARS) {
      toast(`A reason of at least ${AFFILIATE_OVERRIDE_MIN_REASON_CHARS} characters is required for every change.`, 'error');
      return;
    }
    const check = validateCommissionTerms({ ratePct: r, months: m, overrideReason: trimmed });
    if (!check.ok) { toast(check.error, 'error'); return; }
    if (check.override && !window.confirm(`This exceeds the standard limit (${AFFILIATE_MAX_COMMISSION_PCT}% / ${AFFILIATE_MAX_MONTHS} months) and is logged as a staff override. Continue?`)) return;
    void run(async () => { await setPartnerTerms(selected.id, r, m, trimmed); return 'Terms updated.'; });
  };

  const pay = () => {
    if (!selected) return;
    if (!window.confirm(`Mark the payable balance of ${formatUsdCents(selected.payable_cents)} as paid? Money is NOT moved by this action.`)) return;
    void run(async () => { const r = await payPartner(selected.id); return `Marked ${formatUsdCents(r.paid_cents)} paid (${r.entries} entries).`; });
  };

  const voidEntry = (e: LedgerEntry) => {
    const why = window.prompt(`Reason for voiding this ${e.entry_type} entry (min ${AFFILIATE_OVERRIDE_MIN_REASON_CHARS} characters):`);
    if (!why) return;
    void run(async () => { await voidLedgerEntry(e.id, why.trim()); return 'Entry voided.'; });
  };

  const approveLegacy = (e: LedgerEntry) => {
    if (!window.confirm('Approve this pre-ledger estimate for payout? It was NOT verified against collected revenue.')) return;
    void run(async () => { await approveLegacyEstimate(e.referral_id); return 'Legacy estimate approved.'; });
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Wallet className="text-accent" size={22} aria-hidden="true" />
                <h1 className="text-2xl font-bold tracking-tight text-text-primary">Partner commissions</h1>
              </div>
              <p className="mt-1 text-sm text-text-secondary">
                Limits (proposed, unvalidated): {AFFILIATE_MAX_COMMISSION_PCT}% · {AFFILIATE_MAX_MONTHS} months · minimum payout {formatUsdCents(AFFILIATE_MIN_PAYOUT_CENTS)}.
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void loadOverview()} aria-label="Refresh partner commissions">
              <RefreshCw size={14} aria-hidden="true" /> Refresh
            </Button>
          </div>

          {error && <p role="alert" className="mt-6 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</p>}
          {!rows && !error && <div className="mt-10 flex justify-center"><Loader2 className="animate-spin text-text-secondary" aria-label="Loading" /></div>}
          {rows && rows.length === 0 && <p className="mt-10 text-sm text-text-secondary">No partners yet.</p>}

          {rows && rows.length > 0 && (
            <div className="mt-6 overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="text-xs uppercase text-text-secondary">
                  <tr>
                    {['Partner', 'Status', 'Terms', 'Referrals', 'Payable', 'Held', 'Paid', 'Clawed back'].map((h) => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className={`border-t border-border ${selected?.id === p.id ? 'bg-bg-tertiary' : ''}`}>
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => open(p)} className="text-left font-medium text-text-primary underline-offset-2 hover:underline">{p.company_name}</button>
                        <div className="text-xs text-text-secondary">{p.contact_email} · {p.tier}</div>
                      </td>
                      <td className="px-4 py-3">{p.status}</td>
                      <td className="px-4 py-3 tabular-nums">
                        {p.commission_rate}% · {p.commission_months} mo
                        {p.commission_override_active && (
                          <span className="ml-2 rounded-full bg-warning-500/10 px-2 py-0.5 text-xs text-warning-500">
                            {p.commission_override_approved ? 'override' : 'legacy — review'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums">{p.referrals}</td>
                      <td className="px-4 py-3 tabular-nums">{formatUsdCents(p.payable_cents)}</td>
                      <td className="px-4 py-3 tabular-nums">{formatUsdCents(p.held_cents)}</td>
                      <td className="px-4 py-3 tabular-nums">{formatUsdCents(p.paid_cents)}</td>
                      <td className="px-4 py-3 tabular-nums">{formatUsdCents(p.clawed_back_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selected && (
            <section aria-label={`Details for ${selected.company_name}`} className="mt-8 space-y-6">
              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h2 className="text-lg font-semibold text-text-primary">{selected.company_name}</h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-4">
                  <label className="text-sm text-text-secondary">Rate %
                    <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-text-primary" />
                  </label>
                  <label className="text-sm text-text-secondary">Months
                    <input inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-text-primary" />
                  </label>
                  <label className="text-sm text-text-secondary sm:col-span-2">Reason (required, audit-logged)
                    <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-text-primary" />
                  </label>
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button size="sm" onClick={saveTerms} loading={busy}>Save terms</Button>
                  <Button size="sm" variant="secondary" onClick={pay} loading={busy} disabled={selected.payable_cents < AFFILIATE_MIN_PAYOUT_CENTS}>
                    Mark payable balance paid ({formatUsdCents(selected.payable_cents)})
                  </Button>
                </div>
                {selected.payable_cents < AFFILIATE_MIN_PAYOUT_CENTS && (
                  <p className="mt-2 text-xs text-text-secondary">Below the minimum payout; the database enforces this too.</p>
                )}
              </div>

              <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                <h3 className="px-5 pt-4 text-sm font-semibold text-text-primary">Ledger</h3>
                {!ledger ? <div className="p-5"><Loader2 className="animate-spin text-text-secondary" aria-label="Loading ledger" /></div> : ledger.entries.length === 0 ? (
                  <p className="p-5 text-sm text-text-secondary">No ledger entries yet.</p>
                ) : (
                  <table className="mt-2 w-full min-w-[760px] text-left text-sm">
                    <thead className="text-xs uppercase text-text-secondary">
                      <tr>{['When', 'Type', 'Amount', 'Base × rate', 'Invoice', 'Status', ''].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {ledger.entries.map((e) => (
                        <tr key={e.id} className="border-t border-border">
                          <td className="px-4 py-2 tabular-nums">{e.earned_at.slice(0, 10)}</td>
                          <td className="px-4 py-2">{e.entry_type}{e.period_index ? ` #${e.period_index}` : ''}{e.source_kind ? ` (${e.source_kind})` : ''}</td>
                          <td className={`px-4 py-2 tabular-nums ${e.amount_cents < 0 ? 'text-danger' : ''}`}>{formatUsdCents(e.amount_cents)}</td>
                          <td className="px-4 py-2 tabular-nums">{e.base_cents !== null && e.rate_pct !== null ? `${formatUsdCents(e.base_cents)} × ${e.rate_pct}%` : '—'}</td>
                          <td className="px-4 py-2 font-mono text-xs">{e.stripe_invoice_id ?? '—'}</td>
                          <td className="px-4 py-2">{e.status}{e.status !== 'paid' && e.status !== 'void' && !e.payable ? ' (held)' : ''}</td>
                          <td className="px-4 py-2 text-right">
                            {e.entry_type === 'legacy' && e.status === 'pending' && <Button size="xs" variant="ghost" onClick={() => approveLegacy(e)} disabled={busy}>Approve</Button>}
                            {(e.status === 'pending' || e.status === 'approved') && <Button size="xs" variant="danger" onClick={() => voidEntry(e)} disabled={busy}>Void</Button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {ledger && ledger.audit.length > 0 && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                  <h3 className="text-sm font-semibold text-text-primary">Terms history</h3>
                  <ul className="mt-2 space-y-1 text-sm text-text-secondary">
                    {ledger.audit.map((a, i) => (
                      <li key={`${a.created_at}-${i}`}>
                        {a.created_at.slice(0, 10)} — {a.old_rate ?? '—'}% → {a.new_rate}% · {a.old_months ?? '—'} → {a.new_months} mo{a.override_active ? ' · override' : ''}{a.reason ? ` · ${a.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </div>
      </main>
    </>
  );
}
