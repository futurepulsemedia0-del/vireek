import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarClock, CheckCircle2, Clock, Loader2, MapPin, Siren, TriangleAlert as AlertTriangle } from 'lucide-react';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { jobBoardApi } from '@/lib/jobBoardApi';
import {
  compareOffers,
  describeJobBoardError,
  formatMoney,
  formatOpensIn,
  formatShiftWindow,
  formatTimeLeft,
  offerPhase,
  type OfferPhase,
  type TechOffer,
} from '@/lib/jobBoard';

const PHASE_COPY: Record<OfferPhase, { label: string; className: string }> = {
  claimable: { label: 'Open to you', className: 'bg-success-500/10 text-success-500' },
  opens_soon: { label: 'Opens soon', className: 'bg-warning-500/10 text-warning-500' },
  requested: { label: 'Request sent', className: 'bg-accent/10 text-accent' },
  won: { label: 'Yours', className: 'bg-success-500/10 text-success-500' },
  lost: { label: 'Filled', className: 'bg-bg-tertiary text-text-secondary' },
  declined: { label: 'Declined', className: 'bg-bg-tertiary text-text-secondary' },
  closed: { label: 'Closed', className: 'bg-bg-tertiary text-text-secondary' },
};

export function TechnicianJobBoardPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [offers, setOffers] = useState<TechOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [clockSkew, setClockSkew] = useState(0); // server_now - Date.now(): countdowns follow the server clock
  const [busyId, setBusyId] = useState<string | null>(null);
  const mounted = useRef(true);
  const refreshTimer = useRef<number>();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await jobBoardApi.getMyOffers();
      if (!mounted.current) return;
      const server = new Date(res.server_now).getTime();
      if (Number.isFinite(server)) setClockSkew(server - Date.now());
      setOffers(res.offers ?? []);
      setFailed(null);
    } catch (e) {
      if (mounted.current) setFailed(describeJobBoardError(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const tick = window.setInterval(() => setNow(Date.now()), 5_000);
    const sync = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(sync);
      window.clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

  // New offers arrive as notifications (technicians have no direct table access by design).
  useRealtimeSubscription({
    channelName: `tech-job-board-${user?.id ?? 'anon'}`,
    table: 'notifications',
    event: 'INSERT',
    filter: user ? `user_id=eq.${user.id}` : undefined,
    enabled: !!user,
    onChange: () => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void refresh(), 300);
    },
  });

  const serverNow = now + clockSkew;
  const sorted = useMemo(() => offers.slice().sort((a, b) => compareOffers(a, b, serverNow)), [offers, serverNow]);
  const actionable = sorted.filter((o) => ['claimable', 'opens_soon', 'requested'].includes(offerPhase(o, serverNow)));
  const history = sorted.filter((o) => !actionable.includes(o));

  const act = async (o: TechOffer, fn: () => Promise<unknown>, success: (r: unknown) => string) => {
    setBusyId(o.post_id);
    try {
      const r = await fn();
      toast(success(r), 'success');
    } catch (e) {
      toast(describeJobBoardError(e), 'error');
    } finally {
      await refresh();
      if (mounted.current) setBusyId(null);
    }
  };

  return (
    <div className="min-h-screen bg-bg-primary">
      <header className="sticky top-0 z-10 border-b border-border bg-bg-primary/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-3">
          <Link to="/tech/today" aria-label="Back to today" className="focus-ring -ml-1 rounded-lg p-1.5 text-text-secondary">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="font-display text-lg font-semibold text-text-primary">Open shifts</h1>
            <p className="text-xs text-text-secondary">Extra work you qualify for</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-lg space-y-3 px-4 py-4">
        {loading ? (
          <SkeletonCardList count={3} />
        ) : failed ? (
          <EmptyStateError
            icon={AlertTriangle}
            title="Couldn’t load open shifts"
            description={failed}
            onRetry={() => {
              setLoading(true);
              void refresh();
            }}
          />
        ) : offers.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="No open shifts right now"
            description="When your dispatcher posts work that matches your skills and zone, it shows up here and you get a notification."
          />
        ) : (
          <>
            {actionable.length === 0 && (
              <p className="py-2 text-center text-sm text-text-secondary">Nothing open at the moment — recent shifts are below.</p>
            )}
            {actionable.map((o) => (
              <OfferCard key={o.post_id} offer={o} now={serverNow} busy={busyId === o.post_id} act={act} />
            ))}
            {history.length > 0 && (
              <>
                <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Recent</h2>
                {history.map((o) => (
                  <OfferCard key={o.post_id} offer={o} now={serverNow} busy={false} act={act} />
                ))}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function OfferCard({
  offer: o,
  now,
  busy,
  act,
}: {
  offer: TechOffer;
  now: number;
  busy: boolean;
  act: (o: TechOffer, fn: () => Promise<unknown>, success: (r: unknown) => string) => Promise<void>;
}) {
  const phase = offerPhase(o, now);
  const copy = PHASE_COPY[phase];
  const bidding = o.claim_mode === 'bidding';
  const spinner = busy ? <Loader2 size={14} className="animate-spin" /> : null;
  const live = phase === 'claimable' || phase === 'opens_soon' || phase === 'requested';

  return (
    <article className={`rounded-xl border bg-bg-secondary p-4 ${o.priority === 'urgent' && live ? 'border-cta/60' : 'border-border'} ${live ? '' : 'opacity-80'}`}>
      <div className="flex flex-wrap items-center gap-2">
        {o.priority === 'urgent' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-cta/10 px-2 py-0.5 text-xs font-semibold text-cta">
            <Siren size={12} /> Urgent
          </span>
        )}
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${copy.className}`}>{copy.label}</span>
        {live && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-text-secondary">
            <Clock size={12} /> {formatTimeLeft(o.expires_at, now)}
          </span>
        )}
      </div>

      <h3 className="mt-2 text-base font-semibold text-text-primary">{o.title}</h3>
      {o.summary && <p className="mt-1 whitespace-pre-line text-sm text-text-secondary">{o.summary}</p>}

      <dl className="mt-3 space-y-1 text-sm text-text-secondary">
        <div className="flex items-center gap-1.5">
          <CalendarClock size={14} />
          {formatShiftWindow(o.starts_at, o.duration_minutes)}
        </div>
        {o.location_label && (
          <div className="flex items-center gap-1.5">
            <MapPin size={14} />
            {o.location_label}
          </div>
        )}
        {o.offer_cents !== null && o.offer_cents > 0 && <div className="font-medium text-text-primary">Bonus {formatMoney(o.offer_cents)}</div>}
      </dl>

      {phase === 'opens_soon' && (
        <p className="mt-3 rounded-lg bg-warning-500/10 px-3 py-2 text-sm text-warning-500">
          {formatOpensIn(o.opens_at, now)} — a colleague with fewer recent shifts has a short head start.
        </p>
      )}
      {phase === 'won' && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-success-500">
          <CheckCircle2 size={14} /> It’s on your schedule.{' '}
          <Link to="/tech/today" className="focus-ring underline">
            Open today’s jobs
          </Link>
        </p>
      )}
      {phase === 'lost' && <p className="mt-3 text-sm text-text-secondary">This shift was filled.</p>}

      {(phase === 'claimable' || phase === 'requested') && (
        <div className="mt-4 flex flex-wrap gap-2">
          {phase === 'claimable' ? (
            <>
              <Button
                size="md"
                disabled={busy}
                onClick={() =>
                  void act(o, () => jobBoardApi.claim(o.post_id), (r) => (r === 'awarded' ? 'Shift claimed — it’s on your schedule' : 'Request sent to your dispatcher'))
                }
              >
                {spinner}
                {bidding ? 'Request this shift' : 'Claim this shift'}
              </Button>
              <Button variant="ghost" size="md" disabled={busy} onClick={() => void act(o, () => jobBoardApi.decline(o.post_id), () => 'Marked as not interested')}>
                Not interested
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="md" disabled={busy} onClick={() => void act(o, () => jobBoardApi.withdraw(o.post_id), () => 'Request withdrawn')}>
              {spinner}Withdraw request
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
