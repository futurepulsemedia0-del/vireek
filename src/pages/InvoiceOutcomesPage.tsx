/**
 * Invoice recovery outcomes (owner) — /dashboard/invoice-outcomes[/:statementId]
 * Monthly statements, evidence per line, contest workflow. All states: loading, error, denied, empty, offline, partial (contested lines), success.
 * Not live-verified: written against repo conventions, typecheck/lint/e2e NOT RUN by the author.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Download, ShieldAlert, WifiOff } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useInvoiceOutcomeT } from '@/i18n/invoiceOutcomeNamespace';
import {
  downloadStatementPdf, errorCode, fetchDetail, fetchGate, fetchStatements, formatMoney, openDispute, slaStatus, validateReason, withdrawDispute, confirmInvoice,
  type DisputeRow, type LineRow, type StatementRow,
} from '@/lib/invoiceOutcomeApi';

const cardTitle = 'text-lg font-semibold text-text-primary';
const muted = 'text-sm text-text-secondary';
type Load = 'loading' | 'ready' | 'error' | 'denied';
const ACTIVE = new Set(['open', 'under_review']);

function useOnline(): boolean {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true); const down = () => setOn(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return on;
}

function LineCard({ line, label, statement, dispute, online, highlighted, onChanged }: {
  line: LineRow; label: string; statement: StatementRow; dispute: DisputeRow | undefined; online: boolean; highlighted: boolean; onChanged: () => void;
}) {
  const { t, language } = useInvoiceOutcomeT();
  const { toast } = useToast();
  const [form, setForm] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const snap = statement.snapshot.lines.find((l) => l.invoiceId === line.invoice_id);
  const money = (c: number) => formatMoney(c, statement.currency, language);
  const problem = validateReason(reason);
  const contestable = ['approved', 'invoiced', 'disputed'].includes(statement.state) && !(dispute && ACTIVE.has(dispute.state));
  const heldNow = line.held || (dispute !== undefined && ['open', 'under_review', 'upheld'].includes(dispute.state));

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); setForm(false); setReason(''); onChanged(); }
    catch (e) { toast(t(`errors.${errorCode(e as { message?: string })}`), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <li id={`line-${line.invoice_id}`} aria-current={highlighted ? 'true' : undefined} className="list-none">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold text-text-primary">{label}</h3>
          <p className="text-base font-semibold text-text-primary">{money(heldNow ? 0 : line.fee_cents)}</p>
        </div>
        <p className={muted}>{t('recovered')}: {money(line.recovered_cents)}</p>
        {snap && (
          <dl className={`${muted} mt-2 grid gap-1`}>
            <div><dt className="inline font-medium">{t('action')}: </dt><dd className="inline">{snap.evidence.actionId ?? '-'}{snap.evidence.actionAt ? ` · ${snap.evidence.actionAt.slice(0, 10)}` : ''}</dd></div>
            <div><dt className="inline font-medium">{t('payment')}: </dt><dd className="inline">{snap.evidence.paymentIds.join(', ')}</dd></div>
            {snap.evidence.confirmationBasis && <div><dd>{t(`basis.${snap.evidence.confirmationBasis}`)}</dd></div>}
          </dl>
        )}
        {heldNow && <p role="status" className="mt-2 text-sm font-medium text-text-primary">{t('held')}</p>}

        {dispute && (
          <div className="mt-3">
            <p className="text-sm font-medium text-text-primary">{t(`dispute.status.${dispute.state}`)}</p>
            <p className={muted}>{t(`dispute.sla.${slaStatus({ state: dispute.state, ackDueAt: dispute.ack_due_at, resolveDueAt: dispute.resolve_due_at, acknowledgedAt: dispute.acknowledged_at }, new Date().toISOString())}`)}
              {ACTIVE.has(dispute.state) ? ` · ${t('dispute.resolveBy', { date: new Date(dispute.resolve_due_at).toLocaleDateString(language) })}` : ''}</p>
            {dispute.resolution_note && <p className={muted}>{dispute.resolution_note}</p>}
            {ACTIVE.has(dispute.state) && (
              <Button variant="secondary" disabled={!online || busy} loading={busy} onClick={() => void run(() => withdrawDispute(dispute.id), t('success.withdrawn'))}>{t('dispute.withdraw')}</Button>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {contestable && !form && <Button variant="secondary" disabled={!online} onClick={() => setForm(true)}>{t('dispute.open')}</Button>}
          {statement.state !== 'draft' && !snap?.evidence.confirmationBasis && (
            <Button variant="ghost" disabled={!online || busy} onClick={() => void run(() => confirmInvoice(line.invoice_id), t('success.confirmed'))}>{t('confirm')}</Button>
          )}
        </div>

        {form && (
          <div className="mt-3">
            <label htmlFor={`reason-${line.id}`} className="block text-sm font-medium text-text-primary">{t('dispute.reason')}</label>
            <Textarea id={`reason-${line.id}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={4} aria-describedby={`hint-${line.id}`} aria-invalid={reason.length > 0 && problem !== null} />
            <p id={`hint-${line.id}`} className={muted}>{t('dispute.reasonHint')} {t('dispute.count', { count: reason.trim().length })}</p>
            {reason.length > 0 && problem && <p role="alert" className="text-sm text-text-primary">{problem === 'too_short' ? t('dispute.tooShort') : t('dispute.tooLong')}</p>}
            <div className="mt-2 flex gap-2">
              <Button disabled={!online || busy || problem !== null} loading={busy} onClick={() => void run(() => openDispute(line.id, reason.trim()), t('success.disputed'))}>{t('dispute.submit')}</Button>
              <Button variant="ghost" onClick={() => { setForm(false); setReason(''); }}>{t('dispute.cancel')}</Button>
            </div>
          </div>
        )}
      </Card>
    </li>
  );
}

export function InvoiceOutcomesPage() {
  const { t, language } = useInvoiceOutcomeT();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { statementId } = useParams();
  const [sp] = useSearchParams();
  const online = useOnline();
  const [load, setLoad] = useState<Load>('loading');
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [detail, setDetail] = useState<{ lines: LineRow[]; disputes: DisputeRow[]; billableCents: number | null } | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoad('loading');
    try {
      const gate = await fetchGate();
      if (!gate.global?.feature_enabled || gate.global.kill_switch || !gate.settings?.enabled || gate.settings.kill_switch) { setLoad('denied'); return; }
      setRows(await fetchStatements());
      setLoad('ready');
    } catch { setLoad('error'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const selected = useMemo(() => rows.find((r) => r.id === statementId) ?? rows[0] ?? null, [rows, statementId]);
  const loadDetail = useCallback(async () => {
    if (!selected) { setDetail(null); return; }
    try { setDetail(await fetchDetail(selected.id)); } catch { setDetail(null); toast(t('errors.generic'), 'error'); }
  }, [selected, t, toast]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const labels = useMemo(() => Object.fromEntries((selected?.snapshot.lines ?? []).map((l) => [l.invoiceId, l.invoiceLabel])), [selected]);
  const money = (c: number) => formatMoney(c, selected?.currency ?? 'USD', language);
  const highlight = sp.get('invoice');

  const body = (() => {
    if (load === 'loading') return <SkeletonCardList count={3} />;
    if (load === 'error') return <EmptyState variant="load-failed" title={t('error.title')} action={{ label: t('error.retry'), onClick: () => void refresh() }} />;
    if (load === 'denied') return <EmptyState variant="no-permission" title={t('denied.title')} description={t('denied.desc')} />;
    if (rows.length === 0 || !selected) return <EmptyState variant="no-data" title={t('empty.title')} description={t('empty.desc')} />;
    const s = selected.snapshot;
    const excluded = Object.entries(s.excludedByReason);
    return (
      <div className="grid gap-4">
        <nav aria-label={t('statements')} className="flex flex-wrap gap-2">
          {rows.map((r) => (
            <Button key={r.id} variant={r.id === selected.id ? 'primary' : 'secondary'} aria-current={r.id === selected.id ? 'page' : undefined} onClick={() => navigate(`/dashboard/invoice-outcomes/${r.id}`)}>
              {r.period} · {t(`state.${r.state}`)}
            </Button>
          ))}
        </nav>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className={cardTitle}>{selected.period} · {t(`state.${selected.state}`)}</h2>
            <Button variant="secondary" loading={pdfBusy} loadingLabel={t('downloading')} disabled={!online || pdfBusy} onClick={() => {
              setPdfBusy(true);
              void downloadStatementPdf(selected.id).catch(() => toast(t('errors.generic'), 'error')).finally(() => setPdfBusy(false));
            }}><Download aria-hidden="true" className="me-2 h-4 w-4" />{t('download')}</Button>
          </div>
          <dl className="mt-3 grid gap-1 text-sm text-text-primary">
            <div className="flex justify-between"><dt>{t('base')}</dt><dd>{money(selected.base_fee_cents)}</dd></div>
            <div className="flex justify-between"><dt>{t('outcome')}</dt><dd>{money(selected.outcome_fee_cents)}</dd></div>
            {s.adjustmentCents !== 0 && <div className="flex justify-between"><dt>{t('adjustment')}</dt><dd>{money(s.adjustmentCents)}</dd></div>}
            <div className="flex justify-between font-semibold"><dt>{t('total')}</dt><dd>{money(selected.total_cents)}</dd></div>
            {detail?.billableCents != null && detail.billableCents !== selected.total_cents && <div className="flex justify-between"><dt>{t('billable')}</dt><dd>{money(detail.billableCents)}</dd></div>}
          </dl>
          {s.zeroReason && <p className={`${muted} mt-2`}>{t(`zero.${s.zeroReason}`)}</p>}
        </Card>

        <section aria-labelledby="lines-h">
          <h2 id="lines-h" className={`${cardTitle} mb-2`}>{t('lines')}</h2>
          {detail === null ? <SkeletonCardList count={2} /> : (
            <ul className="grid gap-3 p-0">
              {detail.lines.map((l) => (
                <LineCard key={l.id} line={l} label={labels[l.invoice_id] ?? l.invoice_id} statement={selected} online={online} highlighted={highlight === l.invoice_id}
                  dispute={detail.disputes.find((d) => d.line_id === l.id)} onChanged={() => { void loadDetail(); void refresh(); }} />
              ))}
            </ul>
          )}
        </section>

        {excluded.length > 0 && (
          <Card>
            <h2 className={cardTitle}>{t('excluded.title')}</h2>
            <ul className={`${muted} mt-2`}>{excluded.map(([r, n]) => <li key={r}>{r.replace(/_/g, ' ')}: {n}</li>)}</ul>
          </Card>
        )}

        <Card>
          <h2 className={cardTitle}>{t('baseline.title')}</h2>
          <p className={muted}>{!s.baseline || s.baseline.status === 'baseline_missing' ? t('baseline.missing') : s.baseline.status === 'insufficient_data' ? t('baseline.insufficient') : t('baseline.observational')}</p>
        </Card>

        <Card>
          <h2 className={cardTitle}>{t('methodology.title')}</h2>
          <p className={muted}>{t('methodology.intro')}</p>
          <ol className={`${muted} ms-5 list-decimal`}><li>{t('methodology.c1')}</li><li>{t('methodology.c2')}</li><li>{t('methodology.c3')}</li><li>{t('methodology.c4')}</li></ol>
          <p className={`${muted} mt-2`}>{t('methodology.never')}</p>
          <p className={`${muted} mt-2`}>{t('disclaimer')}</p>
        </Card>
      </div>
    );
  })();

  return (
    <DashboardLayout>
      <main className="mx-auto grid max-w-3xl gap-4 p-4">
        <header>
          <h1 className="text-2xl font-bold text-text-primary"><ShieldAlert aria-hidden="true" className="me-2 inline h-5 w-5" />{t('title')}</h1>
          <p className={muted}>{t('subtitle')}</p>
        </header>
        {!online && <p role="status" className="flex items-center gap-2 text-sm text-text-primary"><WifiOff aria-hidden="true" className="h-4 w-4" />{t('offline')}</p>}
        <div aria-live="polite">{body}</div>
        <p className={muted}><Link to="/dashboard/results-plan">Results Plan</Link></p>
      </main>
    </DashboardLayout>
  );
}

export default InvoiceOutcomesPage;
