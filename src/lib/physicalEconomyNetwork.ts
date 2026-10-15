/**
 * VIREEK Physical Economy Network - client domain logic (pure, no I/O).
 *
 * Backend: supabase/migrations/20270901000000_physical_economy_network.sql
 * Data access: src/lib/physicalEconomyNetworkApi.ts
 *
 * Authoritative rules (trust score, fees, who may see what) live in the database. Everything
 * here is presentation, input validation (a mirror, never a substitute) and ranking.
 */

export type PenRail = 'identity' | 'protocol' | 'trust' | 'outcome' | 'marketplace' | 'financial';
export type PenUrgency = 'emergency' | 'urgent' | 'standard' | 'scheduled';
export type PenTier = 'trusted' | 'established' | 'emerging' | 'unproven' | 'attention';
export type PenConfidence = 'low' | 'medium' | 'high';
export type PenCurrency = 'usd' | 'eur' | 'gbp' | 'cad' | 'aud';

export interface PenTrade {
  trade_key: string;
  label: string;
  description: string;
  sort_order: number;
  protocol_version: number;
  categories: string[];
  required_evidence: string[];
  outcome_metrics: string[];
}

export interface PenNode {
  id: string;
  account_owner_id: string;
  node_handle: string;
  trades: string[];
  regions: string[];
  status: 'active' | 'paused';
  accepts_referrals: boolean;
  referral_fee_bps: number;
  consent_version: string;
  consented_at: string;
}

export interface PenTrust {
  score: number;
  tier: PenTier;
  confidence: PenConfidence;
  samples: number;
  components: {
    verification: number;
    insurance: number;
    job_outcomes: number;
    network_reliability: number;
  };
  technicians?: number;
  verified_technicians?: number;
  adverse_technicians?: number;
  jobs_365d?: number;
  network_engagements_365d?: number;
}

export type PenTrustSummary = Pick<PenTrust, 'score' | 'tier' | 'confidence' | 'samples' | 'components'>;

export interface PenOverview {
  node: PenNode | null;
  can_manage: boolean;
  identity: {
    technicians: number;
    technicians_identified: number;
    sites: number;
    sites_identified: number;
    business_network_id: string | null;
  };
  protocol: { trades_active: number; requests_total: number; requests_open: number; offers_waiting: number };
  trust: PenTrust;
  outcome: { completed: number; first_time_resolved: number; avg_satisfaction: number | null; disputed: number };
  marketplace: { matching_open: number; my_offers_pending: number; active_engagements: number };
  financial: {
    receivable_cents: number;
    payable_cents: number;
    received_cents: number;
    currency: string;
    payouts_enabled: boolean;
    visible: boolean;
  };
}

export interface PenOpenRequest {
  id: string;
  trade_key: string;
  category: string;
  urgency: PenUrgency;
  region: string;
  summary: string;
  payload: Record<string, unknown>;
  budget_cents: number | null;
  currency: PenCurrency;
  expires_at: string;
  created_at: string;
  origin_handle: string;
  origin_trust: PenTrustSummary;
  my_offer_status: 'pending' | 'accepted' | 'declined' | 'withdrawn' | null;
}

export interface PenMyRequest {
  id: string;
  trade_key: string;
  category: string;
  urgency: PenUrgency;
  region: string;
  summary: string;
  budget_cents: number | null;
  currency: PenCurrency;
  status: 'open' | 'accepted' | 'completed' | 'cancelled' | 'expired';
  expires_at: string;
  created_at: string;
  offers_pending: number;
}

export interface PenOffer {
  id: string;
  price_cents: number;
  currency: PenCurrency;
  eta_hours: number;
  message: string | null;
  created_at: string;
  provider_handle: string;
  provider_trust: PenTrustSummary;
  referral_fee_bps: number;
}

export interface PenEngagement {
  id: string;
  my_role: 'origin' | 'provider';
  trade_key: string;
  category: string;
  region: string;
  summary: string;
  agreed_price_cents: number;
  currency: PenCurrency;
  referral_fee_bps: number;
  referral_fee_cents: number;
  status: 'active' | 'completed' | 'disputed' | 'cancelled';
  fee_status: 'none' | 'accrued' | 'settled';
  accepted_at: string;
  provider_confirmed_at: string | null;
  origin_confirmed_at: string | null;
  completed_at: string | null;
  settled_at: string | null;
  settlement_reference: string | null;
  counterparty_name: string | null;
  counterparty_phone: string | null;
  counterparty_handle: string;
  my_outcome_reported: boolean;
  can_settle: boolean;
}

export interface PenLedgerEntry {
  id: string;
  group_id: string;
  engagement_id: string | null;
  kind: 'fee_accrual' | 'fee_settlement' | 'fee_reversal';
  account: string;
  direction: 'debit' | 'credit';
  amount_cents: number;
  currency: string;
  memo: string | null;
  created_at: string;
}

export interface PenIdentifier {
  network_id: string;
  entity_kind: 'business' | 'technician' | 'site';
  entity_id: string;
  created_at: string;
}

export interface PenEvent {
  id: string;
  kind: string;
  entity_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------- constants & presentation

export const PEN_TERMS_VERSION = 'pen-2027-01';
export const PEN_CURRENCIES: PenCurrency[] = ['usd', 'eur', 'gbp', 'cad', 'aud'];
export const PEN_MAX_FEE_BPS = 2500;

export const RAIL_META: Record<PenRail, { label: string; blurb: string }> = {
  identity: { label: 'Identity', blurb: 'Stable network IDs for your business, technicians and sites.' },
  protocol: { label: 'Protocol', blurb: 'One validated request format for every trade.' },
  trust: { label: 'Trust', blurb: 'An evidence-based score that small samples cannot inflate.' },
  outcome: { label: 'Outcome', blurb: 'Two-sided, immutable reports of what actually happened.' },
  marketplace: { label: 'Marketplace', blurb: 'Send and win cross-trade work from verified neighbours.' },
  financial: { label: 'Financial', blurb: 'An append-only ledger for referral fees, settled with proof.' },
};

export const RAIL_ORDER: PenRail[] = ['identity', 'protocol', 'trust', 'outcome', 'marketplace', 'financial'];

export const URGENCY_META: Record<PenUrgency, { label: string; className: string }> = {
  emergency: { label: 'Emergency', className: 'bg-danger/10 text-danger' },
  urgent: { label: 'Urgent', className: 'bg-warning-500/10 text-warning-500' },
  standard: { label: 'Standard', className: 'bg-accent/10 text-accent' },
  scheduled: { label: 'Scheduled', className: 'bg-bg-tertiary text-text-secondary' },
};

export const TIER_META: Record<PenTier, { label: string; className: string }> = {
  trusted: { label: 'Trusted', className: 'bg-success-500/15 text-success-500' },
  established: { label: 'Established', className: 'bg-success-500/10 text-success-500' },
  emerging: { label: 'Emerging', className: 'bg-accent/10 text-accent' },
  unproven: { label: 'Unproven', className: 'bg-bg-tertiary text-text-secondary' },
  attention: { label: 'Needs attention', className: 'bg-danger/10 text-danger' },
};

export const ENGAGEMENT_STATUS_META: Record<PenEngagement['status'], { label: string; className: string }> = {
  active: { label: 'In progress', className: 'bg-accent/10 text-accent' },
  completed: { label: 'Completed', className: 'bg-success-500/10 text-success-500' },
  disputed: { label: 'Under review', className: 'bg-warning-500/10 text-warning-500' },
  cancelled: { label: 'Cancelled', className: 'bg-bg-tertiary text-text-secondary' },
};

export function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function formatMoney(cents: number, currency: string = 'usd'): string {
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return '-';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '-' : new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function timeLeft(iso: string, now: number = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms) || ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)}d left`;
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

// ---------------------------------------------------------------- money (mirrors SQL pen_fee_cents)

/** Integer cents, round half up. Must stay identical to public.pen_fee_cents in the migration. */
export function referralFeeCents(priceCents: number, bps: number): number {
  if (!Number.isInteger(priceCents) || !Number.isInteger(bps) || priceCents < 0 || bps < 0) return 0;
  return Math.floor((priceCents * bps + 5000) / 10000);
}

/** "125.50" -> 12550. Returns null for anything that is not a plain positive amount with <= 2 decimals. */
export function parseMoneyToCents(input: string): number | null {
  const v = input.trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) return null;
  const cents = Math.round(parseFloat(v) * 100);
  return cents >= 1 && cents <= 100_000_000 ? cents : null;
}

// ---------------------------------------------------------------- input validation (mirror of SQL)

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(\d[\s().-]{0,2}){9,}/;

/** Contact details are only shared after an offer is accepted; the database enforces the same rule. */
export function containsContactInfo(text: string): boolean {
  return EMAIL_RE.test(text) || PHONE_RE.test(text);
}

export function isValidRegion(region: string): boolean {
  return /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(region);
}

export function parseRegions(input: string): string[] {
  const out = input
    .split(/[\s,;]+/)
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(out)];
}

export interface RequestDraft {
  trade: string;
  category: string;
  urgency: PenUrgency;
  region: string;
  summary: string;
  budget: string;
  expiresHours: number;
}

export function validateRequestDraft(d: RequestDraft, trade: PenTrade | undefined): Record<string, string> {
  const e: Record<string, string> = {};
  if (!trade) e.trade = 'Choose a trade';
  else if (!trade.categories.includes(d.category)) e.category = 'Choose a category from the trade protocol';
  const region = d.region.trim().toUpperCase();
  if (!isValidRegion(region)) e.region = 'Use a region like US or US-TX';
  const summary = d.summary.trim();
  if (summary.length < 10 || summary.length > 500) e.summary = 'Describe the work in 10-500 characters';
  else if (containsContactInfo(summary)) e.summary = 'Remove phone numbers and e-mail addresses';
  if (d.budget.trim() && parseMoneyToCents(d.budget) === null) e.budget = 'Enter an amount like 450 or 450.50';
  if (!Number.isInteger(d.expiresHours) || d.expiresHours < 1 || d.expiresHours > 720) e.expiresHours = 'Expiry must be 1-720 hours';
  return e;
}

export interface OfferDraft {
  price: string;
  etaHours: string;
  message: string;
}

export function validateOfferDraft(d: OfferDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (parseMoneyToCents(d.price) === null) e.price = 'Enter your price, for example 450 or 450.50';
  const eta = Number(d.etaHours);
  if (!/^\d+$/.test(d.etaHours.trim()) || eta > 720) e.etaHours = 'ETA must be a whole number of hours (0-720)';
  const msg = d.message.trim();
  if (msg.length > 500) e.message = 'Keep the message under 500 characters';
  else if (msg && containsContactInfo(msg)) e.message = 'Remove phone numbers and e-mail addresses';
  return e;
}

// ---------------------------------------------------------------- rails

export type RailLevel = 'off' | 'partial' | 'live';
export interface RailState {
  rail: PenRail;
  level: RailLevel;
  headline: string;
  detail: string;
}

/** Derived purely from the overview payload, so the dashboard never claims more than the data shows. */
export function deriveRails(o: PenOverview): RailState[] {
  const node = o.node;
  if (!node) {
    return RAIL_ORDER.map((rail) => ({
      rail,
      level: 'off' as RailLevel,
      headline: 'Not started',
      detail: 'Join the network to activate this rail.',
    }));
  }
  const idTotal = o.identity.technicians + o.identity.sites;
  const idDone =
    Math.min(o.identity.technicians_identified, o.identity.technicians) +
    Math.min(o.identity.sites_identified, o.identity.sites);
  const idComplete = idDone >= idTotal && o.identity.business_network_id !== null;

  const trust = o.trust;
  const trustLive =
    (trust.tier === 'trusted' || trust.tier === 'established' || trust.tier === 'emerging') &&
    trust.confidence !== 'low';

  const finPartial = !o.financial.payouts_enabled;
  return [
    {
      rail: 'identity',
      level: idComplete ? 'live' : 'partial',
      headline: idComplete ? 'All entities identified' : `${idDone}/${idTotal} identified`,
      detail: o.identity.business_network_id ?? 'Issue network IDs to finish.',
    },
    {
      rail: 'protocol',
      level: node.status === 'active' ? 'live' : 'partial',
      headline: `${node.trades.length} trade${node.trades.length === 1 ? '' : 's'} on protocol v1`,
      detail:
        node.status === 'active' ? `${o.protocol.requests_open} open request(s) from you` : 'Node paused - resume to publish.',
    },
    {
      rail: 'trust',
      level: trustLive ? 'live' : 'partial',
      headline: `${trust.score}/100 - ${TIER_META[trust.tier].label}`,
      detail: `${humanize(trust.confidence)} confidence from ${trust.samples} outcome${trust.samples === 1 ? '' : 's'}`,
    },
    {
      rail: 'outcome',
      level: o.outcome.completed >= 3 ? 'live' : 'partial',
      headline: `${o.outcome.completed} network job${o.outcome.completed === 1 ? '' : 's'} reported`,
      detail:
        o.outcome.completed === 0
          ? 'Outcomes appear after your first network job.'
          : `${o.outcome.first_time_resolved} fixed first time`,
    },
    {
      rail: 'marketplace',
      level: node.status === 'active' && node.accepts_referrals ? 'live' : 'partial',
      headline: `${o.marketplace.matching_open} matching request${o.marketplace.matching_open === 1 ? '' : 's'}`,
      detail: node.accepts_referrals ? `${o.marketplace.active_engagements} active engagement(s)` : 'Referrals are switched off.',
    },
    {
      rail: 'financial',
      level: finPartial ? 'partial' : 'live',
      headline: o.financial.visible
        ? `${formatMoney(o.financial.receivable_cents, o.financial.currency)} receivable`
        : 'Managers only',
      detail: finPartial ? 'Connect Stripe payouts to receive money directly.' : 'Payouts enabled',
    },
  ];
}

export function networkReadiness(rails: RailState[]): number {
  if (rails.length === 0) return 0;
  const pts = rails.reduce((n, r) => n + (r.level === 'live' ? 1 : r.level === 'partial' ? 0.5 : 0), 0);
  return Math.round((pts / rails.length) * 100);
}

// ---------------------------------------------------------------- offer ranking

export interface RankedOffer extends PenOffer {
  rank_score: number;
  badges: string[];
}

/** 45% price, 20% speed, 35% provider trust. Best value on each axis is 1.0, others scale against it. */
export function rankOffers(offers: PenOffer[]): RankedOffer[] {
  if (offers.length === 0) return [];
  const minPrice = Math.min(...offers.map((o) => o.price_cents));
  const minEta = Math.min(...offers.map((o) => o.eta_hours));
  const eligible = offers.filter((o) => o.provider_trust.tier !== 'attention').map((o) => o.provider_trust.score);
  const maxTrust = eligible.length > 0 ? Math.max(...eligible) : -1;
  return offers
    .map((o) => {
      const price = minPrice / o.price_cents;
      const speed = (minEta + 1) / (o.eta_hours + 1);
      const trust = o.provider_trust.tier === 'attention' ? 0 : o.provider_trust.score / 100;
      const badges: string[] = [];
      if (o.price_cents === minPrice) badges.push('Lowest price');
      if (o.eta_hours === minEta) badges.push('Fastest');
      if (o.provider_trust.tier !== 'attention' && o.provider_trust.score === maxTrust) badges.push('Most trusted');
      return { ...o, rank_score: Math.round(100 * (0.45 * price + 0.2 * speed + 0.35 * trust)), badges };
    })
    .sort((a, b) => b.rank_score - a.rank_score || Date.parse(a.created_at) - Date.parse(b.created_at));
}

// ---------------------------------------------------------------- evidence hashing

/** SHA-256 of a file, computed in the browser. The file itself never leaves the device. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
