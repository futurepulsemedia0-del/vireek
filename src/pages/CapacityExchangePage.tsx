// Capacity Exchange — the automated layer on top of Job Handoffs.
//
// Demand -> Vireek -> ranked, certified, in-region capacity -> sequential
// offer -> accept = transfer (same claim path as a manual handoff) ->
// referral-fee split (already on network_handoffs) -> quality rating feeds
// back into future matches. See supabase/migrations/20261201000000_capacity_exchange.sql.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  Clock,
  Gauge,
  Loader2,
  Shuffle,
  Siren,
  Star,
  TriangleAlert as AlertTriangle,
  X,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { TRADE_CATEGORY_LABELS, TRADE_CATEGORY_OPTIONS, type TradeCategory } from '@/lib/laborMarketplace';
import { networkApi, capacityApi } from '@/lib/contractorNetworkApi';
import {
  DEFAULT_REFERRAL_FEE_PCT,
  MATCH_STATUS_COLORS,
  MATCH_STATUS_LABELS,
  MAX_REFERRAL_FEE_PCT,
  describeNetworkError,
  formatMoney,
  formatTimeLeft,
  parseDollarsToCents,
  type CapacityExchangeSummary,
  type CapacityMatchStatus,
  type HandoffMatch,
  type HandoffKind,
  type NetworkHandoff,
} from '@/lib/contractorNetwork';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

const tradeLabel = (t: string) => (TRADE_CATEGORY_LABELS as Record<string, string>)[t] ?? t;

// ---------------------------------------------------------------------------
// Capacity profile card
// ---------------------------------------------------------------------------

function ProfileCard({
  summary,
  onSaved,
}: {
  summary: CapacityExchangeSummary;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [trades, setTrades] = useState<string[]>(summary.certified_trades);
  const [hours, setHours] = useState(String(summary.weekly_capacity_hours));
  const [maxConcurrent, setMaxConcurrent] = useState(String(summary.max_concurrent_handoffs));
  const [autoMatch, setAutoMatch] = useState(summary.auto_match_enabled);
  const [saving, setSaving] = useState(false);

  const toggleTrade = (t: string) =>
    setTrades((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const save = async () => {
    const h = Number(hours);
    const m = Number(maxConcurrent);
    if (!Number.isFinite(h) || h < 0 || h > 168) {
      toast('Weekly capacity must be between 0 and 168 hours.', 'error');
      return;
    }
    if (!Number.isFinite(m) || m < 1 || m > 25) {
      toast('Max concurrent handoffs must be between 1 and 25.', 'error');
      return;
    }
    setSaving(true);
    try {
      await capacityApi.setProfile({
        certifiedTrades: trades,
        weeklyCapacityHours: Math.round(h),
        maxConcurrentHandoffs: Math.round(m),
        autoMatchEnabled: autoMatch,
      });
      toast('Capacity profile saved.', 'success');
      onSaved();
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded-xl border border-border bg-bg-secondary p-5" aria-label="Capacity profile">
      <div className="flex items-center gap-2">
        <Gauge size={18} className="text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Your capacity profile</h2>
      </div>
      <p className="text-sm text-text-secondary">
        This is what the matching engine scores you on when another member posts a smart-matched job. Leave
        certifications empty to be considered for every trade.
      </p>

      <div>
        <p className="mb-2 text-sm font-medium text-text-primary">Certified trades</p>
        <div className="flex flex-wrap gap-2">
          {TRADE_CATEGORY_OPTIONS.map((t) => {
            const active = trades.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleTrade(t)}
                className={`focus-ring rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-text-secondary hover:border-accent/40'
                }`}
              >
                {TRADE_CATEGORY_LABELS[t as TradeCategory]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Weekly free capacity (hours)"
          inputMode="numeric"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          helperText="Roughly how many technician-hours you can absorb from the network each week."
        />
        <Input
          label="Max concurrent smart-matched jobs"
          inputMode="numeric"
          value={maxConcurrent}
          onChange={(e) => setMaxConcurrent(e.target.value)}
          helperText="Vireek stops offering you jobs once you hold this many at once."
        />
      </div>

      <label className="flex items-center gap-2.5 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={autoMatch}
          onChange={(e) => setAutoMatch(e.target.checked)}
          className="h-4 w-4 rounded border-border accent-accent"
        />
        Include me in automatic matching (turn off to only appear in the manual feed)
      </label>

      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Loader2 size={14} className="animate-spin" />}
          Save capacity profile
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stats row
// ---------------------------------------------------------------------------

function StatsRow({ summary }: { summary: CapacityExchangeSummary }) {
  const items = [
    { label: 'Offers waiting on you', value: summary.pending_offers },
    { label: 'Matches you accepted', value: summary.accepted_matches },
    {
      label: 'Your quality rating',
      value: summary.ratings_count > 0 ? `${summary.avg_rating.toFixed(1)} / 5` : '—',
    },
    { label: 'Your smart-matched posts open', value: summary.my_open_smart_handoffs },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((i) => (
        <div key={i.label} className="rounded-xl border border-border bg-bg-secondary p-4">
          <p className="text-2xl font-bold text-text-primary">{i.value}</p>
          <p className="text-xs text-text-secondary">{i.label}</p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Offer card (an incoming match)
// ---------------------------------------------------------------------------

function OfferCard({
  match,
  handoff,
  now,
  busy,
  onRespond,
}: {
  match: HandoffMatch;
  handoff: NetworkHandoff | undefined;
  now: number;
  busy: boolean;
  onRespond: (accept: boolean) => void;
}) {
  const actionable = match.status === 'offered';
  const timeLeft = match.responds_by ? formatTimeLeft(match.responds_by, now) : null;

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            {handoff?.kind === 'emergency' && <Siren size={14} className="text-cta" />}
            <p className="font-semibold text-text-primary">{handoff?.title ?? 'Job details unavailable'}</p>
          </div>
          {handoff && (
            <p className="mt-0.5 text-xs text-text-secondary">
              {tradeLabel(handoff.trade_category)}
              {handoff.location_label ? ` · ${handoff.location_label}` : ''}
              {handoff.estimated_value_cents != null ? ` · Est. ${formatMoney(handoff.estimated_value_cents)}` : ''}
            </p>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
            MATCH_STATUS_COLORS[match.status]
          }`}
        >
          {MATCH_STATUS_LABELS[match.status]}
        </span>
      </div>

      {handoff?.summary && <p className="text-sm text-text-secondary">{handoff.summary}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <div className="flex items-center gap-3 text-xs text-text-secondary">
          <span>Match score: {match.score}</span>
          {actionable && timeLeft && (
            <span className="flex items-center gap-1 font-medium text-accent">
              <Clock size={12} /> Respond within {timeLeft}
            </span>
          )}
          {match.status === 'queued' && <span>Rank #{match.rank} — you'll be offered this if higher ranks pass.</span>}
        </div>
        {actionable && (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => onRespond(false)} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
              Decline
            </Button>
            <Button size="sm" onClick={() => onRespond(true)} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Accept &amp; take the job
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact smart-match posting form
// ---------------------------------------------------------------------------

interface PostForm {
  kind: HandoffKind;
  trade: string;
  title: string;
  summary: string;
  locationLabel: string;
  value: string;
  fee: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  notes: string;
}

const emptyPostForm: PostForm = {
  kind: 'capacity_overflow',
  trade: 'hvac',
  title: '',
  summary: '',
  locationLabel: '',
  value: '',
  fee: String(DEFAULT_REFERRAL_FEE_PCT),
  customerName: '',
  customerPhone: '',
  customerAddress: '',
  notes: '',
};

function PostToExchangeForm({ onPosted }: { onPosted: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PostForm>(emptyPostForm);
  const [submitting, setSubmitting] = useState(false);
  const set = <K extends keyof PostForm>(k: K, v: PostForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (form.title.trim().length < 3) return toast('Give the job a short title.', 'error');
    if (!form.customerName.trim() || (!form.customerPhone.trim() && !form.customerAddress.trim())) {
      return toast('Add the customer name and a phone number or address.', 'error');
    }
    const fee = Number(form.fee);
    if (!Number.isFinite(fee) || fee < 0 || fee > MAX_REFERRAL_FEE_PCT) {
      return toast(`Referral fee must be between 0 and ${MAX_REFERRAL_FEE_PCT}%.`, 'error');
    }
    const valueCents = form.value.trim() ? parseDollarsToCents(form.value) : null;
    if (form.value.trim() && valueCents === null) return toast('Enter a valid estimated value.', 'error');

    setSubmitting(true);
    try {
      await networkApi.post({
        kind: form.kind,
        trade: form.trade,
        title: form.title.trim(),
        summary: form.summary.trim(),
        locationLabel: form.locationLabel.trim(),
        neededBy: null,
        estimatedValueCents: valueCents,
        referralFeePct: fee,
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim(),
        customerAddress: form.customerAddress.trim(),
        notes: form.notes.trim(),
        smartMatch: true,
      });
      toast('Posted. Vireek is ranking capacity and sending the first offer now.', 'success');
      setForm(emptyPostForm);
      setOpen(false);
      onPosted();
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} className="w-full sm:w-auto">
        <Shuffle size={16} /> Post a job to the Capacity Exchange
      </Button>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-bg-secondary p-5" aria-label="Post to exchange">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary">Post to the Capacity Exchange</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
      <p className="text-sm text-text-secondary">
        Vireek scores every opted-in, certified member by trade fit, region, current load and track record, then
        offers the job to the best match first — no manual browsing needed.
      </p>

      <div role="radiogroup" aria-label="Job type" className="grid gap-2 sm:grid-cols-2">
        {(['capacity_overflow', 'emergency'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={form.kind === k}
            onClick={() => set('kind', k)}
            className={`focus-ring flex items-center gap-2 rounded-xl border p-3 text-left text-sm transition-colors ${
              form.kind === k ? 'border-accent bg-accent/5 text-text-primary' : 'border-border text-text-secondary hover:border-accent/40'
            }`}
          >
            {k === 'emergency' ? <Siren size={16} className="text-cta" /> : <ArrowRightLeft size={16} />}
            {k === 'emergency' ? 'Emergency (offers expire fast)' : 'Capacity overflow'}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="cx-trade" className="mb-1.5 block text-sm font-medium text-text-primary">
            Trade
          </label>
          <select id="cx-trade" value={form.trade} onChange={(e) => set('trade', e.target.value)} className={selectClass}>
            {TRADE_CATEGORY_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {TRADE_CATEGORY_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <Input label="Title" required maxLength={120} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Rooftop unit not cooling" />
      </div>

      <Textarea
        label="Public summary"
        rows={3}
        maxLength={1000}
        value={form.summary}
        onChange={(e) => set('summary', e.target.value)}
        helperText="Visible to matched members. No phone numbers, e-mails or customer names here."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="Area label" maxLength={80} value={form.locationLabel} onChange={(e) => set('locationLabel', e.target.value)} placeholder="Zilker" />
        <Input label="Est. value ($)" inputMode="decimal" value={form.value} onChange={(e) => set('value', e.target.value)} placeholder="450" />
        <Input label="Referral fee (%)" inputMode="decimal" value={form.fee} onChange={(e) => set('fee', e.target.value)} />
      </div>

      <div className="rounded-xl border border-dashed border-border p-4">
        <p className="mb-3 text-sm font-semibold text-text-primary">
          Private customer details <span className="font-normal text-text-secondary">— revealed only if a match accepts</span>
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Customer name" required value={form.customerName} onChange={(e) => set('customerName', e.target.value)} />
          <Input label="Customer phone" type="tel" value={form.customerPhone} onChange={(e) => set('customerPhone', e.target.value)} />
          <Input label="Service address" value={form.customerAddress} onChange={(e) => set('customerAddress', e.target.value)} />
          <Input label="Access notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Gate code, pets…" />
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={submitting}>
          {submitting && <Loader2 size={14} className="animate-spin" />}
          Find my best match
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rate a completed match
// ---------------------------------------------------------------------------

function RateCard({ handoff, onRated }: { handoff: NetworkHandoff; onRated: () => void }) {
  const { toast } = useToast();
  const [rating, setRating] = useState(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (rating < 1) return toast('Pick a star rating first.', 'error');
    setSaving(true);
    try {
      await capacityApi.rate(handoff.id, rating, notes.trim());
      toast('Thanks — this feeds their score for future matches.', 'success');
      onRated();
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-secondary p-4">
      <p className="text-sm text-text-primary">
        Rate <span className="font-semibold">{handoff.claimed_by_name ?? 'the contractor'}</span>'s work on "
        {handoff.title}"
      </p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} stars`} className="focus-ring rounded p-0.5">
            <Star size={22} className={n <= rating ? 'fill-accent text-accent' : 'text-text-secondary'} />
          </button>
        ))}
      </div>
      <Textarea
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional note about quality, timeliness, communication…"
        maxLength={500}
      />
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving && <Loader2 size={14} className="animate-spin" />}
          Submit rating
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES: CapacityMatchStatus[] = ['offered', 'queued'];

export function CapacityExchangePage() {
  const { toast } = useToast();
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [summary, setSummary] = useState<CapacityExchangeSummary | null>(null);
  const [matches, setMatches] = useState<HandoffMatch[]>([]);
  const [handoffsById, setHandoffsById] = useState<Record<string, NetworkHandoff>>({});
  const [toRate, setToRate] = useState<NetworkHandoff[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadedOnce = useRef(false);
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      await capacityApi.advanceExpired().catch(() => undefined);
      const [hubSummary, cxSummary, myMatches, myHandoffs, myRatings] = await Promise.all([
        networkApi.summary(),
        capacityApi.summary(),
        capacityApi.listMyMatches(),
        networkApi.listHandoffs(),
        capacityApi.listMyRatingsGiven(),
      ]);
      setOwnerId(hubSummary.owner_id);
      setSummary(cxSummary);
      setMatches(myMatches);
      setHandoffsById(Object.fromEntries(myHandoffs.map((h) => [h.id, h])));
      setToRate(
        myHandoffs.filter(
          (h) => h.user_id === hubSummary.owner_id && h.status === 'completed' && h.claimed_by && !myRatings.has(h.id),
        ),
      );
      setNow(Date.now());
      setLoadFailed(false);
      loadedOnce.current = true;
    } catch {
      if (!loadedOnce.current) setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 20_000);
    const sync = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 60_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(sync);
      window.clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh(), 400);
  }, [refresh]);

  useRealtimeSubscription({
    channelName: 'capacity-exchange-matches',
    table: 'network_handoff_matches',
    event: '*',
    onChange: scheduleRefresh,
    enabled: !!ownerId,
  });

  const respond = async (matchId: string, accept: boolean) => {
    setBusyId(matchId);
    try {
      await capacityApi.respond(matchId, accept);
      toast(accept ? 'Job accepted — coordination details are on the Job Handoffs page.' : 'Offer declined.', 'success');
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      await refresh();
      setBusyId(null);
    }
  };

  const { active, history } = useMemo(() => {
    const sorted = [...matches].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return {
      active: sorted.filter((m) => ACTIVE_STATUSES.includes(m.status)),
      history: sorted.filter((m) => !ACTIVE_STATUSES.includes(m.status)).slice(0, 20),
    };
  }, [matches]);

  return (
    <DashboardLayout activeLabel="Capacity Exchange">
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-text-primary sm:text-2xl">
            <Shuffle size={22} className="text-accent" /> Capacity Exchange
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            The automated version of Job Handoffs: Vireek ranks certified, in-region capacity for every
            smart-matched job and offers it to the best fit first — no browsing required.
          </p>
        </div>

        {loading && !loadedOnce.current && <SkeletonCardList count={3} />}

        {loadFailed && !loadedOnce.current && (
          <EmptyStateError title="Couldn't load the exchange" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void refresh() }} />
        )}

        {summary && (
          <>
            <StatsRow summary={summary} />
            <PostToExchangeForm onPosted={() => void refresh()} />
            <ProfileCard summary={summary} onSaved={() => void refresh()} />

            {toRate.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-base font-semibold text-text-primary">Rate completed work</h2>
                {toRate.map((h) => (
                  <RateCard key={h.id} handoff={h} onRated={() => void refresh()} />
                ))}
              </section>
            )}

            <section className="space-y-3">
              <h2 className="text-base font-semibold text-text-primary">Your offers</h2>
              {active.length === 0 ? (
                <EmptyState
                  icon={AlertTriangle}
                  title="No active offers"
                  description="When your profile matches a smart-matched job, it will show up here first — before it hits the open feed."
                />
              ) : (
                <div className="space-y-3">
                  {active.map((m) => (
                    <OfferCard
                      key={m.id}
                      match={m}
                      handoff={handoffsById[m.handoff_id]}
                      now={now}
                      busy={busyId === m.id}
                      onRespond={(accept) => void respond(m.id, accept)}
                    />
                  ))}
                </div>
              )}
            </section>

            {history.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-base font-semibold text-text-primary">History</h2>
                <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary">
                  {history.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                      <span className="truncate text-text-primary">
                        {handoffsById[m.handoff_id]?.title ?? 'Job no longer visible'}
                      </span>
                      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${MATCH_STATUS_COLORS[m.status]}`}>
                        {MATCH_STATUS_LABELS[m.status]}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
