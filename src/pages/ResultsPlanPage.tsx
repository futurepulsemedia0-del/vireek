/**
 * Results Plan (owner) — /dashboard/results-plan
 * Pay for verified booked jobs. Every charge expands into its evidence chain; disputes within 14 days; CSV statement.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import {
  chargesToLines, currentMonth, disputeWindowOpen, downloadCsv, enroll, fetchAccount, fetchCallEvidence, fetchCharges, fetchDisputes, fetchLedgerForJob,
  flagJob, formatMoney, openDispute, startCheckout, statementCsv, summarize, verifyChain,
  type AccountRow, type ChargeRow, type DisputeRow, type LedgerRow, type TermsRow,
} from '@/lib/resultsPlanApi';

const cardTitle = 'text-lg font-semibold text-text-primary';
const muted = 'text-sm text-text-secondary';

function monthShift(m: string, d: number): string {
  const [y, mo] = m.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1 + d, 1));
  return dt.toISOString().slice(0, 7);
}

function Evidence({ charge, onDisputed, disputed }: { charge: ChargeRow; disputed: DisputeRow | undefined; onDisputed: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [call, setCall] = useState<Awaited<ReturnType<typeof fetchCallEvidence>>>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [l, c] = await Promise.all([fetchLedgerForJob(charge.job_id), fetchCallEvidence(charge.job_id)]);
        if (alive) { setLedger(l); setCall(c); }
      } catch { if (alive) setLedger([]); }
    })();
    return () => { alive = false; };
  }, [charge.job_id]);

  const canDispute = !disputed && (charge.status === 'pending' || charge.status === 'posted') && disputeWindowOpen(charge.posted_at ?? charge.created_at, new Date().toISOString());
  const submit = async () => {
    setBusy(true);
    try {
      const r = await openDispute(charge.id, reason.trim());
      toast(r.outcome === 'auto_credited' ? t('resultsPlan.disputeCredited', 'The evidence could not support this charge, so it was credited.') : t('resultsPlan.disputeReview', 'Dispute received. A reviewer will decide.'), 'success');
      setShowForm(false); onDisputed();
    } catch { toast(t('resultsPlan.disputeFailed', 'Could not open the dispute.'), 'error'); } finally { setBusy(false); }
  };
  const flag = async (kind: 'spam' | 'wrong_number' | 'test') => {
    try { await flagJob(charge.job_id, kind, reason.trim()); toast(t('resultsPlan.flagSent', 'Sent for review. This does not change billing until our team confirms it.'), 'success'); }
    catch { toast(t('resultsPlan.flagFailed', 'Could not send.'), 'error'); }
  };

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      <h4 className="text-sm font-semibold text-text-primary">{t('resultsPlan.evidence', 'Evidence chain')}</h4>
      {ledger === null ? <p className={muted}>{t('ui.loading', 'Loading…')}</p> : (
        <ol className="space-y-2">
          {ledger.map((e) => (
            <li key={e.id} className="rounded-xl bg-bg-secondary p-3 text-sm text-text-primary">
              <span className="font-semibold">{e.event_type.replace(/_/g, ' ')}</span>
              <span className="ms-2 text-text-secondary">{new Date(e.created_at).toLocaleString()}</span>
              <span className="ms-2 text-text-secondary">#{e.seq} · {e.rule_version}</span>
              <span className="mt-1 block break-all font-mono text-xs text-text-tertiary">{e.hash.slice(0, 16)}…</span>
            </li>
          ))}
          {ledger.length === 0 && <li className={muted}>{t('resultsPlan.noEvents', 'No ledger events yet.')}</li>}
        </ol>
      )}
      {call ? (
        <div className="rounded-xl border border-border p-3 text-sm text-text-primary">
          <p className="font-semibold">{t('resultsPlan.call', 'First contact')} — {new Date(call.call_datetime).toLocaleString()}</p>
          {call.transcript && <p className="mt-1 text-text-secondary">“{call.transcript.replace(/\s+/g, ' ').slice(0, 280)}”</p>}
          {call.recording_url && <a className="mt-1 inline-block text-accent underline" href={call.recording_url} target="_blank" rel="noopener noreferrer">{t('resultsPlan.recording', 'Listen to the recording')}</a>}
        </div>
      ) : <p className={muted}>{t('resultsPlan.noCall', 'No call record is linked to this job.')}</p>}
      {disputed ? (
        <p className="text-sm text-text-primary" role="status">{t('resultsPlan.disputeStatus', 'Dispute')}: <strong>{disputed.status.replace(/_/g, ' ')}</strong>{disputed.decision_note ? ` — ${disputed.decision_note}` : ''}</p>
      ) : canDispute ? (
        showForm ? (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-primary" htmlFor={`reason-${charge.id}`}>{t('resultsPlan.reasonLabel', 'Why should this job not be billed?')}</label>
            <Textarea id={`reason-${charge.id}`} value={reason} maxLength={1000} onChange={(e: { target: { value: string } }) => setReason(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={submit} loading={busy} disabled={reason.trim().length < 3}>{t('resultsPlan.submitDispute', 'Submit dispute')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>{t('common.cancel', 'Cancel')}</Button>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="xs" variant="secondary" onClick={() => void flag('spam')}>{t('resultsPlan.markSpam', 'This was spam')}</Button>
              <Button size="xs" variant="secondary" onClick={() => void flag('wrong_number')}>{t('resultsPlan.markWrong', 'Wrong number')}</Button>
              <Button size="xs" variant="secondary" onClick={() => void flag('test')}>{t('resultsPlan.markTest', 'Internal test')}</Button>
            </div>
          </div>
        ) : <Button size="sm" variant="secondary" onClick={() => setShowForm(true)}>{t('resultsPlan.dispute', 'Dispute this job')}</Button>
      ) : null}
    </div>
  );
}

export function ResultsPlanPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<AccountRow | null>(null);
  const [terms, setTerms] = useState<TermsRow | null>(null);
  const [month, setMonth] = useState(currentMonth());
  const [charges, setCharges] = useState<ChargeRow[]>([]);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState<string | null>(null);
  const [neverExceed, setNeverExceed] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const a = await fetchAccount();
      setAccount(a.account); setTerms(a.terms);
      if (a.account) { const [c, d] = await Promise.all([fetchCharges(month), fetchDisputes()]); setCharges(c); setDisputes(d); }
    } catch { toast(t('resultsPlan.loadFailed', 'Could not load the Results Plan.'), 'error'); } finally { setLoading(false); }
  }, [month, toast, t]);
  useEffect(() => { void load(); }, [load]);

  const currency = terms?.currency ?? 'USD';
  const summary = useMemo(() => summarize(chargesToLines(charges, () => ''), terms?.base_fee_cents ?? 0, null, null), [charges, terms]);
  const disputeByCharge = useMemo(() => new Map(disputes.map((d) => [d.charge_id, d])), [disputes]);
  const ceiling = terms ? Math.min(...[account?.monthly_cap_cents, terms.monthly_cap_cents, account?.never_exceed_flat && account.flat_plan_cents ? account.flat_plan_cents - terms.base_fee_cents : null].filter((x): x is number => typeof x === 'number' && x > 0), Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  const pct = Number.isFinite(ceiling) && ceiling > 0 ? Math.min(100, Math.round((summary.billedCents / ceiling) * 100)) : null;

  const act = async (fn: () => Promise<{ ok?: boolean; url?: string; error?: string }>, ok: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.error) { toast(r.error, 'error'); return; }
      if (r.url) { window.location.assign(r.url); return; }
      toast(ok, 'success'); await load();
    } finally { setBusy(false); }
  };
  const runVerify = async () => {
    if (!user) return;
    try { const r = await verifyChain(user.id); setChain(r.ok ? t('resultsPlan.chainOk', 'Ledger verified: {{n}} entries, no tampering detected.', { n: r.checked }) : t('resultsPlan.chainBad', 'Integrity problem at entry #{{n}}. Contact support.', { n: r.first_bad_seq })); }
    catch { setChain(t('resultsPlan.chainErr', 'Could not verify right now.')); }
  };

  return (
    <DashboardLayout activeLabel="Results Plan">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold text-text-primary">{t('resultsPlan.title', 'Results Plan')}</h1>
          <p className={muted}>{t('resultsPlan.subtitle', 'Pay for verified booked jobs. Every charge shows the evidence behind it.')} <Link className="text-accent underline" to="/how-we-verify">{t('resultsPlan.howVerify', 'How we verify a job')}</Link></p>
        </header>
        {params.get('checkout') === 'success' && <p role="status" className="rounded-xl bg-bg-secondary p-3 text-sm text-text-primary">{t('resultsPlan.checkoutDone', 'Thanks. Your plan activates as soon as the payment is confirmed.')}</p>}

        {loading ? <SkeletonCardList count={3} /> : !account ? (
          terms === null ? (
            <EmptyState variant="no-data" title={t('resultsPlan.notAvailable', 'Not available yet')} description={t('resultsPlan.notAvailableBody', 'The Results Plan has not been opened for your account. Flat plans keep working as usual.')} />
          ) : (
            <Card interactive={false} className="space-y-3 p-5">
              <h2 className={cardTitle}>{t('resultsPlan.enrollTitle', 'Switch to paying per result')}</h2>
              <p className={muted}>{t('resultsPlan.enrollBody', 'Opt-in only. Nothing changes on your current plan until you confirm.')}</p>
              <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={neverExceed} onChange={(e: { target: { checked: boolean } }) => setNeverExceed(e.target.checked)} />{t('resultsPlan.neverExceed', 'Never pay more than my current flat plan')}</label>
              <Button loading={busy} onClick={() => act(() => enroll(neverExceed), t('resultsPlan.enrolled', 'Saved.'))}>{t('resultsPlan.continue', 'Continue')}</Button>
            </Card>
          )
        ) : (
          <>
            <Card interactive={false} className="space-y-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className={cardTitle}>{t('resultsPlan.status', 'Status')}: {account.status}</h2>
                {account.status === 'draft' && terms && <Button loading={busy} onClick={() => act(() => startCheckout(true), t('resultsPlan.started', 'Started.'))}>{t('resultsPlan.activate', 'Activate Results Plan')}</Button>}
              </div>
              {account.status === 'paused' && <p className={muted}>{t('resultsPlan.paused', 'Billing is paused on your account.')}{account.paused_reason ? ` ${account.paused_reason}` : ''}</p>}
              {terms && <p className={muted}>{t('resultsPlan.rate', 'Per verified job')}: {formatMoney(terms.per_job_cents, currency)}{terms.base_fee_cents > 0 ? ` + ${formatMoney(terms.base_fee_cents, currency)} / ${t('resultsPlan.month', 'month')}` : ''}</p>}
              {pct !== null && (
                <div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-bg-secondary" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('resultsPlan.capMeter', 'Share of your monthly limit used')}>
                    <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  <p className={`${muted} mt-1`}>{pct}% {t('resultsPlan.ofLimit', 'of your monthly limit')} ({formatMoney(ceiling, currency)})</p>
                </div>
              )}
            </Card>

            <Card interactive={false} className="space-y-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className={cardTitle}>{t('resultsPlan.summary', 'Pay vs. value')} — {month}</h2>
                <div className="flex gap-2">
                  <Button size="xs" variant="ghost" onClick={() => setMonth(monthShift(month, -1))}>{t('common.previous', 'Previous')}</Button>
                  <Button size="xs" variant="ghost" disabled={month >= currentMonth()} onClick={() => setMonth(monthShift(month, 1))}>{t('common.next', 'Next')}</Button>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><dt className="text-text-secondary">{t('resultsPlan.verifiedJobs', 'Verified jobs')}</dt><dd className="text-xl font-bold text-text-primary">{summary.verifiedJobs}</dd></div>
                <div><dt className="text-text-secondary">{t('resultsPlan.charged', 'Charged')}</dt><dd className="text-xl font-bold text-text-primary">{formatMoney(summary.netCents, currency)}</dd></div>
                <div><dt className="text-text-secondary">{t('resultsPlan.perJob', 'Effective cost per job')}</dt><dd className="text-xl font-bold text-text-primary">{summary.effectiveCostPerJobCents === null ? '—' : formatMoney(summary.effectiveCostPerJobCents, currency)}</dd></div>
                <div><dt className="text-text-secondary">{t('resultsPlan.credited', 'Credited')}</dt><dd className="text-xl font-bold text-text-primary">{formatMoney(summary.creditedCents, currency)}</dd></div>
              </dl>
              <p className={muted}>{t('resultsPlan.waived', 'Waived by your limits')}: {formatMoney(summary.waivedByCapsCents, currency)}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => downloadCsv(`vireek-results-${month}.csv`, statementCsv(chargesToLines(charges, (id) => id.slice(0, 8)), currency))}><Download className="h-4 w-4" aria-hidden="true" />{t('resultsPlan.csv', 'Download statement (CSV)')}</Button>
                <Button size="sm" variant="ghost" onClick={runVerify}><ShieldCheck className="h-4 w-4" aria-hidden="true" />{t('resultsPlan.verify', 'Verify ledger integrity')}</Button>
              </div>
              {chain && <p role="status" className="text-sm text-text-primary">{chain}</p>}
            </Card>

            <section aria-labelledby="rp-ledger" className="space-y-3">
              <h2 id="rp-ledger" className={cardTitle}>{t('resultsPlan.ledger', 'Proof Ledger')}</h2>
              {charges.length === 0 ? <EmptyState variant="no-data" title={t('resultsPlan.noCharges', 'No verified jobs this month')} description={t('resultsPlan.noChargesBody', 'When Sarah books a job that passes verification, it appears here with its evidence.')} /> : charges.map((c) => (
                <Card key={c.id} interactive={false} className="p-4">
                  <button type="button" className="focus-ring flex w-full items-center justify-between gap-3 text-start" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
                    <span className="text-sm text-text-primary"><strong>{new Date(c.verified_at).toLocaleDateString()}</strong> · {c.job_type ?? t('resultsPlan.job', 'Job')} · {c.status}</span>
                    <span className="text-sm font-semibold text-text-primary">{c.amount_cents === null ? '—' : formatMoney(c.amount_cents, currency)}</span>
                  </button>
                  {c.bound_by && c.bound_by !== 'none' && <p className={`${muted} mt-1`}>{t('resultsPlan.boundBy', 'Reduced by your limit')}: {c.bound_by.replace(/_/g, ' ')}</p>}
                  {open === c.id && <Evidence charge={c} disputed={disputeByCharge.get(c.id)} onDisputed={() => void load()} />}
                </Card>
              ))}
            </section>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
