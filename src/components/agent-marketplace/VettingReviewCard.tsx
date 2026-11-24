// One submitted marketplace agent version: automated checks + staff checklist + decision.
// The server enforces every rule (get_marketplace_review_state / review_marketplace_agent_version);
// the buttons here only mirror it so staff see why approval is blocked.
import { useCallback, useEffect, useState } from 'react';
import { PlayCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { Pill, formatDateTime, type Tone } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { useMarketplaceVettingT } from '@/i18n/marketplaceVettingNamespace';
import { reviewVersion, type ReviewQueueItem } from '@/lib/agentMarketplace';
import {
  checklistProgress, classifyError, getReviewState, groupChecks, noteIsValid, parseApprovalBlockers, requestChanges, runVetting, saveChecklistAnswer,
  type ChecklistAnswer, type ChecklistItemState, type CheckStatus, type ReviewState, type RiskTier,
} from '@/lib/marketplaceVetting';

const STATUS_TONE: Record<CheckStatus, Tone> = { pass: 'success', warn: 'warning', fail: 'danger' };
const RISK_TONE: Record<RiskTier, Tone> = { low: 'success', medium: 'warning', high: 'danger' };
const CATEGORIES = ['manifest', 'scopes', 'outbound', 'data', 'identity'] as const;

export function VettingReviewCard({ item, onDecided }: { item: ReviewQueueItem; onDecided: () => void }) {
  const { t } = useMarketplaceVettingT();
  const { toast } = useToast();
  const [state, setState] = useState<ReviewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const errText = useCallback((e: unknown) => t(`errors.${classifyError(e instanceof Error ? e.message : '')}`), [t]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const s = await getReviewState(item.version_id);
      setState(s);
      setNotes((prev) => ({ ...Object.fromEntries(s.items.map((i) => [i.slug, i.note ?? ''])), ...prev }));
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [item.version_id]);

  useEffect(() => { void load(); }, [load]);

  const onRun = async () => {
    setRunning(true);
    try {
      await runVetting(item.version_id);
      await load();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setRunning(false);
    }
  };

  const onAnswer = async (slug: string, answer: ChecklistAnswer) => {
    const note = (notes[slug] ?? '').trim();
    if (answer !== 'pass' && !noteIsValid(note)) {
      toast(t('review.noteRequired'), 'error');
      return;
    }
    try {
      await saveChecklistAnswer(item.version_id, slug, answer, note || null);
      await load();
    } catch (e) {
      toast(errText(e), 'error');
    }
  };

  const decide = async (kind: 'approve' | 'changes' | 'reject') => {
    if (kind !== 'approve' && !noteIsValid(decisionNote)) {
      toast(t('review.noteRequired'), 'error');
      return;
    }
    setBusy(true);
    try {
      if (kind === 'changes') await requestChanges(item.version_id, decisionNote.trim());
      else await reviewVersion(item.version_id, kind === 'approve', decisionNote.trim() || null);
      toast(t(`review.done.${kind}`), 'success');
      onDecided();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (parseApprovalBlockers(msg).length) await load();
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const report = state?.report ?? null;
  const progress = state ? checklistProgress(state.items) : null;
  const grouped = report ? groupChecks(report.checks) : null;
  const applicable = (state?.items ?? []).filter((i) => i.applies);

  return (
    <Card interactive={false} padding="sm" className="space-y-5 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-text-primary">{item.agent_name} <span dir="ltr" className="font-normal text-text-secondary">v{item.version}</span></h3>
          <p className="text-xs text-text-secondary">{t('queue.by', { publisher: item.publisher_name })} · {formatDateTime(item.created_at)}</p>
          <p dir="ltr" className="truncate text-xs text-text-secondary">{item.endpoint_url}</p>
        </div>
        <Button variant="secondary" onClick={() => void onRun()} loading={running} loadingLabel={t('review.running')}>
          {report ? <RefreshCw className="h-4 w-4" aria-hidden="true" /> : <PlayCircle className="h-4 w-4" aria-hidden="true" />}
          {report ? t('review.rerun') : t('review.runChecks')}
        </Button>
      </header>

      {loading && !state && <p role="status" className="text-sm text-text-secondary">{t('loading')}</p>}
      {loadFailed && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-text-primary">
          {t('loadError')}
          <Button variant="secondary" onClick={() => void load()}>{t('refresh')}</Button>
        </div>
      )}

      {state && (
        <>
          <section aria-labelledby={`rep-${item.version_id}`} className="space-y-3">
            <h4 id={`rep-${item.version_id}`} className="text-sm font-semibold text-text-primary">{t('review.report')}</h4>
            {!report || !grouped ? (
              <p className="text-sm text-text-secondary">{t('review.noReport')}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={STATUS_TONE[report.verdict]}>{t(`review.verdict.${report.verdict}`)}</Pill>
                  <Pill tone={RISK_TONE[report.risk_tier]}>{t('review.risk', { level: t(`review.riskLevel.${report.risk_tier}`) })}</Pill>
                  <span className="text-xs text-text-secondary">{t('review.ranAt', { when: formatDateTime(report.created_at) })}</span>
                </div>
                {CATEGORIES.map((cat) => grouped[cat].length > 0 && (
                  <div key={cat}>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-secondary">{t(`categories.${cat}`)}</p>
                    <ul className="space-y-1.5">
                      {grouped[cat].map((c) => (
                        <li key={c.id} className="rounded-xl border border-border bg-bg-primary p-2.5 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <Pill tone={STATUS_TONE[c.status]}>{t(`status.${c.status}`)}</Pill>
                            <span className="font-medium text-text-primary">{t(`checks.${c.id}.title`, { defaultValue: c.id })}</span>
                          </div>
                          <p className="mt-1 text-text-secondary">{t(`checks.${c.id}.${c.status}`, { defaultValue: c.detail })}</p>
                          {c.evidence && c.evidence.length > 0 && (
                            <ul dir="ltr" className="mt-1 list-disc space-y-0.5 ps-5 text-xs text-text-secondary">
                              {c.evidence.map((e, i) => <li key={i} className="break-words">{e}</li>)}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <p className="text-xs text-text-secondary">{t('review.selfAttested')}</p>
              </>
            )}
          </section>

          <section aria-labelledby={`chk-${item.version_id}`} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 id={`chk-${item.version_id}`} className="text-sm font-semibold text-text-primary">{t('review.checklist')}</h4>
              {progress && <span className="text-xs text-text-secondary">{t('review.progress', { done: progress.done, total: progress.total })}</span>}
            </div>
            <ul className="space-y-2">
              {applicable.map((i: ChecklistItemState) => (
                <li key={i.slug} className="rounded-xl border border-border bg-bg-primary p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{t(`checklist.${i.slug}.label`)}</p>
                      <p className="text-xs text-text-secondary">{t(`checklist.${i.slug}.hint`)}</p>
                      {i.needs_counsel && <p className="mt-1 text-xs font-medium text-warning">{t('review.counsel')}</p>}
                    </div>
                    {i.answer && <Pill tone={i.answer === 'fail' ? 'danger' : 'success'}>{t(`review.answer.${i.answer}`)}</Pill>}
                  </div>
                  <Textarea label={t('review.note')} rows={2} maxLength={1000} value={notes[i.slug] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [i.slug]: e.target.value }))} />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant={i.answer === 'pass' ? 'primary' : 'secondary'} onClick={() => void onAnswer(i.slug, 'pass')}>{t('review.answer.pass')}</Button>
                    <Button variant={i.answer === 'fail' ? 'danger' : 'secondary'} onClick={() => void onAnswer(i.slug, 'fail')}>{t('review.answer.fail')}</Button>
                    {i.allows_na && <Button variant={i.answer === 'na' ? 'primary' : 'secondary'} onClick={() => void onAnswer(i.slug, 'na')}>{t('review.answer.na')}</Button>}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby={`dec-${item.version_id}`} className="space-y-3">
            <h4 id={`dec-${item.version_id}`} className="text-sm font-semibold text-text-primary">{t('review.decision')}</h4>
            {state.blockers.length > 0 && (
              <div role="note" className="rounded-xl border border-warning/30 bg-warning-subtle p-3 text-sm text-text-primary">
                <p className="font-medium">{t('review.blockedTitle')}</p>
                <ul className="mt-1 list-disc space-y-0.5 ps-5">
                  {state.blockers.map((b) => <li key={b}>{t(`blockers.${b}`, { defaultValue: b })}</li>)}
                </ul>
              </div>
            )}
            <Textarea label={t('review.decisionNote')} helperText={t('review.decisionHelp')} rows={3} maxLength={1000} value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void decide('approve')} loading={busy} disabled={!state.ready} disabledReason={state.ready ? undefined : t('review.blockedTitle')}>{t('review.approve')}</Button>
              <Button variant="secondary" onClick={() => void decide('changes')} disabled={busy}>{t('review.requestChanges')}</Button>
              <Button variant="danger" onClick={() => void decide('reject')} disabled={busy}>{t('review.reject')}</Button>
            </div>
          </section>
        </>
      )}
    </Card>
  );
}
