import { useState, type ReactNode } from 'react';
import { FileText, Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useExitT } from '@/i18n/exitReadyNamespace';
import { formatDateTime } from '@/lib/format';
import { centsLabel, formatHeadline, headlineFromValue, parseRecon, shortHash } from '@/lib/exitLineage';
import { acceptNda, askQuestion, getDocumentUrl, type PublicStagedRoom } from '@/lib/exitReadyApi';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const list = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const s = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

interface Props {
  room: PublicStagedRoom;
  token: string;
  onRefresh: () => Promise<void>;
  /** Renders the frozen detailed package with the page's existing section renderer. */
  renderDetailed: (content: Rec) => ReactNode;
}

export function PublicStagedRoom({ room, token, onRefresh, renderDetailed }: Props) {
  const { t } = useExitT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [agree, setAgree] = useState(false);
  const [working, setWorking] = useState(false);
  const [ndaError, setNdaError] = useState(false);
  const [question, setQuestion] = useState('');
  const [qaMsg, setQaMsg] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  const teaser = rec(room.content.teaser);
  const nda = rec(room.content.nda);
  const facts = rec(nda.facts);
  const recon = parseRecon(nda.reconciliation);
  const addBacks = list(nda.addBacks);
  const stageName = room.stage === 'teaser' ? t('sharing.stageTeaser') : room.stage === 'nda' ? t('sharing.stageNda') : t('sharing.stageDetailed');
  const who = room.watermark ?? '';
  const guard = room.viewOnly;

  const accept = async () => {
    setWorking(true);
    setNdaError(false);
    const r = await acceptNda(token, name, email);
    if (r === 'accepted') await onRefresh();
    else setNdaError(true);
    setWorking(false);
  };

  const ask = async () => {
    const r = await askQuestion(token, question);
    if (r === 'asked') { setQuestion(''); setQaMsg(t('public.qaSent')); await onRefresh(); }
    else setQaMsg(r === 'rate_limited' ? t('public.qaLimit') : t('public.qaError'));
  };

  const open = async (documentId: string) => {
    setDocError(null);
    const w = window.open('', '_blank');
    const r = await getDocumentUrl(token, documentId);
    if (!r) { w?.close(); setDocError(t('public.documentError')); return; }
    if (w) { w.opener = null; w.location.href = r.url; } else window.location.assign(r.url);
  };

  return (
    <div className={`relative space-y-5 ${guard ? 'select-none print:hidden' : ''}`} onContextMenu={guard ? (e) => e.preventDefault() : undefined}>
      {guard && (
        <>
          <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-10 overflow-hidden opacity-[0.07]">
            <div className="-m-24 grid -rotate-12 grid-cols-2 gap-x-16 gap-y-20 text-xl font-bold text-text-primary sm:grid-cols-3">
              {Array.from({ length: 36 }, (_, i) => <span key={i} className="whitespace-nowrap">{t('public.watermark', { who })}</span>)}
            </div>
          </div>
          <p className="hidden print:block">{t('public.viewOnly')}</p>
          <p role="note" className="text-xs text-text-secondary">{t('public.viewOnly')}</p>
        </>
      )}
      <p className="text-xs font-medium text-text-secondary">{t('public.stageLabel', { stage: stageName })}</p>

      <Card className="!p-5">
        <h2 className="mb-3 text-lg font-semibold text-text-primary">{t('public.teaserTitle')}</h2>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-text-secondary">{t('public.teaserBand')}</dt><dd className="text-text-primary">{s(teaser.revenueBand)}</dd></div>
          <div><dt className="text-xs text-text-secondary">{t('public.teaserJobs')}</dt><dd className="text-text-primary">{s(teaser.jobsCompleted12mBand)}</dd></div>
          <div><dt className="text-xs text-text-secondary">{t('public.teaserRecurring')}</dt><dd className="text-text-primary">{teaser.hasRecurringRevenue === true ? t('public.yes') : t('public.no')}</dd></div>
        </dl>
      </Card>

      {room.ndaRequired && (
        <Card className="!p-5">
          <h2 className="text-lg font-semibold text-text-primary">{t('public.ndaTitle')}</h2>
          <p className="mb-3 mt-1 text-xs text-text-secondary">{t('public.ndaIntro')}</p>
          <div tabIndex={0} role="region" aria-label={t('public.ndaTitle')} className="focus-ring max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-primary">{room.ndaText}</div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input id="nda-name" label={t('public.ndaName')} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />
            <Input id="nda-email" label={t('public.ndaEmail')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} autoComplete="email" />
          </div>
          <label className="mt-4 flex items-start gap-2 text-sm text-text-primary">
            <input type="checkbox" className="focus-ring mt-1 h-4 w-4" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> {t('public.ndaAgree')}
          </label>
          {ndaError && <p role="alert" className="mt-2 text-xs text-danger">{t('public.ndaError')}</p>}
          <div className="mt-4"><Button onClick={() => void accept()} disabled={working || !agree || name.trim().length < 2 || !email.includes('@')} aria-busy={working}>{working ? t('public.ndaWorking') : t('public.ndaAccept')}</Button></div>
        </Card>
      )}

      {room.stage !== 'teaser' && (
        <>
          <Card className="!p-5">
            <h2 className="text-lg font-semibold text-text-primary">{t('public.figuresTitle')}</h2>
            <p className="mb-3 mt-1 text-xs text-text-secondary">{t('public.figuresIntro')}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t('public.figuresTitle')}</caption>
                <thead><tr className="text-xs text-text-secondary">
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t('evidence.colMetric')}</th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t('evidence.colHeadline')}</th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t('evidence.colRecords')}</th>
                  <th scope="col" className="py-2 text-start font-medium">{t('evidence.hash')}</th>
                </tr></thead>
                <tbody>
                  {Object.entries(facts).map(([key, raw]) => {
                    const f = rec(raw);
                    return (
                      <tr key={key} className="border-t border-border/60">
                        <th scope="row" className="py-2 pe-3 text-start font-medium text-text-primary">{s(f.label)}<span className="block text-[11px] font-normal text-text-secondary">{t('evidence.asOf', { when: formatDateTime(String(f.asOf ?? '')) })}</span></th>
                        <td className="py-2 pe-3 text-text-primary">{formatHeadline(key, headlineFromValue(key, f.value))}</td>
                        <td className="py-2 pe-3 text-text-secondary">{s(f.sourceCount)}</td>
                        <td className="py-2"><code className="text-[11px] text-text-secondary">{shortHash(String(f.hash ?? ''))}</code></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="!p-5">
            <h2 className="mb-3 text-lg font-semibold text-text-primary">{t('public.reconTitle')}</h2>
            <ul className="space-y-2 text-sm">
              {recon.map((r) => (
                <li key={r.key} className="rounded-xl border border-border px-3 py-2">
                  <p className="font-medium text-text-primary">{r.label} — <span className="text-xs">{r.status === 'match' ? t('evidence.statusMatch') : r.status === 'difference' ? t('evidence.statusDifference') : t('evidence.statusUnavailable')}</span></p>
                  <p className="text-xs text-text-secondary">{r.leftLabel}: {centsLabel(r.leftCents)} · {r.rightLabel}: {centsLabel(r.rightCents)} · {t('evidence.diff')}: {centsLabel(r.diffCents)}</p>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="!p-5">
            <h2 className="mb-3 text-lg font-semibold text-text-primary">{t('public.addbacksTitle')}</h2>
            {addBacks.length === 0 ? <p className="text-xs text-text-secondary">—</p> : (
              <ul className="space-y-2 text-sm">
                {addBacks.map((a, i) => (
                  <li key={i} className="rounded-xl border border-border px-3 py-2">
                    <p className="font-medium text-text-primary">{s(a.label)} · {typeof a.amountCents === 'number' ? centsLabel(a.amountCents) : '—'}</p>
                    <p className="text-xs text-text-secondary">{s(a.justification)}</p>
                    {Array.isArray(a.evidence) && a.evidence.length > 0 && <p className="mt-1 text-[11px] text-text-secondary">{(a.evidence as unknown[]).map(String).join(' · ')}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {room.documents.length > 0 && (
            <Card className="!p-5">
              <h2 className="mb-3 text-lg font-semibold text-text-primary">{t('public.documentsTitle')}</h2>
              <ul className="divide-y divide-border text-sm">
                {room.documents.map((d) => (
                  <li key={d.documentId} className="flex items-center gap-3 py-2">
                    <FileText size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-text-primary">{d.title}</span>
                    <Button size="sm" variant="secondary" onClick={() => void open(d.documentId)}>{t('public.openDocument')}</Button>
                  </li>
                ))}
              </ul>
              {docError && <p role="alert" className="mt-2 text-xs text-danger">{docError}</p>}
            </Card>
          )}

          {room.stage === 'detailed' && room.content.detailed && (
            <section aria-label={t('public.detailedTitle')}>
              <h2 className="mb-3 text-lg font-semibold text-text-primary">{t('public.detailedTitle')}</h2>
              {renderDetailed(rec(room.content.detailed))}
            </section>
          )}

          <Card className="!p-5">
            <h2 className="mb-3 text-lg font-semibold text-text-primary">{t('public.qaTitle')}</h2>
            <ul className="mb-4 space-y-3 text-sm">
              {room.questions.map((q) => (
                <li key={q.id}>
                  <p className="font-medium text-text-primary">{q.question}</p>
                  <p className="text-xs text-text-secondary">{q.answer ?? t('public.qaPending')}</p>
                </li>
              ))}
            </ul>
            <label htmlFor="qa-ask" className="mb-1.5 block text-sm font-medium text-text-primary">{t('public.qaAsk')}</label>
            <textarea id="qa-ask" rows={3} maxLength={2000} value={question} placeholder={t('public.qaPlaceholder')} onChange={(e) => { setQuestion(e.target.value); setQaMsg(null); }}
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-visible:border-accent" />
            <div className="mt-2 flex items-center gap-3">
              <Button size="sm" onClick={() => void ask()} disabled={question.trim().length < 3}>{t('public.qaSend')}</Button>
              {qaMsg && <p role="status" className="text-xs text-text-secondary">{qaMsg}</p>}
            </div>
          </Card>
        </>
      )}
      <p className="flex items-center gap-1 text-[11px] text-text-secondary"><Lock size={12} aria-hidden="true" /> {t('public.disclaimer')}</p>
    </div>
  );
}
