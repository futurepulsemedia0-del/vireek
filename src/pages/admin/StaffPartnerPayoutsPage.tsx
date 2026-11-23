// /staff/partner-payouts — monthly partner revenue-share statements: calculate, review, approve, mark paid, void,
// download CSV/PDF, and manage partner agreements (Vireek employees only).
// Data + writes: calculate_partner_payouts / approve_partner_payout / mark_partner_payout_paid / void_partner_payout /
// *_partner_agreement* RPCs (20290306000100_partner_revenue_share.sql). Each re-checks is_vireek_staff().
// English-only like its sibling /staff/partner-commissions (internal console).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileText, Loader2, RefreshCw, Scale } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import { formatUsdCents } from '@/lib/partnerCommissionStaff';
import {
  CARRY_REASON_LABEL,
  LINE_TYPE_LABEL,
  PAYOUT_STATUS_LABEL,
  isClosedMonth,
  lastClosedMonth,
  periodLabel,
  verifyStatement,
  type AgreementRow,
  type PartnerStatement,
  type PayoutRow,
} from '@/lib/partnerStatement';
import {
  activateAgreement,
  approvePayout,
  calculatePayouts,
  createAgreementDraft,
  fetchAgreements,
  fetchPayouts,
  fetchStatement,
  markPayoutPaid,
  terminateAgreement,
  voidPayout,
} from '@/lib/partnerPayoutsApi';
import { downloadStatementCsv, downloadStatementPdf } from '@/lib/partnerStatementExport';

function SEO() {
  useSEO({
    title: 'Partner payouts — Staff',
    description: 'Internal: monthly partner revenue-share statements and payouts.',
    canonical: 'https://vireek.com/staff/partner-payouts',
  });
  return null;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const REASON_MIN = 10;

const STATUS_STYLE: Record<PayoutRow['status'], string> = {
  calculated: 'bg-accent/10 text-accent',
  carried_forward: 'bg-bg-tertiary text-text-secondary',
  approved: 'bg-warning-subtle text-warning',
  paid: 'bg-success/10 text-success',
  void: 'bg-danger/10 text-danger',
};

const inputCls = 'mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-text-primary';

export function StaffPartnerPayoutsPage() {
  const { toast } = useToast();
  const [month, setMonth] = useState(() => lastClosedMonth().slice(0, 7));
  const [rows, setRows] = useState<PayoutRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<PayoutRow | null>(null);
  const [statement, setStatement] = useState<PartnerStatement | null>(null);
  const [agreements, setAgreements] = useState<AgreementRow[] | null>(null);
  const [draft, setDraft] = useState({ rate: '', months: '12', minPayout: '50', from: '', docRef: '', notes: '' });

  const periodStart = `${month}-01`;
  const monthValid = /^\d{4}-\d{2}$/.test(month) && isClosedMonth(periodStart);

  const load = useCallback(async () => {
    try {
      setError(null);
      setRows(null);
      const data = await fetchPayouts(/^\d{4}-\d{2}$/.test(month) ? `${month}-01` : null);
      setRows(data);
      setSelected((cur) => (cur ? data.find((r) => r.id === cur.id) ?? null : cur));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [month]);

  useEffect(() => { void load(); }, [load]);

  const open = async (p: PayoutRow) => {
    setSelected(p);
    setStatement(null);
    setAgreements(null);
    try {
      const [s, a] = await Promise.all([fetchStatement(p.id), fetchAgreements(p.partner_id)]);
      setStatement(s);
      setAgreements(a);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const refreshSelected = async (id: string) => {
    const p = (await fetchPayouts(/^\d{4}-\d{2}$/.test(month) ? `${month}-01` : null)).find((r) => r.id === id);
    if (p) await open(p);
  };

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      toast(await fn(), 'success');
      await load();
      if (selected) await refreshSelected(selected.id);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const calculate = () => {
    if (!monthValid) { toast('Pick a completed calendar month (UTC).', 'error'); return; }
    void run(async () => {
      const r = await calculatePayouts(periodStart);
      return `${periodLabel(periodStart)}: ${r.created} created, ${r.updated} updated, ${r.locked} locked, ${r.skipped} without activity.`;
    });
  };

  const approve = (p: PayoutRow) => {
    if (!window.confirm(`Approve ${formatUsdCents(p.net_cents)} for ${p.company_name} (${periodLabel(p.period_start)})? The database re-checks that the ledger is unchanged.`)) return;
    void run(async () => { await approvePayout(p.id); return 'Statement approved.'; });
  };

  const markPaid = (p: PayoutRow) => {
    const method = window.prompt('Payment method used (e.g. bank_transfer). Money is NOT moved by this action:', 'bank_transfer');
    if (!method) return;
    const ref = window.prompt('Bank / provider payment reference (required):');
    if (!ref) return;
    void run(async () => { await markPayoutPaid(p.id, method.trim(), ref.trim()); return `Marked ${formatUsdCents(p.net_cents)} paid.`; });
  };

  const voidIt = (p: PayoutRow) => {
    const why = window.prompt(`Reason for voiding this statement (min ${REASON_MIN} characters):`);
    if (!why) return;
    void run(async () => { await voidPayout(p.id, why.trim()); return 'Statement voided. Recalculate the month to create a fresh one.'; });
  };

  const check = useMemo(() => (statement ? verifyStatement(statement) : null), [statement]);

  const exportCsv = (audience: 'finance' | 'partner') => {
    if (!statement) return;
    try { downloadStatementCsv(statement, audience); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const exportPdf = async (audience: 'finance' | 'partner') => {
    if (!statement) return;
    try { await downloadStatementPdf(statement, audience); } catch (e) { toast(errMsg(e), 'error'); }
  };

  const saveDraft = () => {
    if (!selected) return;
    const rate = Number(draft.rate);
    const months = Number(draft.months);
    const minCents = Math.round(Number(draft.minPayout) * 100);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) { toast('Rate must be between 0 and 100.', 'error'); return; }
    if (!Number.isInteger(months) || months < 1 || months > 60) { toast('Months must be a whole number from 1 to 60.', 'error'); return; }
    if (!Number.isFinite(minCents) || minCents < 0) { toast('Minimum payout must be zero or more.', 'error'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.from)) { toast('Pick the agreement start date.', 'error'); return; }
    void run(async () => {
      await createAgreementDraft({ partnerId: selected.partner_id, ratePct: rate, months, minPayoutCents: minCents, effectiveFrom: draft.from, documentRef: draft.docRef.trim(), notes: draft.notes.trim() });
      return 'Draft agreement created.';
    });
  };

  const activate = (a: AgreementRow) => {
    if (!a.document_ref) { toast('Add the signed-document reference before activating (create a new draft with it).', 'error'); return; }
    if (!window.confirm('[COUNSEL] Confirm that the SIGNED agreement was reviewed by counsel. Activation applies its rate and term to this partner through the commission guardrails.')) return;
    const why = window.prompt(`Reason / note for the audit log (min ${REASON_MIN} characters):`);
    if (!why) return;
    void run(async () => { await activateAgreement(a.id, why.trim(), true); return `Agreement v${a.version} activated.`; });
  };

  const terminate = (a: AgreementRow) => {
    const to = window.prompt('End date (YYYY-MM-DD, after the start date):');
    if (!to) return;
    const why = window.prompt(`Reason (min ${REASON_MIN} characters):`);
    if (!why) return;
    void run(async () => { await terminateAgreement(a.id, to.trim(), why.trim()); return `Agreement v${a.version} terminated.`; });
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Scale className="text-accent" size={22} aria-hidden="true" />
                <h1 className="text-2xl font-bold tracking-tight text-text-primary">Partner payouts</h1>
              </div>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">
                Monthly statements are derived from the commission ledger. Approving and marking paid record that staff paid outside Vireek; no money moves here.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm text-text-secondary">Month
                <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} max={lastClosedMonth().slice(0, 7)} />
              </label>
              <Button size="sm" onClick={calculate} loading={busy} disabled={!monthValid}>Calculate month</Button>
              <Button variant="secondary" size="sm" onClick={() => void load()} aria-label="Refresh payouts">
                <RefreshCw size={14} aria-hidden="true" /> Refresh
              </Button>
            </div>
          </div>
          {!monthValid && <p className="mt-2 text-xs text-text-secondary">Only completed calendar months (UTC) can be calculated.</p>}

          {error && <p role="alert" className="mt-6 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</p>}
          {!rows && !error && <div className="mt-10 flex justify-center"><Loader2 className="animate-spin text-text-secondary" aria-label="Loading" /></div>}
          {rows && rows.length === 0 && <p className="mt-10 text-sm text-text-secondary">No statements for {periodLabel(periodStart)} yet. Use “Calculate month”.</p>}

          {rows && rows.length > 0 && (
            <div className="mt-6 overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
              <table className="w-full min-w-[900px] text-start text-sm">
                <thead className="text-xs uppercase text-text-secondary">
                  <tr>{['Partner', 'Period', 'Status', 'Gross', 'Clawbacks', 'Net', 'Terms', ''].map((h) => <th key={h} scope="col" className="px-4 py-3 text-start font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className={`border-t border-border ${selected?.id === p.id ? 'bg-bg-tertiary' : ''}`}>
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => void open(p)} className="text-start font-medium text-text-primary underline-offset-2 hover:underline">{p.company_name}</button>
                        {p.channel && <div className="text-xs text-text-secondary">{p.channel}</div>}
                      </td>
                      <td className="px-4 py-3">{p.source === 'adhoc' ? 'Ad-hoc' : periodLabel(p.period_start)}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[p.status]}`}>{PAYOUT_STATUS_LABEL[p.status]}</span>
                        {p.carry_reason && <div className="mt-1 text-xs text-text-secondary">{CARRY_REASON_LABEL[p.carry_reason]}</div>}
                      </td>
                      <td className="px-4 py-3 tabular-nums">{formatUsdCents(p.gross_cents)}</td>
                      <td className={`px-4 py-3 tabular-nums ${p.clawback_cents < 0 ? 'text-danger' : ''}`}>{formatUsdCents(p.clawback_cents)}</td>
                      <td className={`px-4 py-3 font-medium tabular-nums ${p.net_cents < 0 ? 'text-danger' : ''}`}>{formatUsdCents(p.net_cents)}</td>
                      <td className="px-4 py-3 text-xs text-text-secondary">{p.agreement_version ? `Agreement v${p.agreement_version}` : 'No agreement'}</td>
                      <td className="px-4 py-3 text-end">
                        <div className="flex flex-wrap justify-end gap-2">
                          {p.status === 'calculated' && <Button size="xs" onClick={() => approve(p)} disabled={busy}>Approve</Button>}
                          {p.status === 'approved' && <Button size="xs" onClick={() => markPaid(p)} disabled={busy}>Mark paid</Button>}
                          {(p.status === 'calculated' || p.status === 'carried_forward' || p.status === 'approved') && <Button size="xs" variant="danger" onClick={() => voidIt(p)} disabled={busy}>Void</Button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selected && (
            <section aria-label={`Statement for ${selected.company_name}`} className="mt-8 space-y-6">
              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><FileText size={18} aria-hidden="true" /> {selected.company_name} · {selected.source === 'adhoc' ? 'Ad-hoc payout' : periodLabel(selected.period_start)}</h2>
                  <div className="flex flex-wrap gap-2">
                    <Button size="xs" variant="secondary" onClick={() => exportCsv('finance')} disabled={!statement}><Download size={12} aria-hidden="true" /> CSV (finance)</Button>
                    <Button size="xs" variant="secondary" onClick={() => exportCsv('partner')} disabled={!statement}><Download size={12} aria-hidden="true" /> CSV (partner)</Button>
                    <Button size="xs" variant="secondary" onClick={() => void exportPdf('partner')} disabled={!statement}><Download size={12} aria-hidden="true" /> PDF (partner)</Button>
                    <Button size="xs" variant="secondary" onClick={() => void exportPdf('finance')} disabled={!statement}><Download size={12} aria-hidden="true" /> PDF (finance)</Button>
                  </div>
                </div>
                {!statement ? <div className="mt-4"><Loader2 className="animate-spin text-text-secondary" aria-label="Loading statement" /></div> : (
                  <>
                    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
                      <div><dt className="text-text-secondary">Gross</dt><dd className="tabular-nums text-text-primary">{formatUsdCents(statement.gross_cents)}</dd></div>
                      <div><dt className="text-text-secondary">Clawbacks netted</dt><dd className="tabular-nums text-danger">{formatUsdCents(statement.clawback_cents)}</dd></div>
                      <div><dt className="text-text-secondary">Net</dt><dd className="font-semibold tabular-nums text-text-primary">{formatUsdCents(statement.net_cents)}</dd></div>
                      <div><dt className="text-text-secondary">Held (30-day hold)</dt><dd className="tabular-nums text-text-primary">{formatUsdCents(statement.held_cents)}</dd></div>
                    </dl>
                    {check && !check.ok && (
                      <p role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
                        This statement does not add up and cannot be exported or approved: {check.problems.join('; ')}.
                      </p>
                    )}
                    {check?.ok && <p className="mt-3 text-xs text-text-secondary">Integrity check passed: net = gross + clawbacks, lines sum to the totals, every earn line equals round(base × rate).</p>}
                    {statement.status === 'paid' && statement.payment_reference && <p className="mt-2 text-xs text-text-secondary">Paid {statement.paid_at?.slice(0, 10)} · {statement.payment_method} · ref {statement.payment_reference}</p>}
                    <div className="mt-4 overflow-x-auto">
                      {statement.lines.length === 0 ? <p className="text-sm text-text-secondary">No payable entries in this period.</p> : (
                        <table className="w-full min-w-[720px] text-start text-sm">
                          <thead className="text-xs uppercase text-text-secondary">
                            <tr>{['Date', 'Type', 'Ref', 'Invoice', 'Base × rate', 'Amount'].map((h) => <th key={h} scope="col" className="px-3 py-2 text-start font-medium">{h}</th>)}</tr>
                          </thead>
                          <tbody>
                            {statement.lines.map((l) => (
                              <tr key={l.id} className="border-t border-border">
                                <td className="px-3 py-2 tabular-nums">{l.earned_at.slice(0, 10)}</td>
                                <td className="px-3 py-2">{LINE_TYPE_LABEL[l.entry_type]}{l.period_index ? ` #${l.period_index}` : ''}{l.source_kind ? ` (${l.source_kind})` : ''}</td>
                                <td className="px-3 py-2 font-mono text-xs">{l.ref}</td>
                                <td className="px-3 py-2 font-mono text-xs">{l.stripe_invoice_id ?? '—'}</td>
                                <td className="px-3 py-2 tabular-nums">{l.base_cents !== null && l.rate_pct !== null ? `${formatUsdCents(l.base_cents)} × ${l.rate_pct}%` : '—'}</td>
                                <td className={`px-3 py-2 tabular-nums ${l.amount_cents < 0 ? 'text-danger' : ''}`}>{formatUsdCents(l.amount_cents)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h3 className="text-sm font-semibold text-text-primary">Agreements</h3>
                <p className="mt-1 text-xs text-text-secondary">[COUNSEL] Contract wording is not stored here, only the reference to the signed document. Activating applies the rate and term through the existing commission guardrails.</p>
                {!agreements ? <div className="mt-3"><Loader2 className="animate-spin text-text-secondary" aria-label="Loading agreements" /></div> : agreements.length === 0 ? (
                  <p className="mt-3 text-sm text-text-secondary">No agreement on file. Statements for this partner cannot be approved until one is active.</p>
                ) : (
                  <ul className="mt-3 space-y-2 text-sm">
                    {agreements.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                        <span className="text-text-primary">v{a.version} · {a.status} · {a.revenue_share_pct}% for {a.term_months} mo · min {formatUsdCents(a.min_payout_cents)} · {a.effective_from}{a.effective_to ? ` → ${a.effective_to}` : ''}{a.document_ref ? ` · ${a.document_ref}` : ' · no document'}</span>
                        <span className="flex gap-2">
                          {a.status === 'draft' && <Button size="xs" onClick={() => activate(a)} disabled={busy}>Activate</Button>}
                          {a.status === 'active' && <Button size="xs" variant="danger" onClick={() => terminate(a)} disabled={busy}>Terminate</Button>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-4 grid gap-3 sm:grid-cols-6">
                  <label className="text-sm text-text-secondary">Rate %<input inputMode="decimal" value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} className={inputCls} /></label>
                  <label className="text-sm text-text-secondary">Months<input inputMode="numeric" value={draft.months} onChange={(e) => setDraft({ ...draft, months: e.target.value })} className={inputCls} /></label>
                  <label className="text-sm text-text-secondary">Min payout (USD)<input inputMode="decimal" value={draft.minPayout} onChange={(e) => setDraft({ ...draft, minPayout: e.target.value })} className={inputCls} /></label>
                  <label className="text-sm text-text-secondary">Starts<input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className={inputCls} /></label>
                  <label className="text-sm text-text-secondary sm:col-span-2">Signed document ref<input value={draft.docRef} maxLength={500} onChange={(e) => setDraft({ ...draft, docRef: e.target.value })} className={inputCls} /></label>
                </div>
                <div className="mt-3"><Button size="sm" variant="secondary" onClick={saveDraft} loading={busy}>Create draft agreement</Button></div>
              </div>
            </section>
          )}
        </div>
      </main>
    </>
  );
}
