import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CalendarClock, CheckCircle2, Clock, Loader2, MapPin, ShieldAlert, Siren } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonCardList } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { jobBoardApi } from '@/lib/jobBoardApi';
import {
  describeJobBoardError,
  formatMoney,
  formatOpensIn,
  formatShiftWindow,
  formatTimeLeft,
  parseDollarsToCents,
  type OfferState,
  type VendorOffer,
} from '@/lib/jobBoard';

const CLOSED_COPY: Partial<Record<OfferState, { title: string; description: string }>> = {
  invalid: { title: 'This link is not valid', description: 'It may have expired or been replaced. Ask the contractor to send you a new link.' },
  filled: { title: 'This job has been filled', description: 'Thanks for your interest — it was assigned to someone else.' },
  closed: { title: 'This offer has closed', description: 'The deadline passed or the job was withdrawn.' },
  declined: { title: 'You declined this job', description: 'No further action is needed. Ask the contractor for a new link if you change your mind.' },
};

/** Public, token-secured page where an approved subcontractor reviews a job and submits a price. No customer details are ever shown. */
export function JobBoardOfferPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [offer, setOffer] = useState<VendorOffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [priceError, setPriceError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [skew, setSkew] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((o: VendorOffer) => {
    setOffer(o);
    if (o.server_now) {
      const s = new Date(o.server_now).getTime();
      if (Number.isFinite(s)) setSkew(s - Date.now());
    }
    if (o.my_bid?.price_cents != null) setPrice((o.my_bid.price_cents / 100).toFixed(2));
    if (o.my_bid?.note) setNote(o.my_bid.note);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await jobBoardApi.getOffer(token));
      setError(null);
    } catch (e) {
      if (mounted.current) setError(describeJobBoardError(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [token, apply]);

  useEffect(() => {
    void load();
    const tick = window.setInterval(() => setNow(Date.now()), 5_000);
    const sync = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(sync);
    };
  }, [load]);

  const respond = async (action: 'bid' | 'decline' | 'withdraw') => {
    if (busy) return;
    let cents: number | null = null;
    if (action === 'bid') {
      cents = parseDollarsToCents(price);
      if (cents === null || cents <= 0) {
        setPriceError('Enter your price, e.g. 750 or 750.00');
        return;
      }
    }
    setPriceError(undefined);
    setError(null);
    setBusy(true);
    try {
      apply(await jobBoardApi.respondOffer(token, action, cents, note.trim()));
    } catch (e) {
      setError(describeJobBoardError(e));
      void load();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const state = offer?.state;
  const post = offer?.post;
  const serverNow = now + skew;
  const closed = state ? CLOSED_COPY[state] : undefined;

  return (
    <div className="min-h-screen bg-bg-primary px-4 py-8">
      <main className="mx-auto max-w-lg space-y-4">
        <p className="text-center text-xs font-medium uppercase tracking-wide text-text-secondary">Subcontractor job offer</p>

        {loading ? (
          <SkeletonCardList count={1} rows={4} />
        ) : !offer ? (
          <EmptyState icon={ShieldAlert} title="We couldn’t load this offer" description={error ?? 'Check your connection and try again.'} action={{ label: 'Try again', onClick: () => { setLoading(true); void load(); } }} />
        ) : closed ? (
          <EmptyState icon={ShieldAlert} title={closed.title} description={closed.description} />
        ) : post ? (
          <>
            <article className="space-y-3 rounded-xl border border-border bg-bg-secondary p-5">
              <div className="flex flex-wrap items-center gap-2">
                {offer.company && <span className="text-sm text-text-secondary">From {offer.company}</span>}
                {post.priority === 'urgent' && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-cta/10 px-2 py-0.5 text-xs font-semibold text-cta">
                    <Siren size={12} /> Urgent
                  </span>
                )}
                {(state === 'open' || state === 'bid_submitted') && (
                  <span className="ml-auto inline-flex items-center gap-1 text-xs text-text-secondary">
                    <Clock size={12} /> {formatTimeLeft(post.expires_at, serverNow)}
                  </span>
                )}
              </div>
              <h1 className="font-display text-xl font-semibold text-text-primary">{post.title}</h1>
              {post.summary && <p className="whitespace-pre-line text-sm text-text-secondary">{post.summary}</p>}
              <dl className="space-y-1 text-sm text-text-secondary">
                <div className="flex items-center gap-1.5">
                  <CalendarClock size={14} />
                  {formatShiftWindow(post.starts_at, post.duration_minutes)}
                </div>
                {post.location_label && (
                  <div className="flex items-center gap-1.5">
                    <MapPin size={14} />
                    {post.location_label}
                  </div>
                )}
                {post.skill && <div className="capitalize">Trade: {post.skill}</div>}
                {post.offer_cents !== null && post.offer_cents > 0 && <div className="font-medium text-text-primary">Budget {formatMoney(post.offer_cents)}</div>}
              </dl>
              <p className="text-xs text-text-secondary">The customer’s details are shared only if you are awarded the job.</p>
            </article>

            {state === 'won' && (
              <p className="flex items-start gap-2 rounded-xl border border-success-500/40 bg-success-500/10 p-4 text-sm text-success-500">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                You’ve been awarded this job. {offer.company ?? 'The contractor'} will contact you with the customer details.
              </p>
            )}

            {state === 'not_yet_open' && (
              <p className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm text-warning-500">
                {formatOpensIn(post.opens_at, serverNow)} — the contractor’s own technicians have a short head start. Come back to this page then.
              </p>
            )}

            {(state === 'open' || state === 'bid_submitted') && (
              <section className="space-y-3 rounded-xl border border-border bg-bg-secondary p-5" aria-label="Your bid">
                {state === 'bid_submitted' && (
                  <p className="flex items-center gap-1.5 text-sm text-accent">
                    <CheckCircle2 size={14} /> Your bid is in. You can revise it until the deadline.
                  </p>
                )}
                <Input label="Your price ($)" value={price} onChange={(e) => setPrice(e.target.value)} error={priceError} inputMode="decimal" placeholder="e.g. 750.00" />
                <Input label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="When you can start, anything they should know…" />
                {error && <p className="text-sm text-danger" role="alert">{error}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button size="md" disabled={busy} onClick={() => void respond('bid')}>
                    {busy && <Loader2 size={14} className="animate-spin" />}
                    {state === 'bid_submitted' ? 'Update bid' : 'Submit bid'}
                  </Button>
                  {state === 'bid_submitted' ? (
                    <Button variant="secondary" size="md" disabled={busy} onClick={() => void respond('withdraw')}>
                      Withdraw bid
                    </Button>
                  ) : (
                    <Button variant="ghost" size="md" disabled={busy} onClick={() => void respond('decline')}>
                      Not interested
                    </Button>
                  )}
                </div>
              </section>
            )}
            {state === 'not_yet_open' && error && <p className="text-sm text-danger" role="alert">{error}</p>}
          </>
        ) : null}
      </main>
    </div>
  );
}
