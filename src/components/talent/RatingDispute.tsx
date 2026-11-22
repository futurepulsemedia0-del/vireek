// Report / dispute panel shown under a revealed rating. The server decides everything that matters
// (who may report, double-blind visibility, limits); this component only reflects `moderation` and
// sends the form. Strings come from the `ratingModeration` namespace; layout uses logical properties for RTL.
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { SelectField } from '@/components/vehicles/shared';
import { useRatingModerationT } from '@/i18n/ratingModerationNamespace';
import {
  LIMITS, REPORT_REASONS, hasErrors, isActiveStatus, validateReport,
  type RatingModerationState, type ReportReason,
} from '@/lib/talentRatingModeration';
import { RatingModerationError, openRatingDispute, withdrawRatingDispute } from '@/lib/talentRatingModerationApi';

interface Props {
  engagementId: string;
  moderation: RatingModerationState;
  /** Called after a report is sent or withdrawn so the parent can reload the ratings. */
  onChanged: () => void;
}

export function RatingDispute({ engagementId, moderation, onChanged }: Props) {
  const { t } = useRatingModerationT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [details, setDetails] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const errors = validateReport(reason, details);
  const shown = showErrors ? errors : {};
  const fieldMsg = (k?: string) => (k ? t(`errors.${k}`, { min: LIMITS.detailsMin, max: LIMITS.detailsMax }) : undefined);
  const dispute = moderation.dispute ?? null;

  const fail = (err: unknown) => setError(t(`errors.${err instanceof RatingModerationError ? err.kind : 'generic'}`));

  async function submit(e: { preventDefault: () => void }) {
    e.preventDefault();
    if (busy) return;
    setShowErrors(true);
    if (hasErrors(validateReport(reason, details))) return;
    setBusy(true); setError(null);
    try {
      await openRatingDispute(engagementId, reason, details);
      setNotice(t('user.sent'));
      setOpen(false); setReason(''); setDetails(''); setShowErrors(false);
      onChanged();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!dispute || busy) return;
    setBusy(true); setError(null);
    try {
      await withdrawRatingDispute(dispute.id);
      setNotice(t('user.withdrawn'));
      onChanged();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const nothingToShow = !moderation.theirs_removed && !moderation.theirs_comment_redacted && !moderation.mine_removed
    && !dispute && !moderation.can_dispute && !notice;
  if (nothingToShow) return null;

  return (
    <div className="space-y-2 text-sm">
      {moderation.theirs_removed && <p role="status" className="text-text-secondary">{t('user.removedNotice')}</p>}
      {moderation.theirs_comment_redacted && !moderation.theirs_removed && <p role="status" className="text-text-secondary">{t('user.redactedNotice')}</p>}
      {moderation.mine_removed && <p role="status" className="text-text-secondary">{t('user.mineRemovedNotice')}</p>}

      {dispute && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-text-secondary">{t('user.reportStatus', { status: t(`status.${dispute.status}`) })}</p>
          {isActiveStatus(dispute.status) && (
            <Button size="sm" variant="secondary" onClick={() => void withdraw()} loading={busy} loadingLabel={t('user.withdrawing')}>{t('user.withdraw')}</Button>
          )}
          {dispute.status === 'resolved_kept' && <p className="text-text-secondary">{t('user.resolvedKept')}</p>}
        </div>
      )}

      {notice && <p role="status" className="text-success">{notice}</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}

      {moderation.can_dispute && !open && (
        <Button size="sm" variant="secondary" onClick={() => { setOpen(true); setNotice(null); }}>{t('user.reportButton')}</Button>
      )}

      {moderation.can_dispute && open && (
        <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={`rating-report-${engagementId}`} className="space-y-3 rounded-xl border border-border p-3">
          <h4 id={`rating-report-${engagementId}`} className="font-semibold text-text-primary">{t('user.formHeading')}</h4>
          <p className="text-xs text-text-secondary">{t('user.formIntro')}</p>
          <SelectField label={t('user.reason')} required value={reason} onChange={(e) => setReason(e.target.value as ReportReason | '')} error={fieldMsg(shown.reason)}>
            <option value="">{t('user.reasonPlaceholder')}</option>
            {REPORT_REASONS.map((r) => <option key={r} value={r}>{t(`reasons.${r}`)}</option>)}
          </SelectField>
          <Textarea label={t('user.details')} helperText={t('user.detailsHelp')} rows={4} required value={details}
            maxLength={LIMITS.detailsMax} onChange={(e) => setDetails(e.target.value)} error={fieldMsg(shown.details)} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={busy} loadingLabel={t('user.submitting')}>{t('user.submit')}</Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { setOpen(false); setShowErrors(false); }}>{t('user.cancel')}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
