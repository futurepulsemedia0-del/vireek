/**
 * Physical Economy Network - /dashboard/physical-economy-network
 *
 * One page for the six rails (Identity, Protocol, Trust, Outcome, Marketplace, Financial).
 * Every write goes through a database function that re-checks who you are and what you may do;
 * this page only asks. Managers (owner or "manage team" permission) can act, everyone else reads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  ClipboardCheck,
  Clock,
  Copy,
  Fingerprint,
  Handshake,
  Landmark,
  MapPin,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { FadeIn, SkeletonCardList } from '@/components/Skeleton';
import {
  ENGAGEMENT_STATUS_META,
  PEN_CURRENCIES,
  PEN_MAX_FEE_BPS,
  RAIL_META,
  TIER_META,
  URGENCY_META,
  deriveRails,
  formatBps,
  formatMoney,
  formatWhen,
  humanize,
  isValidRegion,
  networkReadiness,
  parseMoneyToCents,
  parseRegions,
  rankOffers,
  referralFeeCents,
  sha256Hex,
  timeLeft,
  validateOfferDraft,
  validateRequestDraft,
  type PenEngagement,
  type PenEvent,
  type PenIdentifier,
  type PenLedgerEntry,
  type PenMyRequest,
  type PenNode,
  type PenOffer,
  type PenOpenRequest,
  type PenOverview,
  type PenRail,
  type PenTrade,
  type PenTrustSummary,
  type PenUrgency,
  type RailLevel,
} from '@/lib/physicalEconomyNetwork';
import {
  acceptOffer,
  cancelEngagement,
  cancelRequest,
  createRequest,
  fetchEngagements,
  fetchEvents,
  fetchIdentifiers,
  fetchLedger,
  fetchLedgerIntegrity,
  fetchMyOffers,
  fetchMyRequests,
  fetchOffers,
  fetchOpenRequests,
  fetchOverview,
  fetchTrades,
  joinNetwork,
  penErrorMessage,
  recordOutcome,
  setNodeStatus,
  settleEngagement,
  submitOffer,
  syncIdentifiers,
  withdrawOffer,
  type JoinInput,
  type PenMyOffer,
} from '@/lib/physicalEconomyNetworkApi';

type Tab = 'overview' | 'marketplace' | 'engagements' | 'network';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'marketplace', label: 'Marketplace' },
  { key: 'engagements', label: 'Engagements' },
  { key: 'network', label: 'Identity, trust & ledger' },
];

const RAIL_ICONS: Record<PenRail, LucideIcon> = {
  identity: Fingerprint,
  protocol: Workflow,
  trust: ShieldCheck,
  outcome: ClipboardCheck,
  marketplace: Handshake,
  financial: Landmark,
};

const LEVEL_META: Record<RailLevel, { label: string; className: string }> = {
  off: { label: 'Not started', className: 'bg-bg-tertiary text-text-secondary' },
  partial: { label: 'In progress', className: 'bg-warning-500/10 text-warning-500' },
  live: { label: 'Live', className: 'bg-success-500/15 text-success-500' },
};

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold';

interface OutcomeValues {
  resolved: boolean;
  rework: boolean;
  satisfaction: number | null;
  notes: string;
  hash: string | null;
}

// ---------------------------------------------------------------- small shared pieces
function TrustChip({ trust }: { trust: PenTrustSummary }) {
  const t = TIER_META[trust.tier];
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`${humanize(trust.confidence)} confidence, ${trust.samples} outcomes`}
    >
      <span className={`${pill} ${t.className}`}>{t.label}</span>
      <span className="text-xs font-semibold text-text-primary">{trust.score}</span>
      {trust.confidence === 'low' && <span className="text-[11px] text-text-secondary">limited data</span>}
    </span>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-text-secondary">{label}</span>
        <span className="font-semibold text-text-primary">{v}</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-bg-tertiary"
        role="progressbar"
        aria-valuenow={v}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card className="!p-5">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-1 break-words text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <Button
      type="button"
      size="sm"
      variant={armed ? 'primary' : 'secondary'}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-text-primary">{children}</h2>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------- join / edit node
function NodePanel({
  trades,
  node,
  busy,
  onSubmit,
  onCancel,
}: {
  trades: PenTrade[];
  node: PenNode | null;
  busy: boolean;
  onSubmit: (i: JoinInput) => void;
  onCancel?: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(node?.trades ?? []);
  const [regions, setRegions] = useState((node?.regions ?? []).join(', '));
  const [fee, setFee] = useState(node ? String(node.referral_fee_bps / 100) : '5');
  const [accepts, setAccepts] = useState(node?.accepts_referrals ?? true);
  const [agree, setAgree] = useState(Boolean(node));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const toggle = (k: string) => setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const parsed = parseRegions(regions);
    if (selected.length === 0) errs.trades = 'Select at least one trade';
    if (parsed.length === 0 || parsed.length > 60 || parsed.some((r) => !isValidRegion(r))) {
      errs.regions = 'Use regions like US, US-TX or GB, separated by commas';
    }
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(fee.trim()) || Math.round(Number(fee) * 100) > PEN_MAX_FEE_BPS) {
      errs.fee = 'Enter a percentage between 0 and 25';
    }
    if (!agree) errs.agree = 'Accept the network terms to continue';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onSubmit({ trades: selected, regions: parsed, acceptsReferrals: accepts, feeBps: Math.round(Number(fee) * 100) });
  };

  return (
    <Card className="!p-6">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">
            {node ? 'Network settings' : 'Join the Physical Economy Network'}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Choose the trades you perform and the regions you serve. Other businesses only ever see a network handle, a
            trust summary and the request details you choose to publish.
          </p>
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-text-primary">Trades you perform</legend>
          <div className="flex flex-wrap gap-2">
            {trades.map((t) => {
              const on = selected.includes(t.trade_key);
              return (
                <button
                  key={t.trade_key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(t.trade_key)}
                  className={`focus-ring rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${on ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:border-accent/40'}`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          {errors.trades && (
            <p role="alert" className="mt-1.5 text-xs text-danger">
              {errors.trades}
            </p>
          )}
        </fieldset>

        <Input
          label="Service regions"
          value={regions}
          onChange={(e) => setRegions(e.target.value)}
          placeholder="US-TX, US-OK, GB"
          error={errors.regions}
          helperText="Country (US) or country-state (US-TX). A country covers all its states."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Referral fee you pay referrers (%)"
            inputMode="decimal"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            error={errors.fee}
            helperText="Paid to the business that sends you a job you win. Maximum 25%."
          />
          <label className="flex items-start gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-primary">
            <input type="checkbox" className="mt-0.5" checked={accepts} onChange={(e) => setAccepts(e.target.checked)} />
            <span>
              Receive matching requests
              <span className="block text-xs text-text-secondary">Turn off to only send work out.</span>
            </span>
          </label>
        </div>

        {!node && (
          <div>
            <label className="flex items-start gap-3 text-sm text-text-primary">
              <input type="checkbox" className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>
                I am authorised to join on behalf of this business and agree to the network terms: outcome reports are
                permanent, contact details are shared only after an offer is accepted, and referral fees are recorded in
                an append-only ledger.
              </span>
            </label>
            {errors.agree && (
              <p role="alert" className="mt-1.5 text-xs text-danger">
                {errors.agree}
              </p>
            )}
          </div>
        )}

        <div className="flex gap-3">
          <Button type="submit" disabled={busy}>
            {node ? 'Save settings' : 'Join network'}
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- marketplace pieces
function OfferForm({
  request,
  existing,
  busy,
  onSubmit,
  onClose,
}: {
  request: PenOpenRequest;
  existing: PenMyOffer | undefined;
  busy: boolean;
  onSubmit: (price: number, eta: number, message: string) => void;
  onClose: () => void;
}) {
  const live = existing && existing.status === 'pending' ? existing : undefined;
  const [price, setPrice] = useState(live ? String(live.price_cents / 100) : '');
  const [eta, setEta] = useState(live ? String(live.eta_hours) : '24');
  const [message, setMessage] = useState(live?.message ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateOfferDraft({ price, etaHours: eta, message });
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onSubmit(parseMoneyToCents(price) as number, Number(eta), message);
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border border-border bg-bg-primary p-4" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label={`Your price (${request.currency.toUpperCase()})`}
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          error={errors.price}
        />
        <Input
          label="Can start within (hours)"
          inputMode="numeric"
          value={eta}
          onChange={(e) => setEta(e.target.value)}
          error={errors.etaHours}
        />
      </div>
      <Textarea
        label="Message (optional)"
        rows={2}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        error={errors.message}
        helperText="No phone numbers or e-mail addresses - contact details are exchanged after acceptance."
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          <Send size={14} /> {live ? 'Update offer' : 'Send offer'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </form>
  );
}

function RequestMeta({
  trade,
  category,
  urgency,
  region,
  expiresAt,
}: {
  trade: string;
  category: string;
  urgency: PenUrgency;
  region: string;
  expiresAt: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold text-text-primary">
        {humanize(trade)} - {humanize(category)}
      </span>
      <span className={`${pill} ${URGENCY_META[urgency].className}`}>{URGENCY_META[urgency].label}</span>
      <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
        <MapPin size={12} />
        {region}
      </span>
      <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
        <Clock size={12} />
        {timeLeft(expiresAt)}
      </span>
    </div>
  );
}

interface RequestValues {
  trade: string;
  category: string;
  urgency: PenUrgency;
  region: string;
  summary: string;
  budgetCents: number | null;
  currency: string;
  expiresHours: number;
}

function RequestForm({
  trades,
  node,
  busy,
  onSubmit,
  onClose,
}: {
  trades: PenTrade[];
  node: PenNode;
  busy: boolean;
  onSubmit: (d: RequestValues) => void;
  onClose: () => void;
}) {
  const [trade, setTrade] = useState(trades[0]?.trade_key ?? '');
  const tradeObj = useMemo(() => trades.find((t) => t.trade_key === trade), [trades, trade]);
  const [category, setCategory] = useState(trades[0]?.categories[0] ?? '');
  const [urgency, setUrgency] = useState<PenUrgency>('standard');
  const [region, setRegion] = useState(node.regions[0] ?? 'US');
  const [summary, setSummary] = useState('');
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('usd');
  const [expiresHours, setExpiresHours] = useState(72);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateRequestDraft({ trade, category, urgency, region, summary, budget, expiresHours }, tradeObj);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onSubmit({
      trade,
      category,
      urgency,
      region: region.trim().toUpperCase(),
      summary,
      budgetCents: budget.trim() ? parseMoneyToCents(budget) : null,
      currency,
      expiresHours,
    });
  };

  return (
    <Card className="!p-6">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <h3 className="text-base font-semibold text-text-primary">Send work to the network</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="pen-trade" className="mb-1.5 block text-sm font-medium text-text-primary">
              Trade needed
            </label>
            <select
              id="pen-trade"
              className={selectClass}
              value={trade}
              onChange={(e) => {
                setTrade(e.target.value);
                setCategory(trades.find((t) => t.trade_key === e.target.value)?.categories[0] ?? '');
              }}
            >
              {trades.map((t) => (
                <option key={t.trade_key} value={t.trade_key}>
                  {t.label}
                </option>
              ))}
            </select>
            {errors.trade && (
              <p role="alert" className="mt-1.5 text-xs text-danger">
                {errors.trade}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="pen-cat" className="mb-1.5 block text-sm font-medium text-text-primary">
              Category
            </label>
            <select id="pen-cat" className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)}>
              {(tradeObj?.categories ?? []).map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
            {errors.category && (
              <p role="alert" className="mt-1.5 text-xs text-danger">
                {errors.category}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="pen-urg" className="mb-1.5 block text-sm font-medium text-text-primary">
              Urgency
            </label>
            <select
              id="pen-urg"
              className={selectClass}
              value={urgency}
              onChange={(e) => setUrgency(e.target.value as PenUrgency)}
            >
              {(Object.keys(URGENCY_META) as PenUrgency[]).map((u) => (
                <option key={u} value={u}>
                  {URGENCY_META[u].label}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Job region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            error={errors.region}
            helperText="US-TX, GB, ..."
          />
          <Input
            label="Indicative budget (optional)"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            error={errors.budget}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="pen-cur" className="mb-1.5 block text-sm font-medium text-text-primary">
                Currency
              </label>
              <select id="pen-cur" className={selectClass} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {PEN_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="pen-exp" className="mb-1.5 block text-sm font-medium text-text-primary">
                Open for
              </label>
              <select
                id="pen-exp"
                className={selectClass}
                value={expiresHours}
                onChange={(e) => setExpiresHours(Number(e.target.value))}
              >
                <option value={6}>6 hours</option>
                <option value={24}>1 day</option>
                <option value={72}>3 days</option>
                <option value={168}>1 week</option>
                <option value={336}>2 weeks</option>
              </select>
            </div>
          </div>
        </div>
        <Textarea
          label="What needs doing?"
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          error={errors.summary}
          helperText="Describe the work, not the customer. No names, addresses, phone numbers or e-mail."
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            <Send size={16} /> Publish request
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function MyRequestCard({
  req,
  canManage,
  busy,
  onAccept,
  onCancel,
}: {
  req: PenMyRequest;
  canManage: boolean;
  busy: boolean;
  onAccept: (offerId: string) => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [offers, setOffers] = useState<PenOffer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setOffers(await fetchOffers(req.id));
    } catch (e) {
      setErr(penErrorMessage(e, 'Could not load offers'));
    } finally {
      setLoading(false);
    }
  }, [req.id]);

  useEffect(() => {
    if (open && canManage) void load();
  }, [open, canManage, load, req.offers_pending]);

  const ranked = useMemo(() => rankOffers(offers ?? []), [offers]);
  const statusClass =
    req.status === 'open'
      ? 'bg-accent/10 text-accent'
      : req.status === 'accepted' || req.status === 'completed'
        ? 'bg-success-500/10 text-success-500'
        : 'bg-bg-tertiary text-text-secondary';

  return (
    <Card className="!p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <RequestMeta
            trade={req.trade_key}
            category={req.category}
            urgency={req.urgency}
            region={req.region}
            expiresAt={req.expires_at}
          />
          <p className="mt-2 text-sm text-text-secondary">{req.summary}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span className={`${pill} ${statusClass}`}>{humanize(req.status)}</span>
            {req.budget_cents !== null && <span>Budget {formatMoney(req.budget_cents, req.currency)}</span>}
            <span>Posted {formatWhen(req.created_at)}</span>
          </div>
        </div>
        {req.status === 'open' && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {req.offers_pending} offer{req.offers_pending === 1 ? '' : 's'}
            </Button>
            {canManage && <ConfirmButton label="Cancel" confirmLabel="Confirm cancel" disabled={busy} onConfirm={onCancel} />}
          </div>
        )}
      </div>
      {open && req.status === 'open' && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          {!canManage && <p className="text-sm text-text-secondary">Only managers can review offers.</p>}
          {canManage && loading && <p className="text-sm text-text-secondary">Loading offers...</p>}
          {err && (
            <p role="alert" className="text-sm text-danger">
              {err}
            </p>
          )}
          {canManage && !loading && !err && ranked.length === 0 && (
            <p className="text-sm text-text-secondary">
              No offers yet. Matching businesses see your request as soon as they open the marketplace.
            </p>
          )}
          {ranked.map((o) => (
            <div key={o.id} className="rounded-xl border border-border bg-bg-primary p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-bold text-text-primary">{formatMoney(o.price_cents, o.currency)}</span>
                    <span className="text-xs text-text-secondary">start within {o.eta_hours}h</span>
                    {o.badges.map((b) => (
                      <span key={b} className={`${pill} bg-accent/10 text-accent`}>
                        {b}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
                    <span>{o.provider_handle}</span>
                    <TrustChip trust={o.provider_trust} />
                    <span>
                      Referral fee to you: {formatBps(o.referral_fee_bps)} ={' '}
                      {formatMoney(referralFeeCents(o.price_cents, o.referral_fee_bps), o.currency)}
                    </span>
                  </div>
                  {o.message && <p className="mt-2 text-sm text-text-primary">{o.message}</p>}
                </div>
                <Button size="sm" disabled={busy} onClick={() => onAccept(o.id)}>
                  <Check size={14} /> Accept
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- engagements
function OutcomeForm({
  eng,
  busy,
  onSubmit,
  onClose,
}: {
  eng: PenEngagement;
  busy: boolean;
  onSubmit: (v: OutcomeValues) => void;
  onClose: () => void;
}) {
  const [resolved, setResolved] = useState('yes');
  const [rework, setRework] = useState(false);
  const [csat, setCsat] = useState('');
  const [notes, setNotes] = useState('');
  const [hash, setHash] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 50 * 1024 * 1024) {
      setError('Choose a file under 50 MB');
      return;
    }
    try {
      setHash(await sha256Hex(await f.arrayBuffer()));
      setFileName(f.name);
      setError('');
    } catch {
      setError('Could not read that file');
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (notes.trim().length > 500) {
      setError('Keep notes under 500 characters');
      return;
    }
    onSubmit({ resolved: resolved === 'yes', rework, satisfaction: csat ? Number(csat) : null, notes, hash });
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border border-border bg-bg-primary p-4" noValidate>
      <p className="text-sm text-text-secondary">
        {eng.my_role === 'provider'
          ? 'Report how the job ended. This is permanent and starts the referral fee.'
          : 'Confirm how the provider did. This is permanent. A report that disagrees with the provider sends the engagement to review.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`res-${eng.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">
            Fixed first time?
          </label>
          <select id={`res-${eng.id}`} className={selectClass} value={resolved} onChange={(e) => setResolved(e.target.value)}>
            <option value="yes">Yes - resolved</option>
            <option value="no">No - not resolved</option>
          </select>
        </div>
        {eng.my_role === 'origin' && (
          <div>
            <label htmlFor={`cs-${eng.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">
              Satisfaction
            </label>
            <select id={`cs-${eng.id}`} className={selectClass} value={csat} onChange={(e) => setCsat(e.target.value)}>
              <option value="">Skip</option>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n} / 5
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="flex items-center gap-2 self-end rounded-xl border border-border px-3 py-2.5 text-sm text-text-primary">
          <input type="checkbox" checked={rework} onChange={(e) => setRework(e.target.checked)} /> Rework was needed
        </label>
      </div>
      <Textarea
        label="Notes (optional)"
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        helperText="No phone numbers or e-mail addresses."
      />
      <div>
        <label htmlFor={`ev-${eng.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">
          Evidence file (optional)
        </label>
        <input
          id={`ev-${eng.id}`}
          type="file"
          className="block w-full text-sm text-text-secondary"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <p className="mt-1 text-xs text-text-secondary">
          {hash
            ? `${fileName}: SHA-256 ${hash.slice(0, 16)}... sealed with your report. The file never leaves your device.`
            : 'Only the file fingerprint (SHA-256) is stored, so the photo or report can be proven later.'}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          Submit report
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </form>
  );
}

function EngagementCard({
  eng,
  canManage,
  busy,
  onOutcome,
  onSettle,
  onCancel,
}: {
  eng: PenEngagement;
  canManage: boolean;
  busy: boolean;
  onOutcome: (v: OutcomeValues) => void;
  onSettle: (reference: string) => void;
  onCancel: () => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [refErr, setRefErr] = useState('');
  const meta = ENGAGEMENT_STATUS_META[eng.status];
  const waitingOnProvider = eng.my_role === 'origin' && eng.status === 'active';
  const canReport =
    canManage &&
    !eng.my_outcome_reported &&
    ((eng.my_role === 'provider' && eng.status === 'active') ||
      (eng.my_role === 'origin' && eng.provider_confirmed_at !== null && eng.status !== 'cancelled'));
  const iEarn = eng.my_role === 'origin';

  return (
    <Card className="!p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">
              {humanize(eng.trade_key)} - {humanize(eng.category)}
            </span>
            <span className={`${pill} ${meta.className}`}>{meta.label}</span>
            <span className={`${pill} bg-bg-tertiary text-text-secondary`}>
              {eng.my_role === 'origin' ? 'You referred' : 'You are the provider'}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-text-secondary">{eng.summary}</p>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <div className="flex gap-1">
              <dt className="text-text-secondary">{eng.my_role === 'origin' ? 'Provider' : 'Referrer'}:</dt>
              <dd className="font-medium text-text-primary">{eng.counterparty_name ?? eng.counterparty_handle}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-text-secondary">Contact:</dt>
              <dd className="font-medium text-text-primary">{eng.counterparty_phone ?? 'Not provided'}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-text-secondary">Agreed price:</dt>
              <dd className="font-medium text-text-primary">{formatMoney(eng.agreed_price_cents, eng.currency)}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-text-secondary">Referral fee:</dt>
              <dd className="font-medium text-text-primary">
                {formatBps(eng.referral_fee_bps)} = {formatMoney(eng.referral_fee_cents, eng.currency)} (
                {humanize(eng.fee_status)})
              </dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-text-secondary">Accepted:</dt>
              <dd className="font-medium text-text-primary">{formatWhen(eng.accepted_at)}</dd>
            </div>
            {eng.settled_at && (
              <div className="flex gap-1">
                <dt className="text-text-secondary">Settled:</dt>
                <dd className="font-medium text-text-primary">
                  {formatWhen(eng.settled_at)} ({eng.settlement_reference})
                </dd>
              </div>
            )}
          </dl>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canReport && (
            <Button size="sm" onClick={() => setFormOpen((v) => !v)}>
              {eng.my_role === 'provider' ? 'Report completion' : 'Confirm outcome'}
            </Button>
          )}
          {canManage && eng.status === 'active' && (
            <ConfirmButton label="Cancel job" confirmLabel="Confirm cancel" disabled={busy} onConfirm={onCancel} />
          )}
        </div>
      </div>
      {waitingOnProvider && (
        <p className="mt-3 text-xs text-text-secondary">Waiting for the provider to report completion.</p>
      )}
      {eng.status === 'disputed' && (
        <p className="mt-3 text-xs text-warning-500">
          The two reports disagree. Vireek reviews disputed jobs; the fee is frozen until then.
        </p>
      )}
      {eng.status === 'completed' && iEarn && eng.fee_status === 'accrued' && !eng.can_settle && (
        <p className="mt-3 text-xs text-text-secondary">
          Confirm the outcome to unlock settlement (it unlocks automatically 14 days after completion).
        </p>
      )}
      {formOpen && canReport && (
        <OutcomeForm
          eng={eng}
          busy={busy}
          onClose={() => setFormOpen(false)}
          onSubmit={(v) => {
            onOutcome(v);
            setFormOpen(false);
          }}
        />
      )}
      {canManage && eng.can_settle && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-bg-primary p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ref.trim().length < 3) {
              setRefErr('Enter the payment reference (3+ characters)');
              return;
            }
            setRefErr('');
            onSettle(ref);
          }}
        >
          <div className="min-w-[220px] flex-1">
            <Input
              label="Payment reference"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              error={refErr}
              placeholder="Bank transfer ID, check number..."
              helperText={`Mark ${formatMoney(eng.referral_fee_cents, eng.currency)} as received.`}
            />
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            Mark fee received
          </Button>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- page
export function PhysicalEconomyNetworkPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<PenOverview | null>(null);
  const [trades, setTrades] = useState<PenTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const [openReqs, setOpenReqs] = useState<PenOpenRequest[]>([]);
  const [myReqs, setMyReqs] = useState<PenMyRequest[]>([]);
  const [myOffers, setMyOffers] = useState<PenMyOffer[]>([]);
  const [offerFor, setOfferFor] = useState<string | null>(null);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [marketLoading, setMarketLoading] = useState(false);

  const [engagements, setEngagements] = useState<PenEngagement[]>([]);
  const [engLoading, setEngLoading] = useState(false);

  const [identifiers, setIdentifiers] = useState<PenIdentifier[]>([]);
  const [ledger, setLedger] = useState<PenLedgerEntry[]>([]);
  const [events, setEvents] = useState<PenEvent[]>([]);
  const [integrity, setIntegrity] = useState<{ groups: number; unbalanced: number; balanced: boolean } | null>(null);
  const [netLoading, setNetLoading] = useState(false);

  const canManage = overview?.can_manage ?? false;
  const node = overview?.node ?? null;

  const loadCore = useCallback(async () => {
    try {
      const [o, t] = await Promise.all([fetchOverview(), fetchTrades()]);
      setOverview(o);
      setTrades(t);
      setLoadError(null);
    } catch (e) {
      setLoadError(penErrorMessage(e, 'Could not load the network. Check your connection and try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMarket = useCallback(async () => {
    setMarketLoading(true);
    try {
      const [o, m, f] = await Promise.all([fetchOpenRequests(), fetchMyRequests(), fetchMyOffers()]);
      setOpenReqs(o);
      setMyReqs(m);
      setMyOffers(f);
    } catch (e) {
      toastRef.current(penErrorMessage(e, 'Could not load the marketplace'), 'error');
    } finally {
      setMarketLoading(false);
    }
  }, []);

  const loadEngagements = useCallback(async () => {
    setEngLoading(true);
    try {
      setEngagements(await fetchEngagements());
    } catch (e) {
      toastRef.current(penErrorMessage(e, 'Could not load engagements'), 'error');
    } finally {
      setEngLoading(false);
    }
  }, []);

  const loadNetwork = useCallback(async (manager: boolean) => {
    setNetLoading(true);
    try {
      setIdentifiers(await fetchIdentifiers());
      if (manager) {
        const [l, ev, ig] = await Promise.all([fetchLedger(), fetchEvents(), fetchLedgerIntegrity()]);
        setLedger(l);
        setEvents(ev);
        setIntegrity(ig);
      }
    } catch (e) {
      toastRef.current(penErrorMessage(e, 'Could not load identity and ledger data'), 'error');
    } finally {
      setNetLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCore();
  }, [loadCore]);

  useEffect(() => {
    if (!node) return;
    if (tab === 'marketplace') void loadMarket();
    if (tab === 'engagements') void loadEngagements();
    if (tab === 'network') void loadNetwork(canManage);
  }, [tab, node, canManage, loadMarket, loadEngagements, loadNetwork]);

  const run = useCallback(async (key: string, fn: () => Promise<unknown>, ok: string, after?: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      toastRef.current(ok, 'success');
      await after?.();
    } catch (e) {
      toastRef.current(penErrorMessage(e, 'That did not work. Please try again.'), 'error');
    } finally {
      setBusy(null);
    }
  }, []);

  const rails = useMemo(() => (overview ? deriveRails(overview) : []), [overview]);
  const readiness = useMemo(() => networkReadiness(rails), [rails]);
  const offerByRequest = useMemo(() => new Map(myOffers.map((o) => [o.request_id, o])), [myOffers]);
  const tradeLabel = useMemo(() => new Map(trades.map((t) => [t.trade_key, t.label])), [trades]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toastRef.current('Copied', 'success');
    } catch {
      toastRef.current('Copy is not available in this browser', 'error');
    }
  };

  const header = (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Network size={16} />
            </span>
            <h1 className="text-2xl font-bold text-text-primary">Physical Economy Network</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            One network for every trade. Identity, protocol, trust, outcomes, marketplace and financial rails working
            together.
          </p>
        </div>
      </div>
      {node && (
        <Button variant="secondary" size="sm" onClick={() => void loadCore()}>
          <RefreshCw size={14} /> Refresh
        </Button>
      )}
    </div>
  );

  if (loading) {
    return (
      <DashboardLayout activeLabel="Physical Economy Network">
        {header}
        <SkeletonCardList count={4} rows={3} />
      </DashboardLayout>
    );
  }

  if (loadError || !overview) {
    return (
      <DashboardLayout activeLabel="Physical Economy Network">
        {header}
        <EmptyState
          icon={Network}
          title="Network unavailable"
          description={loadError ?? 'Something went wrong.'}
          action={{
            label: 'Try again',
            onClick: () => {
              setLoading(true);
              void loadCore();
            },
          }}
        />
      </DashboardLayout>
    );
  }

  const joinInput = (i: JoinInput) =>
    void run('join', () => joinNetwork(i), node ? 'Network settings saved' : 'Welcome to the network', async () => {
      setEditing(false);
      await loadCore();
    });

  if (!node) {
    return (
      <DashboardLayout activeLabel="Physical Economy Network">
        {header}
        {canManage ? (
          <NodePanel trades={trades} node={null} busy={busy === 'join'} onSubmit={joinInput} />
        ) : (
          <EmptyState
            icon={Network}
            title="Your business has not joined yet"
            description="Ask an account owner or a team manager to join the Physical Economy Network."
          />
        )}
      </DashboardLayout>
    );
  }

  const o = overview;
  const resolutionRate =
    o.outcome.completed > 0 ? Math.round((o.outcome.first_time_resolved / o.outcome.completed) * 100) : null;
  const afterMarket = async () => {
    await Promise.all([loadMarket(), loadCore()]);
  };
  const afterEngagement = async () => {
    await Promise.all([loadEngagements(), loadCore()]);
  };

  return (
    <DashboardLayout activeLabel="Physical Economy Network">
      {header}

      <div
        role="tablist"
        aria-label="Network sections"
        className="mb-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`focus-ring whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${tab === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
            {t.key === 'marketplace' && o.protocol.offers_waiting > 0 && (
              <span className="ml-2 rounded-full bg-white/20 px-1.5 text-[11px]">{o.protocol.offers_waiting}</span>
            )}
          </button>
        ))}
      </div>

      {/* ---------------------------------------------------------------- overview */}
      {tab === 'overview' && (
        <FadeIn>
          <div className="space-y-6">
            {editing && canManage ? (
              <NodePanel
                trades={trades}
                node={node}
                busy={busy === 'join'}
                onSubmit={joinInput}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <Card className="!p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xl font-bold text-text-primary">{node.node_handle}</span>
                      <span
                        className={`${pill} ${node.status === 'active' ? 'bg-success-500/15 text-success-500' : 'bg-warning-500/10 text-warning-500'}`}
                      >
                        {node.status === 'active' ? 'Active' : 'Paused'}
                      </span>
                      <button
                        type="button"
                        className="focus-ring rounded-md p-1 text-text-secondary hover:text-text-primary"
                        onClick={() => void copy(node.node_handle)}
                        aria-label="Copy network handle"
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                    <p className="mt-2 text-sm text-text-secondary">
                      {node.trades.map((t) => tradeLabel.get(t) ?? humanize(t)).join(', ')} - {node.regions.join(', ')}
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">
                      {node.accepts_referrals
                        ? `Receiving requests. You pay referrers ${formatBps(node.referral_fee_bps)}.`
                        : 'Not receiving requests.'}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-3">
                    <div className="text-right">
                      <p className="text-3xl font-bold text-text-primary">{readiness}%</p>
                      <p className="text-xs text-text-secondary">network readiness</p>
                    </div>
                    {canManage && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                          Settings
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy === 'status'}
                          onClick={() =>
                            void run(
                              'status',
                              () => setNodeStatus(node.status === 'active' ? 'paused' : 'active'),
                              node.status === 'active' ? 'Node paused' : 'Node resumed',
                              loadCore,
                            )
                          }
                        >
                          {node.status === 'active' ? (
                            <>
                              <Pause size={14} /> Pause
                            </>
                          ) : (
                            <>
                              <Play size={14} /> Resume
                            </>
                          )}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
                <div
                  className="mt-4 h-2 overflow-hidden rounded-full bg-bg-tertiary"
                  role="progressbar"
                  aria-valuenow={readiness}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Network readiness"
                >
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${readiness}%` }} />
                </div>
              </Card>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Requests you can win" value={o.marketplace.matching_open} hint="Open and matching your trades and regions" />
              <Stat label="Offers waiting on you" value={o.protocol.offers_waiting} hint="On requests you published" />
              <Stat label="Active engagements" value={o.marketplace.active_engagements} />
              <Stat
                label="Fixed first time"
                value={resolutionRate === null ? '-' : `${resolutionRate}%`}
                hint={o.outcome.completed === 0 ? 'Appears after your first network job' : `${o.outcome.completed} network job(s)`}
              />
            </div>

            <div>
              <SectionTitle>The six rails</SectionTitle>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {rails.map((r) => {
                  const Icon = RAIL_ICONS[r.rail];
                  const lv = LEVEL_META[r.level];
                  return (
                    <Card key={r.rail} className="!p-5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                            <Icon size={16} />
                          </span>
                          {RAIL_META[r.rail].label}
                        </span>
                        <span className={`${pill} ${lv.className}`}>{lv.label}</span>
                      </div>
                      <p className="mt-3 text-sm font-semibold text-text-primary">{r.headline}</p>
                      <p className="mt-1 break-words text-xs text-text-secondary">{r.detail}</p>
                      <p className="mt-3 text-xs text-text-secondary">{RAIL_META[r.rail].blurb}</p>
                    </Card>
                  );
                })}
              </div>
            </div>
          </div>
        </FadeIn>
      )}

      {/* ---------------------------------------------------------------- marketplace */}
      {tab === 'marketplace' && (
        <FadeIn>
          <div className="space-y-8">
            <section>
              <SectionTitle
                action={
                  canManage && node.status === 'active' ? (
                    <Button size="sm" onClick={() => setShowRequestForm((v) => !v)}>
                      <Plus size={14} /> New request
                    </Button>
                  ) : undefined
                }
              >
                Your requests
              </SectionTitle>
              {showRequestForm && canManage && (
                <div className="mb-4">
                  <RequestForm
                    trades={trades}
                    node={node}
                    busy={busy === 'request'}
                    onClose={() => setShowRequestForm(false)}
                    onSubmit={(d) =>
                      void run('request', () => createRequest(d), 'Request published', async () => {
                        setShowRequestForm(false);
                        await afterMarket();
                      })
                    }
                  />
                </div>
              )}
              {marketLoading && myReqs.length === 0 ? (
                <SkeletonCardList count={2} rows={2} />
              ) : myReqs.length === 0 ? (
                <EmptyState
                  icon={Send}
                  title="Nothing sent yet"
                  description="Found a job outside your trade? Publish it here and verified businesses nearby will offer to take it - you earn a referral fee when it is done well."
                />
              ) : (
                <div className="space-y-3">
                  {myReqs.map((r) => (
                    <MyRequestCard
                      key={r.id}
                      req={r}
                      canManage={canManage}
                      busy={busy !== null}
                      onCancel={() => void run(`cancel-${r.id}`, () => cancelRequest(r.id), 'Request cancelled', afterMarket)}
                      onAccept={(offerId) =>
                        void run(`accept-${offerId}`, () => acceptOffer(offerId), 'Offer accepted - contact details are now shared', async () => {
                          await afterMarket();
                          setTab('engagements');
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </section>

            <section>
              <SectionTitle>Requests you can win</SectionTitle>
              {!node.accepts_referrals || node.status !== 'active' ? (
                <EmptyState
                  icon={Handshake}
                  title="You are not receiving requests"
                  description={
                    node.status !== 'active'
                      ? 'Your node is paused. Resume it from the Overview tab.'
                      : 'Referrals are switched off in your network settings.'
                  }
                />
              ) : marketLoading && openReqs.length === 0 ? (
                <SkeletonCardList count={3} rows={2} />
              ) : openReqs.length === 0 ? (
                <EmptyState
                  icon={Handshake}
                  title="No matching requests right now"
                  description="New requests that match your trades and regions appear here the moment a neighbour publishes them."
                />
              ) : (
                <div className="space-y-3">
                  {openReqs.map((r) => {
                    const mine = offerByRequest.get(r.id);
                    const pending = mine?.status === 'pending';
                    return (
                      <Card key={r.id} className="!p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <RequestMeta
                              trade={r.trade_key}
                              category={r.category}
                              urgency={r.urgency}
                              region={r.region}
                              expiresAt={r.expires_at}
                            />
                            <p className="mt-2 text-sm text-text-secondary">{r.summary}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
                              <span>{r.origin_handle}</span>
                              <TrustChip trust={r.origin_trust} />
                              {r.budget_cents !== null && <span>Budget {formatMoney(r.budget_cents, r.currency)}</span>}
                              {pending && mine && (
                                <span className="font-semibold text-accent">
                                  Your offer: {formatMoney(mine.price_cents, mine.currency)} in {mine.eta_hours}h
                                </span>
                              )}
                            </div>
                          </div>
                          {canManage && (
                            <div className="flex items-center gap-2">
                              {pending && mine && (
                                <ConfirmButton
                                  label="Withdraw"
                                  confirmLabel="Confirm withdraw"
                                  disabled={busy !== null}
                                  onConfirm={() => void run(`wd-${mine.id}`, () => withdrawOffer(mine.id), 'Offer withdrawn', loadMarket)}
                                />
                              )}
                              <Button
                                size="sm"
                                variant={pending ? 'secondary' : 'primary'}
                                onClick={() => setOfferFor(offerFor === r.id ? null : r.id)}
                              >
                                {pending ? 'Revise offer' : 'Make offer'}
                              </Button>
                            </div>
                          )}
                        </div>
                        {offerFor === r.id && canManage && (
                          <OfferForm
                            request={r}
                            existing={mine}
                            busy={busy === `offer-${r.id}`}
                            onClose={() => setOfferFor(null)}
                            onSubmit={(price, eta, msg) =>
                              void run(`offer-${r.id}`, () => submitOffer(r.id, price, eta, msg), 'Offer sent', async () => {
                                setOfferFor(null);
                                await afterMarket();
                              })
                            }
                          />
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </FadeIn>
      )}

      {/* ---------------------------------------------------------------- engagements */}
      {tab === 'engagements' && (
        <FadeIn>
          <SectionTitle>Engagements</SectionTitle>
          {engLoading && engagements.length === 0 ? (
            <SkeletonCardList count={2} rows={3} />
          ) : engagements.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="No engagements yet"
              description="When an offer is accepted, the job appears here with both businesses' contact details, the outcome reports and the referral fee."
            />
          ) : (
            <div className="space-y-3">
              {engagements.map((e) => (
                <EngagementCard
                  key={e.id}
                  eng={e}
                  canManage={canManage}
                  busy={busy !== null}
                  onCancel={() => void run(`ce-${e.id}`, () => cancelEngagement(e.id), 'Engagement cancelled', afterEngagement)}
                  onOutcome={(v) =>
                    void run(
                      `out-${e.id}`,
                      async () => {
                        const r = await recordOutcome({
                          engagementId: e.id,
                          resolved: v.resolved,
                          rework: v.rework,
                          satisfaction: v.satisfaction,
                          notes: v.notes,
                          evidenceSha256: v.hash,
                        });
                        if (r.disputed) {
                          toastRef.current('Your report differs from the other side - the job is now under review', 'info');
                        }
                      },
                      'Outcome recorded',
                      afterEngagement,
                    )
                  }
                  onSettle={(reference) =>
                    void run(`set-${e.id}`, () => settleEngagement(e.id, reference), 'Fee marked as received', afterEngagement)
                  }
                />
              ))}
            </div>
          )}
        </FadeIn>
      )}

      {/* ---------------------------------------------------------------- identity, trust, ledger */}
      {tab === 'network' && (
        <FadeIn>
          <div className="space-y-8">
            <section>
              <SectionTitle
                action={
                  canManage ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === 'sync'}
                      onClick={() =>
                        void run('sync', syncIdentifiers, 'Network IDs issued', async () => {
                          await Promise.all([loadNetwork(canManage), loadCore()]);
                        })
                      }
                    >
                      <Fingerprint size={14} /> Issue network IDs
                    </Button>
                  ) : undefined
                }
              >
                Identity
              </SectionTitle>
              <div className="grid gap-4 sm:grid-cols-3">
                <Stat
                  label="Business"
                  value={o.identity.business_network_id ? 'Identified' : 'Pending'}
                  hint={o.identity.business_network_id ?? undefined}
                />
                <Stat label="Technicians" value={`${o.identity.technicians_identified}/${o.identity.technicians}`} />
                <Stat label="Customer sites" value={`${o.identity.sites_identified}/${o.identity.sites}`} />
              </div>
              {identifiers.length > 0 && (
                <Card className="mt-4 !p-0">
                  <ul className="max-h-72 divide-y divide-border overflow-y-auto">
                    {identifiers.slice(0, 100).map((i) => (
                      <li key={i.network_id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                        <span className="break-all font-mono text-xs text-text-primary">{i.network_id}</span>
                        <span className="flex shrink-0 items-center gap-3 text-xs text-text-secondary">
                          {humanize(i.entity_kind)}
                          <button
                            type="button"
                            className="focus-ring rounded-md p-1 hover:text-text-primary"
                            onClick={() => void copy(i.network_id)}
                            aria-label={`Copy ${i.network_id}`}
                          >
                            <Copy size={13} />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </section>

            <section>
              <SectionTitle>Trust</SectionTitle>
              <Card className="!p-6">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-4xl font-bold text-text-primary">{o.trust.score}</span>
                  <span className={`${pill} ${TIER_META[o.trust.tier].className}`}>{TIER_META[o.trust.tier].label}</span>
                  <span className="text-xs text-text-secondary">
                    {humanize(o.trust.confidence)} confidence - {o.trust.samples} outcome{o.trust.samples === 1 ? '' : 's'} in
                    the last year
                  </span>
                </div>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <ScoreBar label="Verified technicians (35%)" value={o.trust.components.verification} />
                  <ScoreBar label="Insured technicians (15%)" value={o.trust.components.insurance} />
                  <ScoreBar label="Job outcomes, no rework or disputes (35%)" value={o.trust.components.job_outcomes} />
                  <ScoreBar label="Network reliability (15%)" value={o.trust.components.network_reliability} />
                </div>
                <p className="mt-4 text-xs text-text-secondary">
                  Rates are pulled toward a neutral prior until there is enough evidence, so a handful of jobs can never look
                  perfect.
                  {o.trust.adverse_technicians
                    ? ` ${o.trust.adverse_technicians} technician(s) have an adverse verification result - resolve it in Verification Network.`
                    : ''}
                </p>
              </Card>
            </section>

            {canManage && (
              <section>
                <SectionTitle
                  action={
                    integrity ? (
                      <span
                        className={`${pill} ${integrity.balanced ? 'bg-success-500/15 text-success-500' : 'bg-danger/10 text-danger'}`}
                      >
                        {integrity.balanced ? `Books balanced (${integrity.groups} entries)` : `${integrity.unbalanced} unbalanced`}
                      </span>
                    ) : undefined
                  }
                >
                  Financial rail
                </SectionTitle>
                <div className="mb-4 grid gap-4 sm:grid-cols-3">
                  <Stat label="Fees owed to you" value={formatMoney(o.financial.receivable_cents, o.financial.currency)} />
                  <Stat label="Fees you owe" value={formatMoney(o.financial.payable_cents, o.financial.currency)} />
                  <Stat
                    label="Fees received"
                    value={formatMoney(o.financial.received_cents, o.financial.currency)}
                    hint={o.financial.payouts_enabled ? 'Stripe payouts enabled' : 'Stripe payouts not connected'}
                  />
                </div>
                {netLoading && ledger.length === 0 ? (
                  <SkeletonCardList count={1} rows={4} />
                ) : ledger.length === 0 ? (
                  <EmptyState
                    icon={Landmark}
                    title="No ledger entries yet"
                    description="Referral fees are recorded here, in matching debit and credit lines, the moment a provider reports a completed job."
                  />
                ) : (
                  <Card className="!p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="border-b border-border text-xs text-text-secondary">
                          <tr>
                            <th className="px-4 py-2.5 font-medium">Date</th>
                            <th className="px-4 py-2.5 font-medium">Event</th>
                            <th className="px-4 py-2.5 font-medium">Account</th>
                            <th className="px-4 py-2.5 text-right font-medium">Debit</th>
                            <th className="px-4 py-2.5 text-right font-medium">Credit</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {ledger.map((l) => (
                            <tr key={l.id}>
                              <td className="whitespace-nowrap px-4 py-2 text-text-secondary">{formatWhen(l.created_at)}</td>
                              <td className="px-4 py-2 text-text-primary">
                                {humanize(l.kind.replace('fee_', ''))}
                                {l.memo ? <span className="block text-xs text-text-secondary">{l.memo}</span> : null}
                              </td>
                              <td className="px-4 py-2 text-text-secondary">{humanize(l.account)}</td>
                              <td className="px-4 py-2 text-right font-medium text-text-primary">
                                {l.direction === 'debit' ? formatMoney(l.amount_cents, l.currency) : ''}
                              </td>
                              <td className="px-4 py-2 text-right font-medium text-text-primary">
                                {l.direction === 'credit' ? formatMoney(l.amount_cents, l.currency) : ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
                <p className="mt-3 text-xs text-text-secondary">
                  This ledger records who owes whom and when it was settled. It does not move money - settle fees by your usual
                  payment method, then mark them received on the Engagements tab.
                </p>
              </section>
            )}

            {canManage && events.length > 0 && (
              <section>
                <SectionTitle>Recent activity</SectionTitle>
                <Card className="!p-0">
                  <ul className="max-h-72 divide-y divide-border overflow-y-auto">
                    {events.map((ev) => (
                      <li key={ev.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                        <span className="text-text-primary">{humanize(ev.kind)}</span>
                        <span className="text-xs text-text-secondary">{formatWhen(ev.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            )}
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
