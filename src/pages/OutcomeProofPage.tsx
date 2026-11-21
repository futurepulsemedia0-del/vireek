import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileCheck2, Lock, AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCard } from '@/components/Skeleton';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { useOutcomeProofT } from '@/i18n/outcomeProofNamespace';
import { CONSENT_TEXT, createCase, listCases, loadCase, logExport, setConsent, type CaseBundle } from '@/lib/outcomeProof/api';
import { computeOutcome, currentConsent, publicationGate, verifyIntegrity, type ProofCase } from '@/lib/outcomeProof/method';
import { buildDocument, formatMoney, formatRatioPct, renderMarkdown, type RenderMode } from '@/lib/outcomeProof/render';
import { buildCasePdf } from '@/lib/outcomeProof/pdf';
import { parseMoneyToCents } from '@/lib/pay';

const FIELD = 'mt-1 block w-full min-h-11 rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary';
const LABEL = 'block text-sm font-medium text-text-primary';
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function download(name: string, mime: string, data: BlobPart) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'case';

function CreateForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { t } = useOutcomeProofT();
  const [title, setTitle] = useState(''); const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  const [currency, setCurrency] = useState('USD'); const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const cents = cost.trim() === '' ? null : parseMoneyToCents(cost);
      if (cost.trim() !== '' && (cents === null || !(cents > 0))) throw new Error(t('create.costLabel'));
      onCreated(await createCase({ title: title.trim(), start, end, currency: currency.trim().toUpperCase(), costCents: cents }));
    } catch (err) { setError(t('create.failed', { message: msg(err) })); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="rounded-xl border border-border bg-bg-secondary p-4 space-y-3">
      <h2 className="text-base font-semibold text-text-primary">{t('create.heading')}</h2>
      <label className={LABEL}>{t('create.titleLabel')}<input className={FIELD} value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={120} /></label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={LABEL}>{t('create.startLabel')}<input type="date" className={FIELD} value={start} onChange={(e) => setStart(e.target.value)} required /></label>
        <label className={LABEL}>{t('create.endLabel')}<input type="date" className={FIELD} value={end} onChange={(e) => setEnd(e.target.value)} required /></label>
        <label className={LABEL}>{t('create.currencyLabel')}<input className={FIELD} value={currency} onChange={(e) => setCurrency(e.target.value)} required pattern="[A-Za-z]{3}" maxLength={3} /></label>
      </div>
      <label className={LABEL}>{t('create.costLabel')}<input className={FIELD} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} aria-describedby="cost-help" /></label>
      <p id="cost-help" className="text-xs text-text-secondary">{t('create.costHelp')}</p>
      {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? t('create.creating') : t('create.submit')}</Button>
    </form>
  );
}

function ConsentPanel({ bundle, canConsent, onChanged }: { bundle: CaseBundle; canConsent: boolean; onChanged: () => void }) {
  const { t } = useOutcomeProofT();
  const [biz, setBiz] = useState(false); const [person, setPerson] = useState(false); const [quote, setQuote] = useState(false);
  const [quoteText, setQuoteText] = useState(''); const [name, setName] = useState(''); const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const cur = currentConsent(bundle.consents);
  const send = async (decision: 'granted' | 'revoked') => {
    setBusy(true); setError(null); setStatus(null);
    try {
      await setConsent({ caseId: bundle.case.id, decision, allowBusinessName: biz, allowPersonName: person, allowQuote: quote, quote: quote && quoteText.trim() ? quoteText.trim() : null, signerName: name.trim(), signerRole: role.trim() || null });
      setStatus(t('consent.saved')); onChanged();
    } catch (e) { setError(t('consent.failed', { message: msg(e) })); } finally { setBusy(false); }
  };
  const line = cur === null ? t('consent.status.none')
    : cur.decision === 'granted' ? t('consent.status.granted', { date: cur.decidedAt.slice(0, 10), name: cur.signerName })
    : t('consent.status.revoked', { date: cur.decidedAt.slice(0, 10) });
  return (
    <section className="rounded-xl border border-border bg-bg-secondary p-4 space-y-3" aria-labelledby="consent-h">
      <h2 id="consent-h" className="text-base font-semibold text-text-primary">{t('consent.heading')}</h2>
      <p className="text-sm text-text-secondary" role="status">{line}</p>
      {!canConsent ? <p className="text-sm text-text-secondary">{t('consent.ownerOnly')}</p> : (
        <>
          <p className="text-xs font-medium text-text-primary">{t('consent.textLabel')}</p>
          <p className="whitespace-pre-line rounded-lg bg-bg-primary p-3 text-xs text-text-secondary">{CONSENT_TEXT}</p>
          <div className="space-y-2">
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={biz} onChange={(e) => setBiz(e.target.checked)} />{t('consent.businessName')}</label>
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={person} onChange={(e) => setPerson(e.target.checked)} />{t('consent.personName')}</label>
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={quote} onChange={(e) => setQuote(e.target.checked)} />{t('consent.quote')}</label>
            {quote && <label className={LABEL}>{t('consent.quoteLabel')}<textarea className={FIELD} rows={3} maxLength={500} value={quoteText} onChange={(e) => setQuoteText(e.target.value)} /></label>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={LABEL}>{t('consent.signerName')}<input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
            <label className={LABEL}>{t('consent.signerRole')}<input className={FIELD} value={role} onChange={(e) => setRole(e.target.value)} maxLength={80} /></label>
          </div>
          {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
          {status && <p role="status" className="text-sm text-success-500">{status}</p>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || name.trim().length < 2} onClick={() => void send('granted')}>{t('consent.grant')}</Button>
            <Button variant="secondary" disabled={busy || name.trim().length < 2 || cur?.decision !== 'granted'} onClick={() => void send('revoked')}>{t('consent.revoke')}</Button>
          </div>
        </>
      )}
    </section>
  );
}

function CaseDetail({ id, ownerId, isOwner, onBack }: { id: string; ownerId: string; isOwner: boolean; onBack: () => void }) {
  const { t } = useOutcomeProofT();
  const [bundle, setBundle] = useState<CaseBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    loadCase(id, ownerId).then(setBundle).catch((e: unknown) => setError(msg(e)));
  }, [id, ownerId]);
  useEffect(() => { setBundle(null); load(); }, [load]);

  const derived = useMemo(() => {
    if (!bundle) return null;
    const outcome = computeOutcome(bundle.case, bundle.sources);
    return { outcome, gate: publicationGate(bundle.case, bundle.sources, bundle.consents, outcome), intact: verifyIntegrity(bundle.case, bundle.sources) };
  }, [bundle]);

  if (error) return <EmptyStateError icon={AlertTriangle} description={t('detail.loadFailed', { message: error })} onRetry={load} />;
  if (!bundle || !derived) return <SkeletonCard rows={4} />;
  const c: ProofCase = bundle.case; const { outcome, gate, intact } = derived;
  const doc = buildDocument(c, bundle.sources, bundle.consents, 'audit', bundle.businessName);
  const reasonText = outcome.status === 'not_enough_data' ? outcome.reasons.join(', ') : '';

  const exportAs = async (format: 'markdown' | 'pdf', mode: RenderMode) => {
    setExportError(null);
    try {
      await logExport(c.id, format); // audit first: no export without a log row
      const name = `${slug(c.title)}-${mode}`;
      if (format === 'markdown') download(`${name}.md`, 'text/markdown;charset=utf-8', renderMarkdown(c, bundle.sources, bundle.consents, mode, bundle.businessName));
      else download(`${name}.pdf`, 'application/pdf', buildCasePdf(c, bundle.sources, bundle.consents, mode, bundle.businessName).output('arraybuffer'));
    } catch (e) { setExportError(t('export.failed', { message: msg(e) })); }
  };

  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className="min-h-11 text-sm text-accent underline">{t('detail.back')}</button>
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{c.title}</h2>
        <p className="text-sm text-text-secondary">{t('list.period', { start: c.periodStart, end: c.periodEnd })} · {c.currency}</p>
        <p className="mt-1 text-sm font-semibold text-text-primary">{c.verificationLevel === 'independently_verified' ? doc.verification : t('notAudited')}</p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        {[[t('detail.measured'), formatMoney(outcome.totals.measuredCents, c.currency)], [t('detail.estimated'), formatMoney(outcome.totals.estimatedCents, c.currency)],
          [t('detail.saved'), doc.facts[2].value], [t('detail.events'), String(outcome.totals.count)]].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-border bg-bg-secondary p-4"><dt className="text-xs text-text-secondary">{k}</dt><dd className="mt-1 text-xl font-semibold text-text-primary">{v}</dd></div>
        ))}
      </dl>
      <p className="text-sm text-text-primary">
        {outcome.status === 'ok'
          ? t('detail.return', { low: formatRatioPct(outcome.roiLow), high: formatRatioPct(outcome.roiHigh) })
          : t('detail.noReturn', { reasons: reasonText })}
      </p>
      <p className={`text-xs ${intact ? 'text-text-secondary' : 'text-danger-500'}`} role={intact ? undefined : 'alert'}>
        {intact ? t('detail.integrityOk') : t('detail.integrityBad')} {t('detail.hash')}: <span className="break-all font-mono">{c.snapshotSha256}</span>
      </p>

      <ConsentPanel bundle={bundle} canConsent={isOwner} onChanged={load} />

      <section className="rounded-xl border border-border bg-bg-secondary p-4 space-y-3" aria-labelledby="export-h">
        <h2 id="export-h" className="text-base font-semibold text-text-primary">{t('export.heading')}</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void exportAs('markdown', 'audit')}>{t('export.markdownAudit')}</Button>
          <Button variant="secondary" onClick={() => void exportAs('pdf', 'audit')}>{t('export.pdfAudit')}</Button>
          <Button disabled={!gate.mayPublish} onClick={() => void exportAs('markdown', 'public')}>{t('export.markdownPublic')}</Button>
          <Button disabled={!gate.mayPublish} onClick={() => void exportAs('pdf', 'public')}>{t('export.pdfPublic')}</Button>
        </div>
        {!gate.mayPublish && <p className="text-xs text-text-secondary">{t('export.blocked', { blocks: gate.blocks.map((b) => t(`consent.blocks.${b}`)).join(', ') })}</p>}
        {exportError && <p role="alert" className="text-sm text-danger-500">{exportError}</p>}
      </section>

      <section aria-labelledby="src-h">
        <h2 id="src-h" className="text-base font-semibold text-text-primary">{t('detail.sources')}</h2>
        <div className="mt-2 overflow-x-auto rounded-xl border border-border">
          <table className="min-w-full text-start text-xs">
            <thead className="bg-bg-secondary text-text-secondary"><tr>{(['date', 'type', 'amount', 'confidence', 'ref', 'status'] as const).map((k) => <th key={k} scope="col" className="px-3 py-2 text-start font-medium">{t(`detail.sourceCol.${k}`)}</th>)}</tr></thead>
            <tbody>{doc.sourceRows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2">{r.date}</td><td className="px-3 py-2">{r.type}</td><td className="px-3 py-2">{r.amount}</td>
                <td className="px-3 py-2">{r.confidence}</td><td className="px-3 py-2 break-all">{r.evidenceRef}</td>
                <td className="px-3 py-2">{r.status.startsWith('excluded') ? t('detail.excluded', { reason: r.status.slice(10) }) : t('detail.included')}</td>
              </tr>))}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function OutcomeProofPage() {
  const { t } = useOutcomeProofT();
  const { isOwner, permissions, teamMember, user, loading, profileLoading } = useAuth();
  const canAccess = isOwner || permissions.can_view_billing;
  const ownerId = teamMember?.account_owner_id ?? user?.id ?? '';
  const [cases, setCases] = useState<ProofCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(() => { setError(null); listCases().then(setCases).catch((e: unknown) => setError(msg(e))); }, []);
  useEffect(() => { if (canAccess) refresh(); }, [canAccess, refresh]);

  if (loading || profileLoading) return <DashboardLayout activeLabel="Outcome Cases"><SkeletonCard rows={4} /></DashboardLayout>;
  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Outcome Cases">
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-20 text-center">
          <Lock size={26} aria-hidden="true" />
          <h1 className="mt-4 text-lg font-semibold text-text-primary">{t('noAccess.title')}</h1>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">{t('noAccess.body')}</p>
        </div>
      </DashboardLayout>
    );
  }
  return (
    <DashboardLayout activeLabel="Outcome Cases">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">{t('title')}</h1>
        <p className="text-sm text-text-secondary">{t('subtitle')}</p>
      </div>
      {openId ? <CaseDetail id={openId} ownerId={ownerId} isOwner={isOwner} onBack={() => { setOpenId(null); refresh(); }} /> : (
        <div className="space-y-6">
          <CreateForm onCreated={(id) => { refresh(); setOpenId(id); }} />
          <section aria-labelledby="cases-h">
            <h2 id="cases-h" className="text-base font-semibold text-text-primary">{t('list.heading')}</h2>
            {error ? <EmptyStateError icon={AlertTriangle} description={error} onRetry={refresh} />
              : cases === null ? <SkeletonCard rows={3} />
              : cases.length === 0 ? <EmptyState icon={FileCheck2} title={t('list.emptyTitle')} description={t('list.emptyBody')} />
              : (
                <ul className="mt-2 space-y-2">
                  {cases.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary p-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text-primary">{c.title}</p>
                        <p className="text-xs text-text-secondary">{t('list.period', { start: c.periodStart, end: c.periodEnd })} · {c.verificationLevel === 'independently_verified' ? t('list.verified') : t('notAudited')}</p>
                      </div>
                      <Button variant="secondary" size="sm" onClick={() => setOpenId(c.id)}>{t('list.open')}</Button>
                    </li>))}
                </ul>)}
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}
