// Contractor Network — pure types, labels and helpers.
//
// Deliberately has NO Supabase import so it can be unit-tested without env
// vars (see contractorNetwork.test.ts). Data access lives in
// contractorNetworkApi.ts. Trade slugs are shared with the Labor Marketplace
// (src/lib/laborMarketplace.ts) so the whole network speaks one vertical
// language.

import {
  ArrowRightLeft,
  BarChart3,
  HandHelping,
  LifeBuoy,
  MapPin,
  Package,
  Siren,
  type LucideIcon,
} from 'lucide-react';

export type HandoffKind = 'capacity_overflow' | 'emergency';
export type HandoffStatus = 'open' | 'claimed' | 'completed' | 'cancelled' | 'expired';
export type FeeStatus = 'none' | 'pending' | 'settled' | 'waived';
export type HandoffTab = 'feed' | 'posted' | 'claimed';

/** Mirrors public.network_handoffs — public/anonymised fields only. */
export interface NetworkHandoff {
  id: string;
  user_id: string;
  business_name: string;
  kind: HandoffKind;
  trade_category: string;
  title: string;
  summary: string | null;
  region_key: string;
  location_label: string | null;
  needed_by: string | null;
  estimated_value_cents: number | null;
  referral_fee_pct: number;
  status: HandoffStatus;
  expires_at: string;
  claimed_by: string | null;
  claimed_by_name: string | null;
  claimed_by_phone: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  final_amount_cents: number | null;
  referral_fee_cents: number | null;
  fee_status: FeeStatus;
  released_count: number;
  created_at: string;
  updated_at: string;
}

/** Mirrors public.network_handoff_contacts — private, RLS-gated. */
export interface HandoffContact {
  handoff_id: string;
  customer_name: string;
  customer_phone: string | null;
  customer_address: string | null;
  notes: string | null;
}

/** Return shape of public.get_network_hub_summary(). */
export interface NetworkHubSummary {
  owner_id: string;
  is_member: boolean;
  region_key: string | null;
  contact_phone: string | null;
  joined_at: string | null;
  members_total: number;
  members_in_region: number;
  open_handoffs: number;
  open_emergency: number;
  open_labor_listings: number;
  open_mutual_aid: number;
  handoffs_posted: number;
  handoffs_sent_completed: number;
  active_claims: number;
  handoffs_received_completed: number;
  releases: number;
  reliability_pct: number | null;
  fees_owed_to_me_cents: number;
  fees_i_owe_cents: number;
}

export interface PostHandoffInput {
  kind: HandoffKind;
  trade: string;
  title: string;
  summary: string;
  locationLabel: string;
  neededBy: string | null; // ISO string
  estimatedValueCents: number | null;
  referralFeePct: number;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  notes: string;
}

export const KIND_LABELS: Record<HandoffKind, string> = {
  capacity_overflow: 'Capacity overflow',
  emergency: 'Emergency',
};

export const STATUS_LABELS: Record<HandoffStatus, string> = {
  open: 'Open',
  claimed: 'Claimed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export const STATUS_COLORS: Record<HandoffStatus, string> = {
  open: 'bg-success-500/10 text-success-500',
  claimed: 'bg-accent/10 text-accent',
  completed: 'bg-success-500/10 text-success-500',
  cancelled: 'bg-bg-tertiary text-text-secondary',
  expired: 'bg-danger/10 text-danger',
};

export const FEE_STATUS_LABELS: Record<FeeStatus, string> = {
  none: 'No fee',
  pending: 'Fee pending',
  settled: 'Fee settled',
  waived: 'Fee waived',
};

export const DEFAULT_REFERRAL_FEE_PCT = 10;
export const MAX_REFERRAL_FEE_PCT = 50;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Parses user-typed dollars ("1,234.5", "$80") into integer cents without
 * floating-point math. Returns null for empty / invalid / negative / absurdly
 * large input (the DB column is a 32-bit integer).
 */
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(cents) && cents <= 2_000_000_000 ? cents : null;
}

/** Same rounding as the SQL: round(amount * pct / 100). */
export function calcReferralFeeCents(amountCents: number, pct: number): number {
  return Math.round((amountCents * pct) / 100);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function formatTimeLeft(expiresAt: string, now: number = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'Expired';
  const totalMin = Math.max(1, Math.floor(ms / 60_000));
  if (totalMin < 60) return `${totalMin}m left`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) {
    const m = totalMin % 60;
    return m === 0 ? `${hours}h left` : `${hours}h ${m}m left`;
  }
  return `${Math.floor(hours / 24)}d left`;
}

/** Emergency handoff with under an hour left — worth a visual nudge. */
export function isUrgent(
  h: Pick<NetworkHandoff, 'kind' | 'status' | 'expires_at'>,
  now: number = Date.now(),
): boolean {
  if (h.kind !== 'emergency' || h.status !== 'open') return false;
  const ms = new Date(h.expires_at).getTime() - now;
  return ms > 0 && ms < 3_600_000;
}

/** Emergencies first, then soonest-expiring, then newest. */
export function compareFeed(a: NetworkHandoff, b: NetworkHandoff): number {
  if (a.kind !== b.kind) return a.kind === 'emergency' ? -1 : 1;
  const exp = new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime();
  if (exp !== 0) return exp;
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

// ---------------------------------------------------------------------------
// Errors — the RPCs raise short machine codes; map them to human copy.
// ---------------------------------------------------------------------------

const ERROR_COPY: Record<string, string> = {
  NOT_AUTHENTICATED: 'Your session expired. Please sign in again.',
  NOT_A_MEMBER: 'Join the Contractor Network first.',
  OWNER_ONLY: 'Only the account owner can change network membership.',
  CONTACT_PHONE_REQUIRED: 'Enter a coordination phone number (at least 7 digits).',
  SERVICE_AREA_REQUIRED: 'Set your service area in Business Profile first.',
  PII_IN_PUBLIC_FIELDS:
    'Remove phone numbers and e-mail addresses from the title, summary and location — customer details belong in the private section.',
  CONTACT_REQUIRED: 'Add the customer’s name and a phone number or address.',
  TOO_MANY_OPEN: 'You already have 15 open handoffs. Cancel some or wait for them to be claimed.',
  NEEDED_BY_TOO_SOON: '“Needed by” must be at least 15 minutes from now.',
  TOO_MANY_ACTIVE_CLAIMS: 'You already hold 10 active handoffs. Complete or release one first.',
  HANDOFF_UNAVAILABLE:
    'This handoff is no longer available — another contractor may have just claimed it.',
  HANDOFF_NOT_CANCELLABLE: 'Only open handoffs can be cancelled.',
  INVALID_AMOUNT: 'Enter a valid final invoice amount.',
  INVALID_INPUT: 'Some fields are invalid. Check the form and try again.',
  INVALID_OUTCOME: 'Invalid fee action.',
};

export function describeNetworkError(err: unknown): string {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : '';
  const code = Object.keys(ERROR_COPY).find((c) => message.includes(c));
  return code ? ERROR_COPY[code] : 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Hub capability map — single place to change a link if a route differs.
// ---------------------------------------------------------------------------

export interface NetworkCapability {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
  isNew?: boolean;
  stat?: (s: NetworkHubSummary) => { value: number; label: string };
}

export const NETWORK_CAPABILITIES: NetworkCapability[] = [
  {
    id: 'handoffs',
    title: 'Capacity sharing',
    description:
      'Hand a job you cannot take to a trusted neighbour and earn a referral fee instead of losing the customer.',
    href: '/dashboard/network/handoffs',
    icon: ArrowRightLeft,
    isNew: true,
    stat: (s) => ({ value: s.open_handoffs, label: 'open now' }),
  },
  {
    id: 'emergency',
    title: 'Emergency network',
    description:
      'Broadcast an urgent job that expires in hours, not days. First qualified contractor to accept wins it.',
    href: '/dashboard/network/handoffs?kind=emergency',
    icon: Siren,
    isNew: true,
    stat: (s) => ({ value: s.open_emergency, label: 'urgent now' }),
  },
  {
    id: 'labor',
    title: 'Labor sharing',
    description:
      'Lend idle technicians to other contractors — or borrow extra hands during your busy weeks.',
    href: '/dashboard/labor-marketplace',
    icon: HandHelping,
    stat: (s) => ({ value: s.open_labor_listings, label: 'open listings' }),
  },
  {
    id: 'aid',
    title: 'Disaster mutual aid',
    description:
      'Ask nearby members for overflow calls and crews during storms and regional emergencies.',
    href: '/dashboard/mutual-aid',
    icon: LifeBuoy,
    stat: (s) => ({ value: s.open_mutual_aid, label: 'open requests' }),
  },
  {
    id: 'parts',
    title: 'Parts availability',
    description:
      'Check stock across your locations and network partners before you promise a same-day fix.',
    href: '/dashboard/inventory',
    icon: Package,
  },
  {
    id: 'regional',
    title: 'Regional intelligence',
    description:
      'See demand pressure in your service area so you know when to lend capacity and when to ask for it.',
    href: '/dashboard/regional-demand',
    icon: MapPin,
  },
  {
    id: 'benchmarks',
    title: 'Benchmark network',
    description:
      'Compare your close rate, response time and ticket size with anonymised peers in your trade.',
    href: '/dashboard/benchmarks',
    icon: BarChart3,
  },
];
