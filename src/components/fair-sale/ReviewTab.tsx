import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonCardList } from '@/components/Skeleton';
import { useFairSaleT } from '@/i18n/fairSaleNamespace';
import { decideReview, errorMessage, listReviews, type FairSaleReview, type ReviewDecision } from '@/lib/fairSale';

const DECISIONS: ReviewDecision[] = ['approved', 'changes_requested', 'declined'];
const humanize = (s: string) => s.replace(/_/g, ' ');

export function ReviewTab({ canDecide }: { canDecide: boolean }) {
  const { t, language } = useFairSaleT();
  const [rows, setRows] = useState<FairSaleReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await listReviews()); } catch (e) { setError(errorMessage(e, t('dash.errors.generic'))); setRows([]); }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const decide = async (id: string, decision: ReviewDecision) => {
    setBusyId(id);
    setError(null);
    try {
      await decideReview(id, decision, (notes[id] ?? '').trim());
      setNotes((p) => ({ ...p, [id]: '' }));
      await load();
    } catch (e) {
      setError(errorMessage(e, t('dash.errors.generic')));
    } finally {
      setBusyId(null);
    }
  };

  if (!rows) return <SkeletonCardList count={2} rows={3} />;

  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-text-secondary">{t('review.intro')}</p>
      {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
      {rows.length === 0 && !error && <p className="rounded-2xl border border-border bg-bg-secondary p-5 text-sm text-text-secondary">{t('review.empty')}</p>}
      {rows.map((r) => {
        const open = r.status === 'open';
        const note = notes[r.id] ?? '';
        return (
          <article key={r.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-text-primary">{t(`review.kinds.${r.kind}`, { defaultValue: humanize(r.kind) })}</h3>
              <span className="text-xs text-text-secondary">
                {t(`review.status.${r.status}`, { defaultValue: humanize(r.status) })} · {new Date(r.requested_at).toLocaleString(language)}
              </span>
            </div>
            <p className="mt-1 text-sm text-text-secondary">{r.reason}</p>
            {r.blocking && open && <p className="mt-1 text-xs font-medium text-warning-500">{t('review.blocking')}</p>}
            {!open && r.decision_notes && (
              <p className="mt-2 text-sm text-text-primary">
                {r.decision_notes}
                {r.decided_by_email ? <span className="text-text-secondary"> — {r.decided_by_email}</span> : null}
                {r.self_review ? <span className="text-warning-500"> ({t('review.selfReview')})</span> : null}
              </p>
            )}
            {open && canDecide && (
              <div className="mt-3 space-y-2">
                <Input label={t('review.notesLabel')} value={note} maxLength={1000} onChange={(e) => setNotes((p) => ({ ...p, [r.id]: e.target.value }))} />
                <div className="flex flex-wrap gap-2">
                  {DECISIONS.map((d) => (
                    <Button key={d} type="button" size="sm" variant={d === 'approved' ? 'primary' : 'secondary'}
                      loading={busyId === r.id} disabled={note.trim().length < 10 || busyId !== null}
                      disabledReason={note.trim().length < 10 ? t('review.notesHint') : undefined}
                      onClick={() => void decide(r.id, d)}>
                      {t(`review.actions.${d}`)}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
