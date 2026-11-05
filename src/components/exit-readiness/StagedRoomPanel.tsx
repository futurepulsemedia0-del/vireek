import { useMemo, useState } from 'react';
import { Check, Copy, FolderLock, Loader2, ShieldOff } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { useExitT } from '@/i18n/exitReadyNamespace';
import { formatDateTime } from '@/lib/format';
import { DATA_ROOM_SECTIONS, linkState, type LinkState } from '@/lib/exitReadiness';
import type {
  AuditEntry, DocAccessEntry, OwnerDocument, PiiLevel, QaEntry, SharedDocument, Stage, StagedLink,
} from '@/lib/exitReadyApi';
import { EstimateBanner, Toggle, selectClass } from './shared';

interface Props {
  unavailable: boolean;
  hasRun: boolean;
  links: StagedLink[];
  documents: OwnerDocument[];
  shared: SharedDocument[];
  questions: QaEntry[];
  docLogs: DocAccessEntry[];
  audit: AuditEntry[];
  creating: boolean;
  busyId: string | null;
  createdUrl: string | null;
  onCreate: (input: { label: string; recipient: string; expiresHours: number; maxViews: number; ndaText: string }) => Promise<void>;
  onSetStage: (link: StagedLink, ceiling: Stage, pii: PiiLevel, sections: string[]) => Promise<void>;
  onRevoke: (link: StagedLink) => void;
  onShare: (linkId: string, documentId: string, minStage: 'nda' | 'detailed') => Promise<void>;
  onUnshare: (linkId: string, documentId: string) => Promise<void>;
  onAnswer: (questionId: string, answer: string) => Promise<void>;
  onDismissUrl: () => void;
}

const STATE_STYLE: Record<LinkState, string> = {
  active: 'bg-success/10 text-success',
  expired: 'bg-bg-tertiary text-text-secondary',
  revoked: 'bg-danger/10 text-danger',
  exhausted: 'bg-warning/10 text-warning',
};
const EXPIRY_HOURS = [24, 72, 168, 336, 720];
const DETAIL_SECTIONS = DATA_ROOM_SECTIONS.filter((s) => s.key !== 'valuation');

export function StagedRoomPanel(p: Props) {
  const { t } = useExitT();
  const [label, setLabel] = useState('');
  const [recipient, setRecipient] = useState('');
  const [expires, setExpires] = useState(168);
  const [maxViews, setMaxViews] = useState('10');
  const [nda, setNda] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [approve, setApprove] = useState<string | null>(null);
  const [pii, setPii] = useState<PiiLevel>('pseudonymized');
  const [sections, setSections] = useState<string[]>(['financials', 'kpis']);
  const [docPick, setDocPick] = useState<Record<string, string>>({});
  const [docStage, setDocStage] = useState<Record<string, 'nda' | 'detailed'>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const stageLabel = (s: Stage) => (s === 'teaser' ? t('sharing.stageTeaser') : s === 'nda' ? t('sharing.stageNda') : t('sharing.stageDetailed'));
  const stateLabel = (s: LinkState) => (s === 'active' ? t('sharing.active') : s === 'revoked' ? t('sharing.revoked') : t('sharing.expired'));
  const labelById = useMemo(() => new Map(p.links.map((l) => [l.id, l.label])), [p.links]);

  if (p.unavailable) return <EmptyState icon={FolderLock} title={t('sharing.title')} description={t('common.unavailable')} />;

  const submit = async () => {
    const e: Record<string, string> = {};
    if (label.trim().length < 2) e.label = '2–120';
    const views = Number(maxViews);
    if (!Number.isInteger(views) || views < 1 || views > 1000) e.maxViews = '1–1000';
    if (nda.trim().length < 50) e.nda = t('sharing.ndaHelp');
    setErrors(e);
    if (Object.keys(e).length) return;
    await p.onCreate({ label, recipient, expiresHours: expires, maxViews: views, ndaText: nda });
    setLabel(''); setRecipient(''); setNda('');
  };

  const copy = async () => {
    if (!p.createdUrl) return;
    try {
      await navigator.clipboard.writeText(p.createdUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-6">
      <EstimateBanner compact />
      <p role="note" className="rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-xs text-text-secondary">{t('sharing.legalNote')}</p>

      {p.createdUrl && (
        <Card className="!border-success/40">
          <h2 className="text-sm font-semibold text-text-primary">{t('sharing.readyTitle')}</h2>
          <p className="mt-1 text-xs text-text-secondary">{t('sharing.readyHelp')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-primary">{p.createdUrl}</code>
            <Button variant="secondary" size="sm" onClick={() => void copy()}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {copied ? t('sharing.copied') : t('sharing.copy')}</Button>
            <Button variant="ghost" size="sm" onClick={p.onDismissUrl}>{t('sharing.done')}</Button>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="text-lg font-semibold text-text-primary">{t('sharing.createTitle')}</h2>
        <p className="mb-4 mt-1 text-sm text-text-secondary">{t('sharing.intro')}</p>
        {!p.hasRun && <p role="status" className="mb-4 rounded-xl bg-warning/10 px-3 py-2 text-xs text-text-primary">{t('sharing.needRun')}</p>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input id="sr-label" label={t('sharing.name')} value={label} onChange={(e) => setLabel(e.target.value)} error={errors.label} maxLength={120} placeholder={t('sharing.namePlaceholder')} />
          <Input id="sr-recipient" label={t('sharing.recipient')} value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={120} helperText={t('sharing.recipientHelp')} />
          <div>
            <label htmlFor="sr-expiry" className="mb-1.5 block text-sm font-medium text-text-primary">{t('sharing.expires')}</label>
            <select id="sr-expiry" className={selectClass} value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
              {EXPIRY_HOURS.map((h) => <option key={h} value={h}>{h < 72 ? `${h} h` : `${h / 24} d`}</option>)}
            </select>
          </div>
          <Input id="sr-views" label={t('sharing.views')} type="number" inputMode="numeric" min={1} max={1000} value={maxViews} onChange={(e) => setMaxViews(e.target.value)} error={errors.maxViews} />
        </div>
        <div className="mt-4">
          <label htmlFor="sr-nda" className="mb-1.5 block text-sm font-medium text-text-primary">{t('sharing.ndaText')}</label>
          <textarea id="sr-nda" rows={6} maxLength={20000} value={nda} onChange={(e) => setNda(e.target.value)} aria-invalid={Boolean(errors.nda)} aria-describedby="sr-nda-help"
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm text-text-primary focus-visible:border-accent" />
          <p id="sr-nda-help" className={`mt-1 text-xs ${errors.nda ? 'text-danger' : 'text-text-secondary'}`}>{t('sharing.ndaHelp')}</p>
        </div>
        <div className="mt-4">
          <Button onClick={() => void submit()} disabled={p.creating || !p.hasRun} aria-busy={p.creating}>
            {p.creating && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />} {p.creating ? t('sharing.creating') : t('sharing.create')}
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold text-text-primary">{t('sharing.linksTitle')}</h2>
        {p.links.length === 0 ? <p className="text-sm text-text-secondary">{t('sharing.noLinks')}</p> : (
          <ul className="space-y-4">
            {p.links.map((l) => {
              const st = linkState(l);
              const live = st === 'active';
              const myDocs = p.shared.filter((d) => d.linkId === l.id);
              const myQs = p.questions.filter((q) => q.linkId === l.id);
              return (
                <li key={l.id} className="rounded-xl border border-border px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 flex-1 text-sm font-semibold text-text-primary">{l.label}{l.recipientLabel ? ` · ${l.recipientLabel}` : ''} <span className="text-xs font-normal text-text-secondary">…{l.tokenHint}</span></h3>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATE_STYLE[st]}`}>{stateLabel(st)}</span>
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">
                    {t('sharing.ceilingNow', { stage: stageLabel(l.stageCeiling) })} · {l.ndaAcceptedAt ? t('sharing.ndaAccepted', { when: formatDateTime(l.ndaAcceptedAt) }) : l.stageCeiling === 'teaser' ? t('sharing.stageTeaser') : t('sharing.ndaPending')} · {t('sharing.viewsUsed', { used: l.viewCount, max: l.maxViews })} · {t('sharing.expiresOn', { when: formatDateTime(l.expiresAt) })}
                  </p>
                  {live && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {l.stageCeiling === 'teaser' && <Button size="sm" variant="secondary" disabled={p.busyId === l.id} onClick={() => void p.onSetStage(l, 'nda', 'aggregated', [])}>{t('sharing.offerNda')}</Button>}
                      {l.stageCeiling !== 'teaser' && <Button size="sm" variant="ghost" disabled={p.busyId === l.id} onClick={() => void p.onSetStage(l, 'teaser', 'aggregated', [])}>{t('sharing.backToTeaser')}</Button>}
                      {l.stageCeiling !== 'detailed' && l.ndaAcceptedAt && <Button size="sm" variant="secondary" onClick={() => setApprove(approve === l.id ? null : l.id)} aria-expanded={approve === l.id}>{t('sharing.approveDetailed')}</Button>}
                      {l.stageCeiling === 'nda' && !l.ndaAcceptedAt && <span className="self-center text-xs text-text-secondary">{t('sharing.needNdaFirst')}</span>}
                      <Button size="sm" variant="ghost" onClick={() => p.onRevoke(l)}><ShieldOff size={14} aria-hidden="true" /> {t('sharing.revoke')}</Button>
                    </div>
                  )}
                  {approve === l.id && (
                    <fieldset className="mt-3 rounded-xl bg-bg-secondary px-3 py-3">
                      <legend className="text-sm font-semibold text-text-primary">{t('sharing.detailedTitle')}</legend>
                      <p className="mb-3 text-xs text-text-secondary">{t('sharing.detailedHelp')}</p>
                      <label htmlFor={`pii-${l.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">{t('sharing.piiLevel')}</label>
                      <select id={`pii-${l.id}`} className={selectClass} value={pii} onChange={(e) => setPii(e.target.value as PiiLevel)}>
                        <option value="pseudonymized">{t('sharing.piiPseudonymized')}</option>
                        <option value="named">{t('sharing.piiNamed')}</option>
                      </select>
                      {pii === 'named' && <p role="alert" className="mt-2 text-xs text-danger">{t('sharing.piiNamedWarning')}</p>}
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {DETAIL_SECTIONS.map((s) => (
                          <Toggle key={s.key} id={`ds-${l.id}-${s.key}`} checked={sections.includes(s.key)} label={s.label} hint={s.hint}
                            onChange={(on) => setSections((cur) => (on ? [...new Set([...cur, s.key])] : cur.filter((x) => x !== s.key)))} />
                        ))}
                      </div>
                      <div className="mt-3">
                        <Button size="sm" disabled={p.busyId === l.id || sections.length === 0} onClick={async () => { await p.onSetStage(l, 'detailed', pii, sections); setApprove(null); }}>{t('sharing.confirmDetailed')}</Button>
                      </div>
                    </fieldset>
                  )}

                  {l.stageCeiling !== 'teaser' && (
                    <div className="mt-4 border-t border-border pt-3">
                      <h4 className="text-xs font-semibold text-text-primary">{t('sharing.docsTitle')}</h4>
                      <p className="mb-2 text-[11px] text-text-secondary">{t('sharing.docsIntro')}</p>
                      {myDocs.length === 0 ? <p className="text-xs text-text-secondary">{t('sharing.docNone')}</p> : (
                        <ul className="mb-2 space-y-1">
                          {myDocs.map((d) => (
                            <li key={d.id} className="flex flex-wrap items-center gap-2 text-xs text-text-primary">
                              <span className="min-w-0 flex-1">{d.title} · {d.minStage === 'nda' ? t('sharing.stageNda') : t('sharing.stageDetailed')}</span>
                              <Button size="sm" variant="ghost" onClick={() => void p.onUnshare(l.id, d.documentId)}>{t('sharing.docUnshare')}</Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-[10rem] flex-1">
                          <label htmlFor={`dp-${l.id}`} className="sr-only">{t('sharing.docPick')}</label>
                          <select id={`dp-${l.id}`} className={selectClass} value={docPick[l.id] ?? ''} onChange={(e) => setDocPick((s) => ({ ...s, [l.id]: e.target.value }))}>
                            <option value="">{t('sharing.docPick')}</option>
                            {p.documents.filter((d) => !myDocs.some((m) => m.documentId === d.id)).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`ds2-${l.id}`} className="sr-only">{t('sharing.docStage')}</label>
                          <select id={`ds2-${l.id}`} className={selectClass} value={docStage[l.id] ?? 'detailed'} onChange={(e) => setDocStage((s) => ({ ...s, [l.id]: e.target.value as 'nda' | 'detailed' }))}>
                            <option value="nda">{t('sharing.stageNda')}</option>
                            <option value="detailed">{t('sharing.stageDetailed')}</option>
                          </select>
                        </div>
                        <Button size="sm" variant="secondary" disabled={!docPick[l.id]} onClick={async () => { await p.onShare(l.id, docPick[l.id], docStage[l.id] ?? 'detailed'); setDocPick((s) => ({ ...s, [l.id]: '' })); }}>{t('sharing.docShare')}</Button>
                      </div>
                      <p className="mt-2 text-[11px] text-text-secondary">{t('sharing.viewOnlyNote')}</p>
                    </div>
                  )}

                  {myQs.length > 0 && (
                    <div className="mt-4 border-t border-border pt-3">
                      <h4 className="mb-2 text-xs font-semibold text-text-primary">{t('sharing.qaTitle')}</h4>
                      <ul className="space-y-3">
                        {myQs.map((q) => (
                          <li key={q.id} className="text-xs">
                            <p className="font-medium text-text-primary">{q.question}</p>
                            {q.answer ? <p className="mt-1 text-text-secondary">{q.answer} · {t('sharing.qaAnswered', { when: formatDateTime(q.answeredAt) })}</p> : (
                              <div className="mt-1 flex flex-wrap items-end gap-2">
                                <div className="min-w-[12rem] flex-1">
                                  <label htmlFor={`qa-${q.id}`} className="sr-only">{t('sharing.qaAnswerLabel', { question: q.question })}</label>
                                  <textarea id={`qa-${q.id}`} rows={2} maxLength={4000} value={answers[q.id] ?? ''} onChange={(e) => setAnswers((s) => ({ ...s, [q.id]: e.target.value }))}
                                    className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary focus-visible:border-accent" />
                                </div>
                                <Button size="sm" variant="secondary" disabled={!(answers[q.id] ?? '').trim()} onClick={async () => { await p.onAnswer(q.id, answers[q.id]); setAnswers((s) => ({ ...s, [q.id]: '' })); }}>{t('sharing.qaSend')}</Button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('sharing.logsTitle')}</h3>
        {p.docLogs.length === 0 ? <p className="text-xs text-text-secondary">{t('sharing.logsNone')}</p> : (
          <ul className="divide-y divide-border text-xs">
            {p.docLogs.slice(0, 50).map((d) => (
              <li key={d.id} className="flex flex-wrap gap-2 py-2 text-text-primary">
                <span className="min-w-0 flex-1">{d.linkId ? labelById.get(d.linkId) ?? '' : ''} · {p.shared.find((s) => s.documentId === d.documentId)?.title ?? d.documentId?.slice(0, 8) ?? ''}</span>
                <span className="text-text-secondary">{d.action === 'view' ? t('sharing.logView') : d.action === 'denied_stage' ? t('sharing.logDeniedStage') : t('sharing.logDeniedShared')} · {formatDateTime(d.accessedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('sharing.auditTitle')}</h3>
        {p.audit.length === 0 ? <p className="text-xs text-text-secondary">{t('sharing.auditNone')}</p> : (
          <ul className="divide-y divide-border text-xs">
            {p.audit.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-2 py-2 text-text-primary">
                <span className="min-w-0 flex-1">{t(`sharing.actor_${a.actorKind}`)}: {a.action.replace(/_/g, ' ')}</span>
                <span className="text-text-secondary">{formatDateTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-text-secondary">{t('sharing.futureNote')}</p>
      </Card>
    </div>
  );
}
