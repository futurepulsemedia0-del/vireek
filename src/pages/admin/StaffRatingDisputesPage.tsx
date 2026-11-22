// /staff/rating-disputes — moderator queue for reported Talent Network ratings (Vireek employees only).
// Access is enforced in the database (talent_staff_* RPCs check is_vireek_staff); the route sits behind <StaffRoute>.
// Policy: docs/policies/talent-ratings-moderation.md ([COUNSEL]). Never copy personal data into a decision note.
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Pill, SelectField, formatDateTime, type Tone } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { useRatingModerationT } from '@/i18n/ratingModerationNamespace';
import {
  DECISIONS, LIMITS, contentUnchanged, hasErrors, reasonsForDecision, validateDecision,
  type Decision, type DisputeStatus, type ModerationErrorKind, type StaffDisputeDetail, type StaffDisputeRow, type StaffScope,
} from '@/lib/talentRatingModeration';
import {
  RatingModerationError, claimStaffRatingDispute, getStaffRatingDispute, listStaffRatingDisputes, resolveStaffRatingDispute,
} from '@/lib/talentRatingModerationApi';
import { useSEO } from '@/lib/seo';

function SEO() {
  const { t } = useRatingModerationT();
  useSEO({ title: t('staff.seoTitle'), description: t('staff.seoDescription'), canonical: 'https://vireek.com/staff/rating-disputes' });
  return null;
}

const STATUS_TONE: Record<DisputeStatus, Tone> = {
  open: 'warning', under_review: 'info', resolved_kept: 'neutral', resolved_redacted: 'success', resolved_removed: 'success', withdrawn: 'neutral',
};
const errorKind = (e: unknown): ModerationErrorKind => (e instanceof RatingModerationError ? e.kind : 'generic');

type LoadState = { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; kind: ModerationErrorKind };

function DisputeDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { t } = useRatingModerationT();
  const { toast } = useToast();
  const [d, setD] = useState<StaffDisputeDetail | null>(null);
  const [loadError, setLoadError] = useState<ModerationErrorKind | null>(null);
  const [decision, setDecision] = useState<Decision | ''>('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await getStaffRatingDispute(id)); setLoadError(null); } catch (err) { setLoadError(errorKind(err)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (loadError) return <p role="alert" className="text-sm text-danger">{t(`errors.${loadError}`)}</p>;
  if (!d) return <p role="status" className="text-sm text-text-secondary">…</p>;

  const errors = validateDecision(decision, reason, note);
  const shown = showErrors ? errors : {};
  const msg = (k?: string) => (k ? t(`errors.${k}`, { min: LIMITS.noteMin, max: LIMITS.noteMax }) : undefined);
  const canClaim = d.status === 'open' && !d.conflict;
  const canDecide = d.status === 'under_review' && d.assigned_to_me && !d.conflict;

  const claim = async () => {
    setBusy(true);
    try { await claimStaffRatingDispute(d.id); toast(t('staff.claimed'), 'success'); await load(); onChanged(); }
    catch (err) { toast(t(`errors.${errorKind(err)}`), 'error'); }
    setBusy(false);
  };

  const submit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (busy) return;
    setShowErrors(true);
    if (hasErrors(validateDecision(decision, reason, note)) || decision === '') return;
    setBusy(true);
    try { await resolveStaffRatingDispute(d.id, decision, reason, note); toast(t('staff.resolved'), 'success'); await load(); onChanged(); }
    catch (err) { toast(t(`errors.${errorKind(err)}`), 'error'); }
    setBusy(false);
  };

  return (
    <div className="mt-3 space-y-4 border-t border-border pt-3 text-sm">
      <section aria-label={t('staff.reporterSays')}>
        <p className="font-medium text-text-primary">{t('staff.reportReason')}: {t(`reasons.${d.reason_code}`)}</p>
        <p className="mt-1 whitespace-pre-wrap text-text-secondary">{d.details}</p>
      </section>

      <section aria-label={t('staff.ratingContent')}>
        <h4 className="font-medium text-text-primary">{t('staff.ratingContent')}</h4>
        {d.rating ? (
          <div className="mt-1 space-y-1 text-text-secondary">
            <p>{t('staff.stars', { count: d.rating.rating })} · {t('staff.currentState', { state: d.rating.moderation_status })}</p>
            {d.rating.tags.length > 0 && <p>{t('staff.tags')}: {d.rating.tags.join(', ')}</p>}
            <p className="whitespace-pre-wrap">{d.rating.comment ?? t('staff.noComment')}</p>
            <p className="text-xs">{t('staff.hashLabel')}: <span className="font-mono" dir="ltr">{d.content_sha256.slice(0, 16)}…</span> — {contentUnchanged(d) ? t('staff.hashMatch') : t('staff.hashDiffers')}</p>
          </div>
        ) : <p className="text-text-secondary">{t('staff.noRating')}</p>}
      </section>

      {d.conflict && <p role="alert" className="rounded-xl border border-warning/30 bg-warning-subtle p-3 text-text-primary">{t('staff.conflictWarning')}</p>}

      {canClaim && <Button size="sm" onClick={() => void claim()} loading={busy} loadingLabel={t('staff.claiming')}>{t('staff.claim')}</Button>}

      {canDecide && (
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-3" aria-label={t('staff.decisionHeading')}>
          <h4 className="font-medium text-text-primary">{t('staff.decisionHeading')}</h4>
          <SelectField label={t('staff.decision')} required value={decision} error={msg(shown.decision)}
            onChange={(e) => { setDecision(e.target.value as Decision | ''); setReason(''); }}>
            <option value="">{t('staff.reasonPlaceholder')}</option>
            {DECISIONS.map((v) => <option key={v} value={v}>{t(`decisions.${v}`)}</option>)}
          </SelectField>
          {decision !== '' && (
            <SelectField label={t('staff.reason')} required value={reason} error={msg(shown.reason)} onChange={(e) => setReason(e.target.value)}>
              <option value="">{t('staff.reasonPlaceholder')}</option>
              {reasonsForDecision(decision).map((r) => <option key={r} value={r}>{t(decision === 'keep' ? `keepReasons.${r}` : `reasons.${r}`)}</option>)}
            </SelectField>
          )}
          <Textarea label={t('staff.note')} helperText={t('staff.noteHelp')} rows={4} required value={note} maxLength={LIMITS.noteMax}
            onChange={(e) => setNote(e.target.value)} error={msg(shown.note)} />
          <Button type="submit" size="sm" loading={busy} loadingLabel={t('staff.submitting')}>{t('staff.submit')}</Button>
        </form>
      )}

      <section aria-label={t('staff.logHeading')}>
        <h4 className="font-medium text-text-primary">{t('staff.logHeading')}</h4>
        <ol className="mt-1 space-y-1 text-xs text-text-secondary">
          {d.log.map((l, i) => (
            <li key={`${l.created_at}-${i}`}>
              <span className="text-text-primary">{formatDateTime(l.created_at)}</span> — {t('staff.logEntry', { action: t(`staff.actions.${l.action}`), actor: t(`staff.actors.${l.actor_kind}`) })}
              {l.reason_code && <> · {t(`reasons.${l.reason_code}`, { defaultValue: t(`keepReasons.${l.reason_code}`, { defaultValue: l.reason_code }) })}</>}
              {l.note && <p className="whitespace-pre-wrap ps-3">{l.note}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export function StaffRatingDisputesPage() {
  const { t } = useRatingModerationT();
  const [scope, setScope] = useState<StaffScope>('active');
  const [rows, setRows] = useState<StaffDisputeRow[]>([]);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try { setRows(await listStaffRatingDisputes(scope)); setState({ phase: 'ready' }); }
    catch (err) { setState({ phase: 'error', kind: errorKind(err) }); }
  }, [scope]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <SEO />
      <Header />
      <main id="main-content" className="min-h-screen bg-bg-primary px-6 pb-20 pt-28">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-text-primary">{t('staff.heading')}</h1>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('staff.subheading')}</p>
            </div>
            <Button variant="secondary" onClick={() => void load()} disabled={state.phase === 'loading'}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />{t('staff.refresh')}
            </Button>
          </div>

          <details className="rounded-xl border border-border p-3 text-sm">
            <summary className="cursor-pointer font-medium text-text-primary">{t('staff.removalRules')}</summary>
            <p className="mt-2 text-text-secondary">{t('staff.removalRulesBody')}</p>
          </details>

          <div className="sm:max-w-xs">
            <SelectField label={t('staff.heading')} value={scope} onChange={(e) => { setScope(e.target.value as StaffScope); setOpenId(null); }}>
              {(['active', 'resolved', 'all'] as const).map((s) => <option key={s} value={s}>{t(`staff.scope.${s}`)}</option>)}
            </SelectField>
          </div>

          {state.phase === 'loading' && (
            <div><p role="status" className="sr-only">…</p><SkeletonCardList count={3} rows={2} /></div>
          )}
          {state.phase === 'error' && (
            state.kind === 'forbidden'
              ? <EmptyState variant="no-permission" title={t('errors.forbidden')} />
              : <EmptyState variant="load-failed" title={t('staff.loadError')} onRetry={() => void load()} />
          )}
          {state.phase === 'ready' && rows.length === 0 && <p className="text-sm text-text-secondary">{t('staff.empty')}</p>}
          {state.phase === 'ready' && rows.length > 0 && (
            <ul className="space-y-3">
              {rows.map((r) => (
                <li key={r.id}>
                  <Card interactive={false} className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Pill>
                      <Pill tone="neutral">{t(`reasons.${r.reason_code}`)}</Pill>
                      <span className="text-sm text-text-secondary">{t(`staff.direction.${r.direction}`)} · {r.rating === null ? t('staff.noRating') : t('staff.stars', { count: r.rating })}</span>
                      {r.assigned_to_me && <Pill tone="info">{t('staff.mine')}</Pill>}
                      {r.assigned_to_other && <Pill tone="neutral">{t('staff.other')}</Pill>}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-text-secondary">{t('staff.reportedOn', { date: formatDateTime(r.created_at) })}</p>
                      <Button size="sm" variant="secondary" aria-expanded={openId === r.id} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                        {openId === r.id ? t('staff.close') : t('staff.open')}
                      </Button>
                    </div>
                    {openId === r.id && <DisputeDetail id={r.id} onChanged={() => void load()} />}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
