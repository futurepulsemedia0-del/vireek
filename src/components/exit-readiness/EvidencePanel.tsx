import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronDown, ChevronUp, CircleHelp, FileSpreadsheet, FileText, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useExitT } from '@/i18n/exitReadyNamespace';
import { formatDateTime } from '@/lib/format';
import type { AddBack } from '@/lib/exitReadiness';
import {
  centsLabel, diffRuns, formatHeadline, headline, shortHash,
  type ChecklistItem, type LeverMovement, type LineageRun, type ReconItem, type Signal,
} from '@/lib/exitLineage';
import type { EvidenceRow, OwnerDocument, VerifyResult } from '@/lib/exitReadyApi';
import { EstimateBanner, ScoreBar, StatusPill, selectClass } from './shared';

interface Props {
  unavailable: boolean;
  run: LineageRun | null;
  previousRun: LineageRun | null;
  checklist: ChecklistItem[];
  evidenceScore: number | null;
  signals: Signal[];
  moved: LeverMovement[];
  hasTwoSnapshots: boolean;
  running: boolean;
  onRun: () => void;
  onVerify: (factId: string) => Promise<VerifyResult>;
  exporting: 'xlsx' | 'pdf' | null;
  onExport: (kind: 'xlsx' | 'pdf') => void;
  addBacks: AddBack[];
  evidenceRows: EvidenceRow[];
  documents: OwnerDocument[];
  onAttach: (addbackId: string, documentId: string) => Promise<void>;
  onDetach: (evidenceId: string) => Promise<void>;
}

const RECON_STYLE: Record<ReconItem['status'], string> = {
  match: 'bg-success/10 text-success',
  difference: 'bg-danger/10 text-danger',
  unavailable: 'bg-bg-tertiary text-text-secondary',
};

export function EvidencePanel(p: Props) {
  const { t } = useExitT();
  const [open, setOpen] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, VerifyResult | 'error'>>({});
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busyAddback, setBusyAddback] = useState<string | null>(null);

  if (p.unavailable) {
    return <EmptyState icon={ShieldCheck} title={t('evidence.title')} description={t('common.unavailable')} />;
  }

  const verify = async (id: string) => {
    setVerifying(id);
    try {
      const r = await p.onVerify(id);
      setResults((s) => ({ ...s, [id]: r }));
    } catch {
      setResults((s) => ({ ...s, [id]: 'error' }));
    } finally {
      setVerifying(null);
    }
  };

  const changes = p.run ? diffRuns(p.previousRun, p.run) : [];
  const attach = async (addbackId: string) => {
    const documentId = pick[addbackId];
    if (!documentId) return;
    setBusyAddback(addbackId);
    try {
      await p.onAttach(addbackId, documentId);
      setPick((s) => ({ ...s, [addbackId]: '' }));
    } finally {
      setBusyAddback(null);
    }
  };

  return (
    <div className="space-y-6">
      <EstimateBanner compact />

      <Card>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-text-primary">{t('evidence.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('evidence.intro')}</p>
            {p.run && (
              <p className="mt-2 text-xs text-text-secondary">
                {t('evidence.asOf', { when: formatDateTime(p.run.asOf) })}
                {p.run.runHash && <> · {t('evidence.runHash')}: <code className="rounded bg-bg-tertiary px-1.5 py-0.5">{shortHash(p.run.runHash)}</code></>}
              </p>
            )}
          </div>
          <Button size="sm" onClick={p.onRun} disabled={p.running} aria-busy={p.running}>
            {p.running ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}{' '}
            {p.running ? t('evidence.running') : p.run ? t('evidence.runAgain') : t('evidence.run')}
          </Button>
        </div>
        {!p.run && <p className="mt-4 rounded-xl bg-bg-tertiary px-3 py-3 text-sm text-text-secondary">{t('evidence.noRun')}</p>}
      </Card>

      {p.run && (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <p className="text-xs text-text-secondary">{t('evidence.evidenceScore')}</p>
                <p className="text-3xl font-bold text-text-primary">{p.evidenceScore === null ? '—' : p.evidenceScore}<span className="text-sm font-normal text-text-secondary"> / 100</span></p>
              </div>
              <div className="min-w-[10rem] flex-1">
                <ScoreBar score={p.evidenceScore} />
                <p className="mt-1 text-[11px] text-text-secondary">{t('evidence.evidenceScoreHint')}</p>
              </div>
            </div>
            <h3 className="mb-2 mt-5 text-sm font-semibold text-text-primary">{t('evidence.checklistTitle')}</h3>
            <ul className="space-y-2">
              {p.checklist.map((c) => (
                <li key={c.key} className="flex items-start gap-3 rounded-xl border border-border px-3 py-2.5">
                  {c.status === 'ok' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
                    : c.status === 'gap' ? <TriangleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
                    : <CircleHelp size={16} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary">
                      {c.title} <span className="sr-only">({t(`evidence.${c.status}`)})</span>
                    </p>
                    <p className="text-xs text-text-secondary">{c.detail}</p>
                  </div>
                  {c.status !== 'ok' && c.fixPath && c.fixLabel && (
                    <Link to={c.fixPath} className="focus-ring shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline">{t('evidence.fix')}: {c.fixLabel}</Link>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h3 className="mb-3 text-sm font-semibold text-text-primary">{t('evidence.factsTitle')}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t('evidence.factsTitle')}</caption>
                <thead>
                  <tr className="border-b border-border text-start text-xs text-text-secondary">
                    <th scope="col" className="py-2 pe-3 text-start font-medium">{t('evidence.colMetric')}</th>
                    <th scope="col" className="py-2 pe-3 text-start font-medium">{t('evidence.colHeadline')}</th>
                    <th scope="col" className="py-2 pe-3 text-start font-medium">{t('evidence.colRecords')}</th>
                    <th scope="col" className="py-2 text-start font-medium">{t('evidence.colDetails')}</th>
                  </tr>
                </thead>
                <tbody>
                  {p.run.facts.map((f) => {
                    const isOpen = open === f.id;
                    const res = results[f.id];
                    return (
                      <Fragment key={f.id}>
                        <tr className="border-b border-border/60">
                          <th scope="row" className="py-2 pe-3 text-start font-medium text-text-primary">{f.label}</th>
                          <td className="py-2 pe-3 text-text-primary">{formatHeadline(f.metricKey, headline(f))}</td>
                          <td className="py-2 pe-3 text-text-secondary">{f.sourceCount}</td>
                          <td className="py-2">
                            <button type="button" className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent" aria-expanded={isOpen} aria-controls={`fact-${f.id}`} onClick={() => setOpen(isOpen ? null : f.id)}>
                              {isOpen ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />} {isOpen ? t('evidence.hideDetails') : t('evidence.details')}
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={4} className="bg-bg-secondary px-3 py-3">
                              <dl id={`fact-${f.id}`} className="space-y-2 text-xs">
                                <div><dt className="font-medium text-text-primary">{t('evidence.logic')}</dt><dd className="break-words text-text-secondary">{f.logicText}</dd></div>
                                <div><dt className="font-medium text-text-primary">{t('evidence.source')}</dt><dd className="text-text-secondary">{f.sourceTable} · {t('common.records', { count: f.sourceCount })} · {t('evidence.asOf', { when: formatDateTime(f.asOf) })}</dd></div>
                                <div><dt className="font-medium text-text-primary">{t('evidence.hash')}</dt><dd><code className="break-all text-text-secondary">{f.contentHash}</code></dd></div>
                              </dl>
                              <div className="mt-3 flex flex-wrap items-center gap-3">
                                <Button size="sm" variant="secondary" onClick={() => void verify(f.id)} disabled={verifying === f.id} aria-busy={verifying === f.id}>
                                  {verifying === f.id ? t('evidence.verifying') : t('evidence.verify')}
                                </Button>
                                <p role="status" className={`text-xs ${res && res !== 'error' && res.matches ? 'text-success' : 'text-text-secondary'}`}>
                                  {res === 'error' ? t('evidence.verifyError')
                                    : res ? (res.matches ? t('evidence.verifiedMatch') : t('evidence.verifiedDrift', { stored: res.storedCount, now: res.recomputedCount }))
                                    : ''}
                                </p>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <h3 className="text-sm font-semibold text-text-primary">{t('evidence.reconTitle')}</h3>
            <p className="mb-3 text-xs text-text-secondary">{t('evidence.reconIntro')}</p>
            <ul className="space-y-3">
              {p.run.reconciliation.map((r) => (
                <li key={r.key} className="rounded-xl border border-border px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 text-sm font-medium text-text-primary">{r.label}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${RECON_STYLE[r.status]}`}>
                      {r.status === 'match' ? t('evidence.statusMatch') : r.status === 'difference' ? t('evidence.statusDifference') : t('evidence.statusUnavailable')}
                    </span>
                  </div>
                  <dl className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                    <div><dt className="text-text-secondary">{r.leftLabel || t('evidence.left')}</dt><dd className="font-medium text-text-primary">{centsLabel(r.leftCents)}</dd></div>
                    <div><dt className="text-text-secondary">{r.rightLabel || t('evidence.right')}</dt><dd className="font-medium text-text-primary">{centsLabel(r.rightCents)}</dd></div>
                    <div><dt className="text-text-secondary">{t('evidence.diff')}</dt><dd className="font-medium text-text-primary">{centsLabel(r.diffCents)}</dd></div>
                  </dl>
                  {r.note && <p className="mt-2 text-[11px] text-text-secondary">{r.note}</p>}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h3 className="text-sm font-semibold text-text-primary">{t('evidence.signalsTitle')}</h3>
            <p className="mb-3 text-xs text-text-secondary">{t('evidence.signalsNote')}</p>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {p.signals.map((s) => (
                <li key={s.key} className="rounded-xl border border-border px-3 py-3">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 text-sm font-medium text-text-primary">{s.label}</p>
                    {s.score === null ? <span className="text-[10px] text-text-secondary">{t('evidence.noScore')}</span> : <StatusPill status={s.status} />}
                  </div>
                  {s.score !== null && <div className="mt-2"><ScoreBar score={s.score} /></div>}
                  <p className="mt-2 text-xs text-text-primary">{s.display}</p>
                  <p className="mt-1 text-[11px] text-text-secondary">{s.detail}</p>
                </li>
              ))}
            </ul>
            <h4 className="mb-1 mt-5 text-sm font-semibold text-text-primary">{t('evidence.movedTitle')}</h4>
            {!p.hasTwoSnapshots ? <p className="text-xs text-text-secondary">{t('evidence.movedNeedTwo')}</p>
              : p.moved.length === 0 ? <p className="text-xs text-text-secondary">{t('evidence.movedNone')}</p>
              : <ul className="text-xs text-text-primary">{p.moved.map((m) => <li key={m.driver}>{m.driver.replace(/_/g, ' ')}: {m.delta > 0 ? '+' : ''}{m.delta}</li>)}</ul>}
          </Card>

          <Card>
            <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('evidence.changelogTitle')}</h3>
            {!p.previousRun ? <p className="text-xs text-text-secondary">{t('evidence.changelogFirst')}</p> : (
              <ul className="divide-y divide-border text-sm">
                {changes.filter((c) => c.change !== 'unchanged').map((c) => (
                  <li key={c.metricKey} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 text-text-primary">{c.label}</span>
                    <span className="text-xs text-text-secondary">{formatHeadline(c.metricKey, c.before)} → {formatHeadline(c.metricKey, c.after)}</span>
                    <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">
                      {c.change === 'added' ? t('evidence.changeAdded') : c.change === 'removed' ? t('evidence.changeRemoved') : t('evidence.changeChanged')}
                    </span>
                  </li>
                ))}
                {changes.every((c) => c.change === 'unchanged') && <li className="py-2 text-xs text-text-secondary">{t('evidence.changeUnchanged')}</li>}
              </ul>
            )}
          </Card>
        </>
      )}

      <Card>
        <h3 className="text-sm font-semibold text-text-primary">{t('evidence.addbackTitle')}</h3>
        <p className="mb-3 text-xs text-text-secondary">{t('evidence.addbackIntro')}</p>
        {p.addBacks.length === 0 ? <p className="text-xs text-text-secondary">{t('evidence.addbackNone')}</p> : (
          <ul className="space-y-3">
            {p.addBacks.map((a) => {
              const attached = p.evidenceRows.filter((e) => e.addbackId === a.id);
              return (
                <li key={a.id} className="rounded-xl border border-border px-3 py-3">
                  <p className="text-sm font-medium text-text-primary">{a.label}</p>
                  <p className="mt-1 text-xs text-text-secondary">{t('evidence.attached')}: {attached.length === 0 ? t('evidence.noEvidence') : ''}</p>
                  {attached.length > 0 && (
                    <ul className="mt-1 flex flex-wrap gap-2">
                      {attached.map((e) => (
                        <li key={e.id} className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-1 text-xs text-text-primary">
                          {e.title}
                          <button type="button" className="focus-ring rounded px-1 text-text-secondary hover:text-danger" aria-label={`${t('common.remove')}: ${e.title}`} onClick={() => void p.onDetach(e.id)}>×</button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <div className="min-w-[12rem] flex-1">
                      <label htmlFor={`ev-${a.id}`} className="sr-only">{t('evidence.docFor', { label: a.label })}</label>
                      <select id={`ev-${a.id}`} className={selectClass} value={pick[a.id] ?? ''} onChange={(e) => setPick((s) => ({ ...s, [a.id]: e.target.value }))}>
                        <option value="">{p.documents.length ? t('evidence.chooseDoc') : t('evidence.noDocs')}</option>
                        {p.documents.filter((d) => !attached.some((e) => e.documentId === d.id)).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                      </select>
                    </div>
                    <Button size="sm" variant="secondary" disabled={!pick[a.id] || busyAddback === a.id} onClick={() => void attach(a.id)}>{t('evidence.attach')}</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-text-primary">{t('evidence.exportTitle')}</h3>
        <p className="mb-3 text-xs text-text-secondary">{t('evidence.exportHelp')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={!p.run || p.exporting !== null} aria-busy={p.exporting === 'xlsx'} onClick={() => p.onExport('xlsx')}>
            <FileSpreadsheet size={14} aria-hidden="true" /> {p.exporting === 'xlsx' ? t('evidence.exporting') : t('evidence.exportExcel')}
          </Button>
          <Button size="sm" variant="secondary" disabled={!p.run || p.exporting !== null} aria-busy={p.exporting === 'pdf'} onClick={() => p.onExport('pdf')}>
            <FileText size={14} aria-hidden="true" /> {p.exporting === 'pdf' ? t('evidence.exporting') : t('evidence.exportPdf')}
          </Button>
          {!p.run && <span className="text-xs text-text-secondary">{t('evidence.exportNeedRun')}</span>}
        </div>
      </Card>
    </div>
  );
}
