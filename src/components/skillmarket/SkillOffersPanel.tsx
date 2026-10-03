import { useCallback, useEffect, useState } from 'react';
import { Check, Inbox, Loader2, Phone, Star, X } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  URGENCY_META,
  describeMarketError,
  formatRate,
  formatTimeLeft,
  skillMarketApi,
  type MarketOffer,
  type OfferOutcome,
  type OfferStatus,
} from '@/lib/skillMarket';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

const STATUS_STYLE: Record<OfferStatus, string> = {
  offered: 'bg-warning-500/10 text-warning-500',
  accepted: 'bg-success-500/10 text-success-500',
  completed: 'bg-accent/10 text-accent',
  declined: 'bg-bg-tertiary text-text-secondary',
  expired: 'bg-bg-tertiary text-text-secondary',
  withdrawn: 'bg-bg-tertiary text-text-secondary',
};

const OUTCOME_LABELS: Record<OfferOutcome, string> = {
  resolved: 'Resolved',
  partial: 'Partly resolved',
  unresolved: 'Not resolved',
};

export function SkillOffersPanel({ refreshKey }: { refreshKey: number }) {
  const { toast } = useToast();
  const [offers, setOffers] = useState<MarketOffer[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OfferOutcome>('resolved');
  const [rating, setRating] = useState(5);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      await skillMarketApi.expireOffers().catch(() => undefined);
      setOffers(await skillMarketApi.listOffers());
      setFailed(false);
    } catch (e) {
      setFailed(true);
      toast(describeMarketError(e), 'error');
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const act = async (id: string, fn: () => Promise<void>, ok: string) => {
    setActingId(id);
    try {
      await fn();
      toast(ok, 'success');
    } catch (e) {
      toast(describeMarketError(e), 'error');
    } finally {
      setActingId(null);
      await load();
    }
  };

  const submitReview = async (id: string) => {
    await act(id, () => skillMarketApi.complete(id, outcome, rating, note.trim()), 'Thanks — this improves future matches for everyone.');
    setReviewId(null);
    setNote('');
    setRating(5);
    setOutcome('resolved');
  };

  if (offers === null && !failed) return <SkeletonCardList count={3} />;

  if (!offers || offers.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No requests yet"
        description="Requests you send to other companies' technicians, and requests they send you, appear here."
      />
    );
  }

  return (
    <ul className="space-y-4" aria-label="Skill market requests">
      {offers.map((o) => {
        const busy = actingId === o.id;
        const received = o.direction === 'received';
        return (
          <li key={o.id} className="space-y-3 rounded-xl border border-border bg-bg-secondary p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {received ? 'Received' : 'Sent'} · {URGENCY_META[o.urgency].label}
                </p>
                <h3 className="text-base font-semibold text-text-primary">{o.title}</h3>
                <p className="text-sm text-text-secondary">
                  {received ? `From ${o.counterparty_company}` : `To ${o.counterparty_company}`} ·{' '}
                  {o.technician_name ?? o.technician_alias}
                  {o.match_score !== null ? ` · match ${Math.round(o.match_score)}` : ''}
                  {o.offered_rate_cents !== null ? ` · ${formatRate(o.offered_rate_cents)}` : ''}
                  {o.remote ? ' · remote' : ''}
                </p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${STATUS_STYLE[o.status]}`}>
                {o.status}
                {o.status === 'offered' ? ` · ${formatTimeLeft(o.responds_by)}` : ''}
              </span>
            </div>

            {o.summary && <p className="text-sm text-text-primary">{o.summary}</p>}

            {(o.status === 'accepted' || o.status === 'completed') && o.counterparty_phone && (
              <p className="flex items-center gap-2 text-sm text-text-primary">
                <Phone size={14} className="text-accent" />
                <a href={`tel:${o.counterparty_phone}`} className="focus-ring rounded font-medium text-accent hover:underline">
                  {o.counterparty_phone}
                </a>
                <span className="text-text-secondary">· {o.counterparty_company}</span>
              </p>
            )}

            {o.status === 'completed' && o.outcome && (
              <p className="text-sm text-text-secondary">
                {OUTCOME_LABELS[o.outcome]}
                {o.rating ? ` · ${o.rating}/5` : ''}
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-3">
              {received && o.status === 'offered' && (
                <>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(o.id, () => skillMarketApi.respond(o.id, false), 'Request declined.')}>
                    <X size={14} /> Decline
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => void act(o.id, () => skillMarketApi.respond(o.id, true), 'Accepted. Contact details were shared.')}>
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Accept
                  </Button>
                </>
              )}
              {!received && (o.status === 'offered' || o.status === 'accepted') && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(o.id, () => skillMarketApi.withdraw(o.id), 'Request withdrawn.')}>
                  Withdraw
                </Button>
              )}
              {!received && o.status === 'accepted' && reviewId !== o.id && (
                <Button size="sm" onClick={() => setReviewId(o.id)}>
                  <Star size={14} /> Record outcome
                </Button>
              )}
            </div>

            {reviewId === o.id && (
              <div className="space-y-4 rounded-xl border border-border bg-bg-primary p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`sm-outcome-${o.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">
                      How did it end?
                    </label>
                    <select id={`sm-outcome-${o.id}`} value={outcome} onChange={(e) => setOutcome(e.target.value as OfferOutcome)} className={selectClass}>
                      {(Object.keys(OUTCOME_LABELS) as OfferOutcome[]).map((k) => (
                        <option key={k} value={k}>
                          {OUTCOME_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`sm-rating-${o.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">
                      Rating
                    </label>
                    <select id={`sm-rating-${o.id}`} value={rating} onChange={(e) => setRating(Number(e.target.value))} className={selectClass}>
                      {[5, 4, 3, 2, 1].map((r) => (
                        <option key={r} value={r}>
                          {r} / 5
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <Textarea label="Note (optional)" rows={2} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="flex justify-end gap-3">
                  <Button variant="ghost" size="sm" onClick={() => setReviewId(null)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => void submitReview(o.id)} disabled={busy}>
                    {busy && <Loader2 size={14} className="animate-spin" />}
                    Save outcome
                  </Button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
