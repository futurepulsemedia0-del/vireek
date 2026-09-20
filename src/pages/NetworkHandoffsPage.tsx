import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRightLeft,
  Check,
  Clock,
  Loader2,
  Lock,
  MapPin,
  Phone,
  Plus,
  Siren,
  TriangleAlert as AlertTriangle,
  Users,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { TRADE_CATEGORY_LABELS, TRADE_CATEGORY_OPTIONS } from '@/lib/laborMarketplace';
import { networkApi } from '@/lib/contractorNetworkApi';
import {
  DEFAULT_REFERRAL_FEE_PCT,
  FEE_STATUS_LABELS,
  KIND_LABELS,
  MAX_REFERRAL_FEE_PCT,
  STATUS_COLORS,
  STATUS_LABELS,
  compareFeed,
  describeNetworkError,
  formatMoney,
  formatTimeLeft,
  isUrgent,
  parseDollarsToCents,
  type HandoffContact,
  type HandoffKind,
  type HandoffTab,
  type NetworkHandoff,
  type NetworkHubSummary,
} from '@/lib/contractorNetwork';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

const tradeLabel = (t: string) => (TRADE_CATEGORY_LABELS as Record<string, string>)[t] ?? t;
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;
const isTab = (v: string | null): v is HandoffTab =>
  v === 'feed' || v === 'posted' || v === 'claimed';

// ---------------------------------------------------------------------------
// Post form
// ---------------------------------------------------------------------------

interface FormState {
  kind: HandoffKind;
  trade: string;
  title: string;
  summary: string;
  locationLabel: string;
  neededBy: string;
  value: string;
  fee: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  notes: string;
}

const blankForm = (kind: HandoffKind): FormState => ({
  kind,
  trade: 'general',
  title: '',
  summary: '',
  locationLabel: '',
  neededBy: '',
  value: '',
  fee: String(DEFAULT_REFERRAL_FEE_PCT),
  customerName: '',
  customerPhone: '',
  customerAddress: '',
  notes: '',
});

function PostHandoffForm({
  initial,
  onPosted,
  onCancel,
}: {
  initial: FormState;
  onPosted: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitting, setSubmitting] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    if (submitting) return;
    const next: Partial<Record<keyof FormState, string>> = {};
    const fee = Number(form.fee);
    const valueCents = form.value.trim() ? parseDollarsToCents(form.value) : null;
    const neededBy = form.neededBy ? new Date(form.neededBy) : null;

    if (form.title.trim().length < 3) next.title = 'Give the job a short title (3+ characters).';
    if (!form.customerName.trim()) next.customerName = 'Customer name is required.';
    if (!form.customerPhone.trim() && !form.customerAddress.trim()) {
      next.customerPhone = 'Add a phone number or an address.';
    }
    if (!Number.isFinite(fee) || fee < 0 || fee > MAX_REFERRAL_FEE_PCT) {
      next.fee = `Enter a fee between 0 and ${MAX_REFERRAL_FEE_PCT}%.`;
    }
    if (form.value.trim() && valueCents === null)
      next.value = 'Enter a valid amount, e.g. 450 or 450.00.';
    if (neededBy && Number.isNaN(neededBy.getTime()))
      next.neededBy = 'Enter a valid date and time.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    try {
      await networkApi.post({
        kind: form.kind,
        trade: form.trade,
        title: form.title.trim(),
        summary: form.summary.trim(),
        locationLabel: form.locationLabel.trim(),
        neededBy: neededBy ? neededBy.toISOString() : null,
        estimatedValueCents: valueCents,
        referralFeePct: fee,
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim(),
        customerAddress: form.customerAddress.trim(),
        notes: form.notes.trim(),
      });
      toast(
        form.kind === 'emergency'
          ? 'Emergency broadcast to the network'
          : 'Handoff posted to the network',
        'success',
      );
      onPosted();
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className="space-y-5 rounded-xl border border-border bg-bg-secondary p-5"
      aria-label="Post a handoff"
    >
      <div role="radiogroup" aria-label="Handoff type" className="grid gap-2 sm:grid-cols-2">
        {(['capacity_overflow', 'emergency'] as const).map((k) => {
          const active = form.kind === k;
          const Icon = k === 'emergency' ? Siren : ArrowRightLeft;
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => set('kind', k)}
              className={`focus-ring flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                active
                  ? k === 'emergency'
                    ? 'border-cta bg-cta/5'
                    : 'border-accent bg-accent/5'
                  : 'border-border hover:border-accent/40'
              }`}
            >
              <Icon
                size={18}
                className={k === 'emergency' ? 'mt-0.5 text-cta' : 'mt-0.5 text-accent'}
              />
              <span>
                <span className="block text-sm font-semibold text-text-primary">
                  {KIND_LABELS[k]}
                </span>
                <span className="block text-xs text-text-secondary">
                  {k === 'emergency'
                    ? 'Urgent job. Stays open for 3 hours.'
                    : 'You’re at capacity. Stays open up to 72 hours.'}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ho-trade" className="mb-1.5 block text-sm font-medium text-text-primary">
            Trade
          </label>
          <select
            id="ho-trade"
            value={form.trade}
            onChange={(e) => set('trade', e.target.value)}
            className={selectClass}
          >
            {TRADE_CATEGORY_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {TRADE_CATEGORY_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <Input
          label="Title"
          required
          maxLength={120}
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          error={errors.title}
          placeholder="Rooftop unit not cooling"
        />
      </div>

      <Textarea
        label="Public summary"
        rows={3}
        maxLength={1000}
        value={form.summary}
        onChange={(e) => set('summary', e.target.value)}
        helperText="Visible to every member. Don’t include phone numbers, e-mails or customer names."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          label="Area label"
          maxLength={80}
          value={form.locationLabel}
          onChange={(e) => set('locationLabel', e.target.value)}
          placeholder="Zilker"
        />
        <Input
          label="Needed by"
          type="datetime-local"
          value={form.neededBy}
          onChange={(e) => set('neededBy', e.target.value)}
          error={errors.neededBy}
        />
        <Input
          label="Est. value ($)"
          inputMode="decimal"
          value={form.value}
          onChange={(e) => set('value', e.target.value)}
          error={errors.value}
          placeholder="450"
        />
        <Input
          label="Referral fee (%)"
          inputMode="decimal"
          value={form.fee}
          onChange={(e) => set('fee', e.target.value)}
          error={errors.fee}
          helperText="Paid to you on the final invoice."
        />
      </div>

      <div className="rounded-xl border border-dashed border-border p-4">
        <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Lock size={14} className="text-text-secondary" />
          Private customer details
          <span className="text-xs font-normal text-text-secondary">
            — revealed only to the contractor who accepts
          </span>
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Customer name"
            required
            value={form.customerName}
            onChange={(e) => set('customerName', e.target.value)}
            error={errors.customerName}
          />
          <Input
            label="Customer phone"
            type="tel"
            inputMode="tel"
            value={form.customerPhone}
            onChange={(e) => set('customerPhone', e.target.value)}
            error={errors.customerPhone}
          />
          <Input
            label="Service address"
            value={form.customerAddress}
            onChange={(e) => set('customerAddress', e.target.value)}
          />
          <Input
            label="Access notes"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Gate code, pets…"
          />
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={submitting}>
          {submitting && <Loader2 size={14} className="animate-spin" />}
          {form.kind === 'emergency' ? 'Broadcast emergency' : 'Post handoff'}
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps {
  h: NetworkHandoff;
  mode: HandoffTab;
  now: number;
  contact?: HandoffContact;
  busy: boolean;
  amount: string;
  onAmountChange: (v: string) => void;
  onClaim: () => void;
  onRelease: () => void;
  onCancel: () => void;
  onComplete: () => void;
  onSettle: (outcome: 'settled' | 'waived') => void;
}

function HandoffCard({
  h,
  mode,
  now,
  contact,
  busy,
  amount,
  onAmountChange,
  onClaim,
  onRelease,
  onCancel,
  onComplete,
  onSettle,
}: CardProps) {
  const urgent = isUrgent(h, now);
  const emergency = h.kind === 'emergency';
  const KindIcon = emergency ? Siren : ArrowRightLeft;
  const spinner = busy ? <Loader2 size={14} className="animate-spin" /> : null;

  return (
    <article
      className={`rounded-xl border bg-bg-secondary p-4 ${urgent ? 'border-cta/60' : 'border-border'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
            emergency ? 'bg-cta/10 text-cta' : 'bg-accent/10 text-accent'
          }`}
        >
          <KindIcon size={12} />
          {KIND_LABELS[h.kind]}
        </span>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">
          {tradeLabel(h.trade_category)}
        </span>
        {mode !== 'feed' && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[h.status]}`}
          >
            {STATUS_LABELS[h.status]}
          </span>
        )}
        {h.status === 'open' && (
          <span
            className={`ml-auto inline-flex items-center gap-1 text-xs ${urgent ? 'font-semibold text-cta' : 'text-text-secondary'}`}
          >
            <Clock size={12} />
            {formatTimeLeft(h.expires_at, now)}
          </span>
        )}
      </div>

      <h3 className="mt-2 text-sm font-semibold text-text-primary">{h.title}</h3>
      {h.summary && (
        <p className="mt-1 whitespace-pre-line text-sm text-text-secondary">{h.summary}</p>
      )}

      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-secondary">
        {mode !== 'posted' && (
          <div className="flex gap-1">
            <dt>From</dt>
            <dd className="font-medium text-text-primary">{h.business_name}</dd>
          </div>
        )}
        <div className="flex items-center gap-1">
          <MapPin size={12} />
          <dd className="capitalize">
            {h.location_label ? `${h.location_label} · ` : ''}
            {h.region_key}
          </dd>
        </div>
        {h.estimated_value_cents !== null && (
          <div className="flex gap-1">
            <dt>Est. value</dt>
            <dd className="font-medium text-text-primary">
              {formatMoney(h.estimated_value_cents)}
            </dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt>Referral fee</dt>
          <dd className="font-medium text-text-primary">{h.referral_fee_pct}%</dd>
        </div>
        {h.needed_by && (
          <div className="flex gap-1">
            <dt>Needed by</dt>
            <dd className="font-medium text-text-primary">
              {new Date(h.needed_by).toLocaleString()}
            </dd>
          </div>
        )}
      </dl>

      {/* Feed */}
      {mode === 'feed' && (
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={onClaim} disabled={busy}>
            {spinner}
            Claim this job
          </Button>
        </div>
      )}

      {/* Posted by me */}
      {mode === 'posted' && (
        <>
          {h.status === 'open' && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-xs text-text-secondary">
                Customer details stay hidden until a member accepts.
              </p>
              <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
                {spinner}
                Cancel handoff
              </Button>
            </div>
          )}
          {(h.status === 'claimed' || h.status === 'completed') && (
            <div className="mt-4 rounded-lg bg-bg-tertiary p-3 text-sm">
              <p className="text-text-primary">
                Accepted by{' '}
                <span className="font-semibold">{h.claimed_by_name ?? 'a network member'}</span>
                {h.claimed_by_phone && (
                  <>
                    {' · '}
                    <a
                      href={telHref(h.claimed_by_phone)}
                      className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                    >
                      <Phone size={12} />
                      {h.claimed_by_phone}
                    </a>
                  </>
                )}
              </p>
              {h.status === 'completed' && (
                <p className="mt-1 text-xs text-text-secondary">
                  Final invoice {formatMoney(h.final_amount_cents)} · Referral fee due to you{' '}
                  <span className="font-semibold text-text-primary">
                    {formatMoney(h.referral_fee_cents)}
                  </span>{' '}
                  · {FEE_STATUS_LABELS[h.fee_status]}
                </p>
              )}
              {h.status === 'completed' && h.fee_status === 'pending' && (
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onSettle('waived')}
                    disabled={busy}
                  >
                    Waive fee
                  </Button>
                  <Button size="sm" onClick={() => onSettle('settled')} disabled={busy}>
                    {spinner}
                    <Check size={14} />
                    Mark fee received
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Claimed by me */}
      {mode === 'claimed' && (
        <>
          {contact && (
            <div className="mt-4 rounded-lg border border-accent/20 bg-accent/5 p-3 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">
                Customer details
              </p>
              <p className="mt-1 font-medium text-text-primary">{contact.customer_name}</p>
              {contact.customer_phone && (
                <a
                  href={telHref(contact.customer_phone)}
                  className="mt-0.5 inline-flex items-center gap-1 text-accent hover:underline"
                >
                  <Phone size={13} />
                  {contact.customer_phone}
                </a>
              )}
              {contact.customer_address && (
                <p className="mt-0.5">
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(contact.customer_address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    {contact.customer_address}
                  </a>
                </p>
              )}
              {contact.notes && <p className="mt-1 text-xs text-text-secondary">{contact.notes}</p>}
            </div>
          )}

          {h.status === 'claimed' && (
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
              <div className="w-full sm:w-52">
                <Input
                  label="Final invoice ($)"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => onAmountChange(e.target.value)}
                  placeholder="480.00"
                />
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={onRelease} disabled={busy}>
                  Release
                </Button>
                <Button size="sm" onClick={onComplete} disabled={busy || !amount.trim()}>
                  {spinner}
                  <Check size={14} />
                  Mark completed
                </Button>
              </div>
            </div>
          )}

          {h.status === 'completed' && (
            <p className="mt-3 text-xs text-text-secondary">
              Final invoice {formatMoney(h.final_amount_cents)} · Referral fee owed to{' '}
              {h.business_name}{' '}
              <span className="font-semibold text-text-primary">
                {formatMoney(h.referral_fee_cents)}
              </span>{' '}
              · {FEE_STATUS_LABELS[h.fee_status]}
            </p>
          )}
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type ConfirmAction = { action: 'claim' | 'release' | 'cancel'; handoff: NetworkHandoff };

export function NetworkHandoffsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();

  const [summary, setSummary] = useState<NetworkHubSummary | null>(null);
  const [handoffs, setHandoffs] = useState<NetworkHandoff[]>([]);
  const [contacts, setContacts] = useState<Record<string, HandoffContact>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const [tab, setTab] = useState<HandoffTab>(() => {
    const t = searchParams.get('tab');
    return isTab(t) ? t : 'feed';
  });
  const [kindFilter, setKindFilter] = useState<'all' | HandoffKind>(() =>
    searchParams.get('kind') === 'emergency' ? 'emergency' : 'all',
  );
  const [tradeFilter, setTradeFilter] = useState('all');
  const [showForm, setShowForm] = useState(() => searchParams.get('new') === '1');
  const [prefill, setPrefill] = useState<Partial<FormState> | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [amountDraft, setAmountDraft] = useState<Record<string, string>>({});

  const loadedOnce = useRef(false);
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      await networkApi.expire().catch(() => undefined);
      const [s, rows] = await Promise.all([networkApi.summary(), networkApi.listHandoffs()]);
      const claimedIds = rows.filter((r) => r.claimed_by === s.owner_id).map((r) => r.id);
      const cs = await networkApi.listContacts(claimedIds);
      setSummary(s);
      setHandoffs(rows);
      setContacts(Object.fromEntries(cs.map((c) => [c.handoff_id, c])));
      setNow(Date.now());
      setLoadFailed(false);
      loadedOnce.current = true;
    } catch {
      // A transient failure after the first successful load keeps the data on screen.
      if (!loadedOnce.current) setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep countdowns fresh and re-sync periodically (realtime can miss rows that leave RLS visibility).
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
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

  const liveStatus = useRealtimeSubscription({
    channelName: 'network-handoffs-feed',
    table: 'network_handoffs',
    event: '*',
    onChange: scheduleRefresh,
    enabled: !!summary?.is_member,
  });

  // ?job=<id> deep link: pre-fill the form from an existing job.
  const jobId = searchParams.get('job');
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    void networkApi.jobPrefill(jobId).then((p) => {
      if (cancelled || !p) return;
      setPrefill({
        title: p.service_type ?? '',
        customerName: p.customer_name ?? '',
        customerAddress: p.address ?? '',
      });
      setShowForm(true);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const ownerId = summary?.owner_id;
  const isMember = summary?.is_member ?? false;

  const { feed, posted, claimed } = useMemo(() => {
    const live = handoffs.filter(
      (h) => h.status === 'open' && new Date(h.expires_at).getTime() > now && h.user_id !== ownerId,
    );
    return {
      feed: live
        .filter(
          (h) =>
            (kindFilter === 'all' || h.kind === kindFilter) &&
            (tradeFilter === 'all' || h.trade_category === tradeFilter),
        )
        .sort(compareFeed),
      posted: handoffs.filter((h) => h.user_id === ownerId),
      claimed: handoffs.filter((h) => h.claimed_by === ownerId),
    };
  }, [handoffs, ownerId, now, kindFilter, tradeFilter]);

  const activePosted = posted.filter((h) => h.status === 'open' || h.status === 'claimed').length;
  const activeClaimed = claimed.filter((h) => h.status === 'claimed').length;

  const run = async (id: string, fn: () => Promise<unknown>, success: string) => {
    setBusyId(id);
    try {
      await fn();
      toast(success, 'success');
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      await refresh(); // also clears stale cards (e.g. someone else claimed first)
      setBusyId(null);
    }
  };

  const confirmCopy =
    confirm &&
    {
      claim: {
        title: 'Claim this job?',
        description: `You’ll receive the customer’s contact details and are expected to reach them promptly. A ${confirm.handoff.referral_fee_pct}% referral fee on the final invoice is owed to ${confirm.handoff.business_name}.`,
        label: 'Claim job',
      },
      release: {
        title: 'Release this job?',
        description:
          'It goes back to the network for other contractors. Releases lower your reliability score.',
        label: 'Release job',
      },
      cancel: {
        title: 'Cancel this handoff?',
        description: 'It will be removed from the network feed.',
        label: 'Cancel handoff',
      },
    }[confirm.action];

  // Keep the last copy while the dialog animates out so it never flashes empty.
  const lastCopy = useRef(confirmCopy);
  if (confirmCopy) lastCopy.current = confirmCopy;
  const dialogCopy = confirmCopy ?? lastCopy.current;

  const onConfirm = async () => {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    const id = c.handoff.id;
    if (c.action === 'claim')
      await run(id, () => networkApi.claim(id), 'Job claimed — customer details unlocked');
    else if (c.action === 'release')
      await run(id, () => networkApi.release(id), 'Job released back to the network');
    else await run(id, () => networkApi.cancel(id), 'Handoff cancelled');
  };

  const complete = (h: NetworkHandoff) => {
    const cents = parseDollarsToCents(amountDraft[h.id] ?? '');
    if (cents === null) {
      toast('Enter the final invoice amount, e.g. 480.00', 'error');
      return;
    }
    void run(h.id, () => networkApi.complete(h.id, cents), 'Marked as completed');
  };

  const list = tab === 'feed' ? feed : tab === 'posted' ? posted : claimed;

  const tabs: { id: HandoffTab; label: string; count: number }[] = [
    { id: 'feed', label: 'Live feed', count: feed.length },
    { id: 'posted', label: 'Posted by me', count: activePosted },
    { id: 'claimed', label: 'Claimed by me', count: activeClaimed },
  ];

  return (
    <DashboardLayout activeLabel="Job Handoffs">
      <div className="mx-auto max-w-4xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <ArrowRightLeft size={20} />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-display text-xl font-semibold text-text-primary">
                  Job Handoffs
                </h1>
                <LiveIndicator status={liveStatus} />
              </div>
              <p className="text-sm text-text-secondary">
                Hand off jobs you can’t take — including emergencies — to trusted contractors.
              </p>
            </div>
          </div>
          {isMember && !showForm && (
            <Button size="sm" onClick={() => setShowForm(true)}>
              <Plus size={16} />
              Post a handoff
            </Button>
          )}
        </header>

        {loading ? (
          <SkeletonCardList count={3} />
        ) : loadFailed || !summary ? (
          <EmptyStateError
            icon={AlertTriangle}
            title="Couldn’t load handoffs"
            description="Check your connection and try again. If this keeps happening, the network migration may not be applied yet."
            onRetry={() => {
              setLoading(true);
              void refresh();
            }}
          />
        ) : (
          <>
            {showForm && isMember && (
              <PostHandoffForm
                key={prefill ? 'prefilled' : 'blank'}
                initial={{
                  ...blankForm(
                    searchParams.get('kind') === 'emergency' ? 'emergency' : 'capacity_overflow',
                  ),
                  ...prefill,
                }}
                onCancel={() => setShowForm(false)}
                onPosted={() => {
                  setShowForm(false);
                  setTab('posted');
                  void refresh();
                }}
              />
            )}

            <div role="tablist" aria-label="Handoff views" className="flex flex-wrap gap-2">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`focus-ring rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    tab === t.id
                      ? 'bg-accent text-white'
                      : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {t.label}
                  <span
                    className={`ml-2 text-xs ${tab === t.id ? 'text-white/80' : 'text-text-secondary'}`}
                  >
                    {t.count}
                  </span>
                </button>
              ))}
            </div>

            {tab === 'feed' && isMember && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="ho-kind-filter"
                    className="mb-1.5 block text-xs font-medium text-text-secondary"
                  >
                    Type
                  </label>
                  <select
                    id="ho-kind-filter"
                    value={kindFilter}
                    onChange={(e) => setKindFilter(e.target.value as 'all' | HandoffKind)}
                    className={selectClass}
                  >
                    <option value="all">All types</option>
                    <option value="emergency">Emergency only</option>
                    <option value="capacity_overflow">Capacity overflow only</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="ho-trade-filter"
                    className="mb-1.5 block text-xs font-medium text-text-secondary"
                  >
                    Trade
                  </label>
                  <select
                    id="ho-trade-filter"
                    value={tradeFilter}
                    onChange={(e) => setTradeFilter(e.target.value)}
                    className={selectClass}
                  >
                    <option value="all">All trades</option>
                    {TRADE_CATEGORY_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {TRADE_CATEGORY_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {tab === 'feed' && !isMember ? (
              <EmptyState
                icon={Lock}
                title="Join the Contractor Network to see live handoffs"
                description="Members see and claim jobs from trusted contractors in their region. Customer details stay private until you accept."
                action={{
                  label: 'Go to Contractor Network',
                  onClick: () => navigate('/dashboard/network'),
                }}
              />
            ) : list.length === 0 ? (
              tab === 'feed' ? (
                <EmptyState
                  icon={Users}
                  title="The feed is quiet right now"
                  description="New handoffs from members appear here live. You can also post one of your own."
                  action={{ label: 'Post a handoff', onClick: () => setShowForm(true) }}
                />
              ) : tab === 'posted' ? (
                <EmptyState
                  icon={ArrowRightLeft}
                  title="You haven’t handed off any jobs"
                  description="Overbooked or can’t reach an emergency in time? Hand the job to the network instead of losing the customer."
                  action={
                    isMember
                      ? { label: 'Post a handoff', onClick: () => setShowForm(true) }
                      : undefined
                  }
                />
              ) : (
                <EmptyState
                  icon={Siren}
                  title="You haven’t claimed any jobs"
                  description="Jobs you accept from the live feed show up here with the customer’s contact details."
                  action={{ label: 'Browse the live feed', onClick: () => setTab('feed') }}
                />
              )
            ) : (
              <div className="space-y-3">
                {list.map((h) => (
                  <HandoffCard
                    key={h.id}
                    h={h}
                    mode={tab}
                    now={now}
                    contact={contacts[h.id]}
                    busy={busyId === h.id}
                    amount={amountDraft[h.id] ?? ''}
                    onAmountChange={(v) => setAmountDraft((d) => ({ ...d, [h.id]: v }))}
                    onClaim={() => setConfirm({ action: 'claim', handoff: h })}
                    onRelease={() => setConfirm({ action: 'release', handoff: h })}
                    onCancel={() => setConfirm({ action: 'cancel', handoff: h })}
                    onComplete={() => complete(h)}
                    onSettle={(outcome) =>
                      void run(
                        h.id,
                        () => networkApi.settleFee(h.id, outcome),
                        outcome === 'settled' ? 'Fee marked as received' : 'Fee waived',
                      )
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={dialogCopy?.title ?? ''}
        description={dialogCopy?.description ?? ''}
        confirmLabel={dialogCopy?.label ?? 'Confirm'}
        onConfirm={onConfirm}
        onCancel={() => setConfirm(null)}
      />
    </DashboardLayout>
  );
}
