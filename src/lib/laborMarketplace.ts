// Types, labels and small pure helpers for the Labor-Sharing Marketplace.
// Mirrors the pattern used by src/lib/insuranceClaims.ts and
// src/lib/contracts.ts — no data fetching here, that lives in the page.

export type ListingType = 'offering' | 'requesting';

export type TradeCategory = 'hvac' | 'plumbing' | 'electrical' | 'roofing' | 'restoration' | 'locksmith' | 'general';

export type ListingStatus = 'open' | 'matched' | 'closed' | 'expired';

export type MatchStatus = 'proposed' | 'accepted' | 'declined' | 'completed' | 'cancelled';

export const LISTING_TYPE_LABELS: Record<ListingType, string> = {
  offering: 'Offering technicians',
  requesting: 'Requesting technicians',
};

export const LISTING_TYPE_COLORS: Record<ListingType, string> = {
  offering: 'bg-success-500/10 text-success-500',
  requesting: 'bg-accent/10 text-accent',
};

// Reuses the exact trade slugs already used by src/lib/industries.ts so
// this stays in lockstep with the rest of the app's vertical language.
export const TRADE_CATEGORY_LABELS: Record<TradeCategory, string> = {
  hvac: 'HVAC',
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  roofing: 'Roofing',
  restoration: 'Restoration',
  locksmith: 'Locksmith',
  general: 'General / other trade',
};

export const TRADE_CATEGORY_OPTIONS: TradeCategory[] = [
  'hvac',
  'plumbing',
  'electrical',
  'roofing',
  'restoration',
  'locksmith',
  'general',
];

export const LISTING_STATUS_LABELS: Record<ListingStatus, string> = {
  open: 'Open',
  matched: 'Matched',
  closed: 'Closed',
  expired: 'Expired',
};

export const LISTING_STATUS_COLORS: Record<ListingStatus, string> = {
  open: 'bg-success-500/10 text-success-500',
  matched: 'bg-accent/10 text-accent',
  closed: 'bg-bg-tertiary text-text-secondary',
  expired: 'bg-danger/10 text-danger',
};

export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  declined: 'Declined',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const MATCH_STATUS_COLORS: Record<MatchStatus, string> = {
  proposed: 'bg-warning-500/10 text-warning-500',
  accepted: 'bg-success-500/10 text-success-500',
  declined: 'bg-danger/10 text-danger',
  completed: 'bg-accent/10 text-accent',
  cancelled: 'bg-bg-tertiary text-text-secondary',
};

// A listing still worth showing in the default "browse" view.
export function isOpenListing(status: ListingStatus): boolean {
  return status === 'open';
}

// A match still awaiting a decision from either side.
export function isPendingMatch(status: MatchStatus): boolean {
  return status === 'proposed';
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return 'Rate not listed';
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}/hr`;
}

export function formatDateRange(start: string | null | undefined, end: string | null | undefined): string {
  if (!start && !end) return 'Dates flexible';
  if (start && !end) return `From ${start}`;
  if (!start && end) return `Through ${end}`;
  return `${start} – ${end}`;
}

export function formatLocation(city: string | null | undefined, region: string | null | undefined): string {
  if (!city && !region) return 'Location not listed';
  if (city && region) return `${city}, ${region}`;
  return city || region || 'Location not listed';
}
