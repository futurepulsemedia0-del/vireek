import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, RefreshCw, ShieldAlert, WifiOff, FileText, Download, Trash2, CheckCircle2, Circle } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { SkeletonCard, FadeIn } from '@/components/Skeleton';
import { SHADOW_NS } from '@/i18n/shadowModeNamespace';
import {
  ESTIMATE_LABEL, SHADOW_TRIAL_DAYS, applyFaq, decideProposal, deleteShadowData, fetchCards, fetchReportBlob, fetchReviews, fetchStats,
  fetchTrial, goLive, refreshReplay, setSetupItem, startTrial, submitReview, trialDay, updateSettings,
  type ShadowCardRow, type ShadowReviewRow, type ShadowStats, type ShadowTrial,
} from '@/lib/shadowMode';

const CATEGORIES = ['greeting', 'triage', 'emergency', 'booking', 'pricing', 'tone', 'other'] as const;
const POLL_MS = 30_000;

function useOnline() {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true), b = () => setOn(false);
    window.addEventListener('online', a); window.addEventListener('offline', b);
    return () => { window.removeEventListener('online', a); window.removeEventListener('offline', b); };
  }, []);
  return on;
}

export function ShadowModePage() {
  const { t, i18n } = useTranslation(SHADOW_NS);
  const { toast } = useToast();
  const online = useOnline();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trial, setTrial] = useState<ShadowTrial | null>(null);
  const [stats, setStats] = useState<ShadowStats | null>(null);
  const [cards, setCards] = useState<ShadowCardRow[]>([]);
  const [reviews, setReviews] = useState<ShadowReviewRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [retention, setRetention] = useState('30');
  const [ticket, setTicket] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const tr = await fetchTrial();
      setTrial(tr);
      if (tr) {
        setRetention(String(tr.retention_days));
        setTicket(tr.avg_ticket_cents_override ? String(tr.avg_ticket_cents_override / 100) : '');
        const [s, c, r] = await Promise.all([fetchStats(tr.id), fetchCards(tr.id), fetchReviews(tr.id)]);
        setStats(s); setCards(c); setReviews(r);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('loadFailed'));
    } finally { setLoading(false); }
  }, [t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!trial || trial.status !== 'active' || !online) return;
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [trial, online, load]);

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key);
    try { await fn(); if (ok) toast(ok, 'success'); await load(true); }
    catch (e) { toast(e instanceof Error ? e.message : t('loadFailed'), 'error'); }
    finally { setBusy(null); }
  };

  const day = trial ? Math.min(SHADOW_TRIAL_DAYS, Math.max(1, trialDay(trial.started_at, new Date().toISOString()))) : 0;
  const expired = trial ? Date.now() >= Date.parse(trial.ends_at) : false;
  const consentReady = !!trial && trial.replay_attested && trial.caller_disclosure_configured && trial.staff_notified;
  const reviewByCard = useMemo(() => new Map(reviews.map((r) => [r.card_id, r])), [reviews]);
  const pending = reviews.filter((r) => r.proposal_status === 'pending' || r.proposal_status === 'accepted');
  const allSetup = !!trial && Object.values(trial.setup_items).every(Boolean);

  const openReport = async (format: 'html' | 'pdf') => {
    setBusy(`report-${format}`);
    try {
      const { blob, preview } = await fetchReportBlob(format, i18n.language);
      const url = URL.createObjectURL(blob);
      if (format === 'pdf') { const a = document.createElement('a'); a.href = url; a.download = 'shadow-mode-proof-of-value.pdf'; a.click(); }
      else window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (preview) toast(t('reportPreview'), 'info');
    } catch (e) { toast(e instanceof Error ? e.message : t('loadFailed'), 'error'); }
    finally { setBusy(null); }
  };

  return (
    <DashboardLayout activeLabel="Shadow Mode">
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><Eye aria-hidden className="h-6 w-6" />{t('title')}</h1>
          <p className="mt-1 text-sm opacity-80">{t('tagline')}</p>
        </header>

        {!online && <div role="status" className="flex items-center gap-2 rounded-xl border p-3 text-sm"><WifiOff aria-hidden className="h-4 w-4" />{t('offline')}</div>}

        {loading && <div aria-busy="true"><SkeletonCard rows={4} /></div>}

        {!loading && error && (
          <div role="alert" className="rounded-xl border border-red-500/40 p-4">
            <p className="text-sm">{error || t('loadFailed')}</p>
            <Button className="mt-3" size="sm" variant="secondary" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}

        {!loading && !error && !trial && (
          <EmptyState icon={Eye} title={t('cta')} description={`${t('tagline')} ${t('ctaNote')}`}
            action={{ label: busy === 'start' ? t('starting') : t('cta'), onClick: () => void run('start', async () => { await startTrial(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); }) }} />
        )}

        {!loading && trial && (
          <FadeIn>
            <section aria-label={t('timeline')} className="rounded-2xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">{t('timeline')} — {trial.status === 'went_live' ? t('went') : expired ? t('expired') : t('day', { day })}</h2>
                {trial.status === 'active' && (
                  <Button size="sm" variant="secondary" loading={busy === 'refresh'} disabled={!online || !consentReady}
                    disabledReason={!consentReady ? t('consentTitle') : undefined}
                    onClick={() => void run('refresh', async () => { await refreshReplay(); })}><RefreshCw aria-hidden className="h-4 w-4" />{t('refresh')}</Button>
                )}
              </div>
              <ol className="mt-3 grid grid-cols-7 gap-1" aria-label={t('timeline')}>
                {Array.from({ length: SHADOW_TRIAL_DAYS }, (_, i) => i + 1).map((d) => (
                  <li key={d} aria-current={d === day && !expired ? 'step' : undefined}
                    className={`rounded-lg border p-2 text-center text-xs ${d < day || expired ? 'font-semibold' : ''} ${d === day && !expired ? 'ring-2 ring-current' : 'opacity-60'}`}>{d}</li>
                ))}
              </ol>
            </section>

            <section aria-label={t('counter')} className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5" aria-live="polite">
              {[
                [t('callsSeen'), stats?.calls_seen], [t('unanswered'), stats?.unanswered], [t('afterHours'), stats?.after_hours],
                [t('emergencies'), stats?.emergencies], [t('capturable'), stats?.capturable],
              ].map(([label, v]) => (
                <div key={String(label)} className="rounded-xl border p-3"><div className="text-xs opacity-70">{label}</div><div className="text-2xl font-semibold">{v ?? 0}</div></div>
              ))}
            </section>

            {trial.status === 'active' && (
              <section className="mt-4 rounded-2xl border p-4" aria-labelledby="consent-h">
                <h2 id="consent-h" className="flex items-center gap-2 font-semibold"><ShieldAlert aria-hidden className="h-4 w-4" />{t('consentTitle')}</h2>
                <p className="mt-1 text-xs opacity-80">{t('legalFlag')}</p>
                {([
                  ['attest', trial.replay_attested, (v: boolean) => updateSettings(trial.id, { replayAttested: v })],
                  ['disclosure', trial.caller_disclosure_configured, (v: boolean) => updateSettings(trial.id, { callerDisclosure: v })],
                  ['staff', trial.staff_notified, (v: boolean) => updateSettings(trial.id, { staffNotified: v })],
                ] as const).map(([key, val, fn]) => (
                  <label key={key} className="mt-3 flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1 h-4 w-4" checked={val} disabled={busy !== null} onChange={(e) => void run(key, () => fn(e.target.checked))} />
                    <span>{t(key)}</span>
                  </label>
                ))}
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">{t('retention')}
                    <input inputMode="numeric" className="mt-1 w-full rounded-lg border bg-transparent p-2" value={retention} onChange={(e) => setRetention(e.target.value)} /></label>
                  <label className="text-sm">{t('avgTicket')}
                    <input inputMode="decimal" className="mt-1 w-full rounded-lg border bg-transparent p-2" value={ticket} onChange={(e) => setTicket(e.target.value)} /></label>
                </div>
                <Button className="mt-3" size="sm" loading={busy === 'settings'} onClick={() => void run('settings', async () => {
                  const days = Number(retention); const dollars = ticket.trim() === '' ? null : Number(ticket);
                  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error(t('retention'));
                  if (dollars !== null && (!Number.isFinite(dollars) || dollars <= 0)) throw new Error(t('avgTicket'));
                  await updateSettings(trial.id, { retentionDays: days, avgTicketCents: dollars === null ? null : Math.round(dollars * 100) });
                }, t('saved'))}>{t('save')}</Button>
                <p className="mt-2 text-xs opacity-70">{t('liveListen')}</p>
              </section>
            )}

            {pending.length > 0 && (
              <section className="mt-4 rounded-2xl border p-4" aria-labelledby="prop-h">
                <h2 id="prop-h" className="font-semibold">{t('proposals')}</h2>
                <p className="text-xs opacity-70">{t('proposalNote')}</p>
                <ul className="mt-2 space-y-2">
                  {pending.map((r) => (
                    <li key={r.id} className="rounded-xl border p-3 text-sm">
                      {r.proposal_question && <div className="font-medium">{r.proposal_question}</div>}
                      <div>{r.corrected_text}</div>
                      <div className="mt-2 flex gap-2">
                        {r.proposal_status === 'pending' && <>
                          <Button size="xs" onClick={() => void run(`a-${r.id}`, () => decideProposal(r.id, true))}>{t('accept')}</Button>
                          <Button size="xs" variant="ghost" onClick={() => void run(`r-${r.id}`, () => decideProposal(r.id, false))}>{t('reject')}</Button>
                        </>}
                        {r.proposal_status === 'accepted' && r.proposal_target === 'faq' && <Button size="xs" onClick={() => void run(`f-${r.id}`, () => applyFaq(r.id))}>{t('applyFaq')}</Button>}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="mt-4" aria-labelledby="cards-h">
              <h2 id="cards-h" className="mb-2 font-semibold">{t('cards')}</h2>
              {cards.length === 0 ? <EmptyState icon={Eye} title={t('cards')} description={t('noCards')} /> : (
                <ul className="space-y-3">
                  {cards.map((c) => <CardItem key={c.id} card={c} review={reviewByCard.get(c.id)} locked={trial.status === 'went_live' || trial.status === 'cancelled'}
                    onSubmit={(p) => run(`rv-${c.id}`, () => submitReview({ cardId: c.id, ...p }), t('saved'))} />)}
                </ul>
              )}
            </section>

            {(expired || trial.status !== 'active') && trial.status !== 'cancelled' && (
              <section className="mt-4 rounded-2xl border p-4" aria-labelledby="rep-h">
                <h2 id="rep-h" className="font-semibold">{t('report')}</h2>
                <p className="text-xs opacity-70">{ESTIMATE_LABEL}</p>
              </section>
            )}
            {trial.status !== 'cancelled' && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" loading={busy === 'report-html'} onClick={() => void openReport('html')}><FileText aria-hidden className="h-4 w-4" />{t('viewReport')}</Button>
                <Button size="sm" variant="secondary" loading={busy === 'report-pdf'} onClick={() => void openReport('pdf')}><Download aria-hidden className="h-4 w-4" />{t('downloadPdf')}</Button>
              </div>
            )}

            {(trial.status === 'active' || trial.status === 'completed') && (
              <section className="mt-4 rounded-2xl border p-4" aria-labelledby="gl-h">
                <h2 id="gl-h" className="font-semibold">{t('checklist')}</h2>
                <ul className="mt-2 space-y-2">
                  {(['forwarding', 'hours', 'emergency_rules', 'test_call'] as const).map((k) => (
                    <li key={k}>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4" checked={trial.setup_items[k]} disabled={busy !== null}
                          onChange={(e) => void run(`s-${k}`, () => setSetupItem(trial.id, k, e.target.checked))} />
                        {trial.setup_items[k] ? <CheckCircle2 aria-hidden className="h-4 w-4" /> : <Circle aria-hidden className="h-4 w-4" />}{t(k)}
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs opacity-70">{t('goLiveNote')}</p>
                <Button className="mt-3" loading={busy === 'live'} disabled={!allSetup} disabledReason={!allSetup ? t('checklist') : undefined}
                  onClick={() => void run('live', () => goLive(trial.id))}>{t('goLiveBtn')}</Button>
              </section>
            )}

            {trial.status !== 'cancelled' && (
              <div className="mt-6"><Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden className="h-4 w-4" />{t('deleteData')}</Button></div>
            )}
          </FadeIn>
        )}

        <ConfirmDialog open={confirmDelete} title={t('deleteData')} description={t('deleteConfirm')} confirmLabel={t('deleteData')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => { setConfirmDelete(false); if (trial) await run('delete', () => deleteShadowData(trial.id), t('deleted')); }} />
      </div>
    </DashboardLayout>
  );
}

function CardItem({ card, review, locked, onSubmit }: {
  card: ShadowCardRow; review?: ShadowReviewRow; locked: boolean;
  onSubmit: (p: { verdict: 'good' | 'bad'; severity?: 'minor' | 'critical'; category?: string; correctedText?: string; proposalTarget?: 'none' | 'faq'; proposalQuestion?: string }) => Promise<void>;
}) {
  const { t } = useTranslation(SHADOW_NS);
  const [open, setOpen] = useState(false);
  const [bad, setBad] = useState(false);
  const [severity, setSeverity] = useState<'minor' | 'critical'>('minor');
  const [category, setCategory] = useState<string>('other');
  const [text, setText] = useState('');
  const [faq, setFaq] = useState(false);
  const [question, setQuestion] = useState('');
  const when = new Date(card.call_started_at).toLocaleString();
  const canSubmitBad = !faq || (text.trim() !== '' && question.trim() !== '');
  return (
    <li className="rounded-2xl border p-4">
      <button type="button" className="flex w-full items-center justify-between text-start" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="text-sm font-medium">{when}{card.caller_last4 ? ` · …${card.caller_last4}` : ''}{card.emergency ? ' · 🚨' : ''}</span>
        <span className="text-xs opacity-70">{card.status === 'ready' ? (card.diff.note ?? '') : card.status === 'blocked_consent' ? t('blocked') : card.status === 'no_transcript' ? t('noTranscript') : t('failed')}{review ? ` · ${review.verdict === 'good' ? '👍' : '👎'}` : ''}</span>
      </button>
      {open && card.status === 'ready' && (
        <div className="mt-3 space-y-3 text-sm">
          <div><div className="font-medium">{t('wouldDo')} <span className="text-xs opacity-70">({ESTIMATE_LABEL})</span></div>
            <ul className="list-disc ps-5">{card.actions.map((a, i) => <li key={i}><b>{a.kind}</b>: {a.description}</li>)}</ul></div>
          <div><div className="font-medium">{t('actual')}</div><p>{card.diff.note}{card.diff.afterHours ? ' (after hours)' : ''}</p></div>
          {card.transcript_redacted && <details><summary>{t('transcript')}</summary><p className="whitespace-pre-wrap opacity-80">{card.transcript_redacted}</p></details>}
          {!locked && (
            <div className="rounded-xl border p-3">
              <div className="flex gap-2">
                <Button size="xs" variant={review?.verdict === 'good' ? 'primary' : 'secondary'} onClick={() => { setBad(false); void onSubmit({ verdict: 'good' }); }}>👍 {t('good')}</Button>
                <Button size="xs" variant={bad || review?.verdict === 'bad' ? 'primary' : 'secondary'} onClick={() => setBad(true)}>👎 {t('bad')}</Button>
              </div>
              {bad && (
                <div className="mt-3 space-y-2">
                  <div className="flex flex-wrap gap-3">
                    <label>{t('severity')} <select className="rounded border bg-transparent p-1" value={severity} onChange={(e) => setSeverity(e.target.value as 'minor' | 'critical')}><option value="minor">{t('minor')}</option><option value="critical">{t('critical')}</option></select></label>
                    <label>{t('category')} <select className="rounded border bg-transparent p-1" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
                  </div>
                  <label className="block">{t('correction')}<textarea className="mt-1 w-full rounded-lg border bg-transparent p-2" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} /></label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={faq} onChange={(e) => setFaq(e.target.checked)} />{t('proposeFaq')}</label>
                  {faq && <label className="block">{t('faqQuestion')}<input className="mt-1 w-full rounded-lg border bg-transparent p-2" maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} /></label>}
                  <Button size="xs" disabled={!canSubmitBad} onClick={() => void onSubmit({ verdict: 'bad', severity, category, correctedText: text || undefined, proposalTarget: faq ? 'faq' : 'none', proposalQuestion: faq ? question : undefined })}>{t('submit')}</Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
