// Open Job Board & Shift Bidding — pure types, labels and helpers.
//
// Deliberately has NO Supabase / React import so it can be unit-tested without
// env vars (see jobBoard.test.ts). Data access lives in jobBoardApi.ts. The SQL
// (migration 20271102000000_open_job_board.sql) is the source of truth for
// eligibility and fairness; this file only explains and presents its results.

import {
  describeNetworkError,
  formatMoney,
  formatTimeLeft,
  parseDollarsToCents,
} from '@/lib/contractorNetwork';

export { formatMoney, formatTimeLeft, parseDollarsToCents };

export type PostSource = 'unassigned' | 'overflow' | 'reassign';
export type PostAudience = 'internal' | 'subcontractors' | 'both';
export type ClaimMode = 'first_come' | 'bidding';
export type PostPriority = 'normal' | 'urgent';
export type PostStatus = 'open' | 'awarded' | 'expired' | 'cancelled' | 'escalated';
export type AwardedToType = 'technician' | 'vendor' | 'network';
export type AwardedVia = 'claim' | 'bid' | 'auto' | 'override' | 'network';
export type BidStatus = 'active' | 'withdrawn' | 'accepted' | 'rejected';
export type BoardTab = 'board' | 'history' | 'rules';

/** Mirrors public.job_board_posts (dispatcher read). */
export interface JobBoardPost {
  id: string;
  user_id: string;
  job_id: string;
  source: PostSource;
  audience: PostAudience;
  claim_mode: ClaimMode;
  priority: PostPriority;
  skill: string | null;
  area_id: string | null;
  title: string;
  summary: string | null;
  location_label: string | null;
  starts_at: string | null;
  duration_minutes: number | null;
  offer_cents: number | null;
  max_bid_cents: number | null;
  auto_award: boolean;
  status: PostStatus;
  expires_at: string;
  first_look_ends_at: string | null;
  subs_open_at: string | null;
  awarded_to_type: AwardedToType | null;
  awarded_technician_id: string | null;
  awarded_vendor_id: string | null;
  awarded_label: string | null;
  awarded_via: AwardedVia | null;
  awarded_price_cents: number | null;
  awarded_at: string | null;
  override_reason: string | null;
  network_handoff_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Mirrors public.job_board_recipients. */
export interface JobBoardRecipient {
  id: string;
  post_id: string;
  recipient_type: 'technician' | 'vendor';
  technician_id: string | null;
  vendor_id: string | null;
  label: string;
  wave: 1 | 2;
  rank: number;
  fairness_awards: number;
  opens_at: string;
  notified_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
}

/** Mirrors public.job_board_bids. */
export interface JobBoardBid {
  id: string;
  post_id: string;
  bidder_type: 'technician' | 'vendor';
  technician_id: string | null;
  vendor_id: string | null;
  label: string;
  price_cents: number | null;
  note: string | null;
  status: BidStatus;
  created_at: string;
}

export interface JobBoardEvent {
  id: string;
  post_id: string;
  actor_label: string | null;
  event: string;
  detail: Record<string, unknown>;
  created_at: string;
}

/** Return shape of get_job_board_settings(). */
export interface JobBoardSettings {
  default_expiry_minutes: number;
  first_look_minutes: number;
  first_look_size: number;
  internal_first_minutes: number;
  fairness_window_days: number;
  require_skill_match: boolean;
  require_zone_match: boolean;
  respect_time_off: boolean;
  block_schedule_conflicts: boolean;
  max_active_bids_per_technician: number;
  allow_subcontractors: boolean;
  require_sub_documents: boolean;
}

export const DEFAULT_SETTINGS: JobBoardSettings = {
  default_expiry_minutes: 120,
  first_look_minutes: 10,
  first_look_size: 3,
  internal_first_minutes: 15,
  fairness_window_days: 30,
  require_skill_match: true,
  require_zone_match: true,
  respect_time_off: true,
  block_schedule_conflicts: true,
  max_active_bids_per_technician: 5,
  allow_subcontractors: true,
  require_sub_documents: true,
};

/** One row of get_job_board_vendors(). */
export interface JobBoardVendor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  category: string | null;
  tier: string;
  enabled: boolean;
  skills: string[];
  area_ids: string[];
  notes: string | null;
  docs_ok: boolean;
}

/** One row of preview_job_board_audience(). */
export interface AudienceEntry {
  recipient_type: 'technician' | 'vendor';
  technician_id: string | null;
  vendor_id: string | null;
  label: string;
  wave: 1 | 2;
  rank: number;
  awards: number;
  opens_in_minutes: number;
  blockers: string[];
}

/** One row of get_job_board_fairness(). */
export interface FairnessRow {
  technician_id: string;
  name: string;
  awards: number;
  last_awarded_at: string | null;
  open_offers: number;
}

export interface JobBoardSummary {
  open_posts: number;
  awaiting_award: number;
  escalated: number;
  awarded_7d: number;
  expired_7d: number;
  avg_minutes_to_award: number | null;
}

/** One row of get_my_job_board_offers().offers — safe technician-facing fields only. */
export interface TechOffer {
  post_id: string;
  title: string;
  summary: string | null;
  location_label: string | null;
  skill: string | null;
  starts_at: string | null;
  duration_minutes: number | null;
  offer_cents: number | null;
  priority: PostPriority;
  claim_mode: ClaimMode;
  status: PostStatus;
  expires_at: string;
  opens_at: string;
  wave: 1 | 2;
  declined: boolean;
  my_bid_status: BidStatus | null;
  awarded_to_me: boolean;
}

export type OfferState =
  | 'invalid'
  | 'open'
  | 'not_yet_open'
  | 'bid_submitted'
  | 'won'
  | 'filled'
  | 'closed'
  | 'declined';

/** Return shape of get_job_board_offer(token) / respond_job_board_offer(). */
export interface VendorOffer {
  state: OfferState;
  server_now?: string;
  company?: string;
  vendor?: string;
  post?: {
    title: string;
    summary: string | null;
    location_label: string | null;
    skill: string | null;
    starts_at: string | null;
    duration_minutes: number | null;
    offer_cents: number | null;
    priority: PostPriority;
    expires_at: string;
    opens_at: string;
  };
  my_bid?: { price_cents: number | null; note: string | null; status: BidStatus } | null;
}

export interface PostJobInput {
  jobId: string;
  source: PostSource;
  audience: PostAudience;
  claimMode: ClaimMode;
  priority: PostPriority;
  skill: string;
  areaId: string | null;
  title: string;
  summary: string;
  locationLabel: string;
  offerCents: number | null;
  maxBidCents: number | null;
  expiresMinutes: number | null;
  autoAward: boolean;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const SOURCE_LABELS: Record<PostSource, string> = {
  unassigned: 'Unassigned job',
  overflow: 'Overflow',
  reassign: 'Re-assignment',
};

export const AUDIENCE_LABELS: Record<PostAudience, string> = {
  internal: 'Technicians only',
  subcontractors: 'Subcontractors only',
  both: 'Technicians first, then subcontractors',
};

export const CLAIM_MODE_LABELS: Record<ClaimMode, string> = {
  first_come: 'First come, first served',
  bidding: 'Requests & bids — dispatcher awards',
};

export const STATUS_LABELS: Record<PostStatus, string> = {
  open: 'Open',
  awarded: 'Awarded',
  expired: 'Expired',
  cancelled: 'Cancelled',
  escalated: 'With Contractor Network',
};

export const STATUS_COLORS: Record<PostStatus, string> = {
  open: 'bg-success-500/10 text-success-500',
  awarded: 'bg-accent/10 text-accent',
  expired: 'bg-danger/10 text-danger',
  cancelled: 'bg-bg-tertiary text-text-secondary',
  escalated: 'bg-warning-500/10 text-warning-500',
};

export const AWARDED_VIA_LABELS: Record<AwardedVia, string> = {
  claim: 'Claimed',
  bid: 'Bid accepted',
  auto: 'Auto-awarded',
  override: 'Dispatcher override',
  network: 'Contractor Network',
};

export const BLOCKER_LABELS: Record<string, string> = {
  INACTIVE: 'Not an active, dispatch-enabled technician',
  NO_LOGIN: 'Has not accepted their invite yet',
  SKILL: 'Missing the required skill',
  ZONE: 'Does not cover this service zone',
  TIME_OFF: 'Off work or on approved time off',
  CAPACITY: 'Already at their daily job limit',
  CONFLICT: 'Overlaps another job',
  NOT_APPROVED: 'Not an approved subcontractor tier',
  NOT_ENROLLED: 'Not enrolled on the board',
  DOCS: 'Compliance documents missing or expired',
  SUBS_DISABLED: 'Subcontractors are switched off',
};

export const EVENT_LABELS: Record<string, string> = {
  posted: 'Posted to the board',
  awarded: 'Awarded',
  override_awarded: 'Awarded by dispatcher override',
  bid: 'Request / bid received',
  reopened: 'Re-opened',
  cancelled: 'Cancelled',
  expired: 'Expired unclaimed',
  escalated: 'Sent to Contractor Network',
  network_claimed: 'Accepted by a network contractor',
  network_released: 'Released by the network contractor',
  network_completed: 'Completed by the network contractor',
  network_cancelled: 'Network handoff cancelled',
  network_expired: 'Network handoff expired',
  vendor_declined: 'Subcontractor declined',
};

export const TRADE_BY_KEYWORD: Array<[RegExp, string]> = [
  [/plumb|drain|water\s*heater|pipe/i, 'plumbing'],
  [/hvac|\bheat(ing)?\b|cool|furnace|air\s*cond|\bac\b/i, 'hvac'],
  [/electr|wiring|panel/i, 'electrical'],
  [/roof/i, 'roofing'],
  [/restor|mitigat|flood|fire/i, 'restoration'],
  [/lock/i, 'locksmith'],
];

/** Best-effort mapping of a job's service type to a Contractor Network trade slug. */
export function suggestTrade(serviceType: string | null | undefined): string {
  const text = (serviceType ?? '').trim();
  if (!text) return 'general';
  for (const [re, slug] of TRADE_BY_KEYWORD) if (re.test(text)) return slug;
  return 'general';
}

// ---------------------------------------------------------------------------
// Errors — the RPCs raise short machine codes; map them to human copy.
// ---------------------------------------------------------------------------

const ERROR_COPY: Record<string, string> = {
  FORBIDDEN: 'Only owners, admins and team managers can do that.',
  NOT_A_TECHNICIAN: 'This page is for technicians. Dispatchers use the Open Job Board in the dashboard.',
  JOB_NOT_FOUND: 'That job no longer exists.',
  JOB_NOT_POSTABLE: 'Completed, cancelled and in-progress jobs cannot be posted.',
  JOB_ALREADY_ASSIGNED: 'This job already has a technician. Post it as “Overflow” to re-assign it.',
  ALREADY_POSTED: 'This job is already on the board or with the Contractor Network.',
  PII_IN_PUBLIC_FIELDS:
    'Remove phone numbers and e-mail addresses from the title, summary and location — the board never carries customer details.',
  SUBS_DISABLED: 'Subcontractors are switched off in the board rules.',
  NO_ELIGIBLE_RECIPIENTS:
    'Nobody qualifies right now. Relax a rule, pick another zone, or send it to the Contractor Network.',
  EXPIRY_TOO_SOON: 'The job starts too soon (or already started) for a board post. Assign it directly instead.',
  TOO_MANY_OPEN: 'You already have 50 open posts. Cancel or award some first.',
  POST_UNAVAILABLE: 'This shift is no longer available — it may have just been taken.',
  NOT_ELIGIBLE: 'You no longer qualify for this shift.',
  NOT_OPEN_YET: 'This shift is not open to you yet — another technician has a short head start.',
  TOO_MANY_BIDS: 'You have too many pending requests. Withdraw one first.',
  BID_NOT_FOUND: 'That request no longer exists.',
  PRICE_REQUIRED: 'Enter your price for this job.',
  PRICE_ABOVE_MAX: 'That price is above what this job can pay. Lower your bid.',
  OVERRIDE_REASON_REQUIRED: 'An override needs a short reason (3+ characters) for the audit trail.',
  TARGET_REQUIRED: 'Choose exactly one technician or subcontractor.',
  NETWORK_ALREADY_CLAIMED:
    'A network contractor has already accepted this job. Ask them to release it first.',
  NOT_ESCALATABLE: 'Only open or expired posts can be sent to the Contractor Network.',
  VENDOR_NOT_FOUND: 'That subcontractor is not part of this post.',
  AREA_NOT_FOUND: 'That service zone no longer exists.',
  INVALID_TOKEN: 'This link is invalid or has expired. Ask the dispatcher for a new one.',
  INVALID_INPUT: 'Some fields are invalid. Check the form and try again.',
};

/** Reasons carried after the colon of “NOT_ELIGIBLE:SKILL,ZONE”. */
export function parseBlockers(message: string): string[] {
  const m = /NOT_ELIGIBLE:([A-Z_,]+)/.exec(message);
  return m ? m[1].split(',').filter(Boolean) : [];
}

export function describeJobBoardError(err: unknown): string {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : '';
  const blockers = parseBlockers(message);
  if (blockers.length > 0) {
    return `You can’t take this shift: ${blockers.map((b) => BLOCKER_LABELS[b] ?? b).join('; ')}.`;
  }
  // Longest code first so e.g. NOT_OPEN_YET is not shadowed by a shorter prefix.
  const code = Object.keys(ERROR_COPY)
    .sort((a, b) => b.length - a.length)
    .find((c) => message.includes(c));
  return code ? ERROR_COPY[code] : describeNetworkError(err);
}

export function describeBlockers(blockers: string[]): string {
  return blockers.map((b) => BLOCKER_LABELS[b] ?? b).join('; ');
}

// ---------------------------------------------------------------------------
// Technician offer lifecycle
// ---------------------------------------------------------------------------

export type OfferPhase =
  | 'claimable'
  | 'opens_soon'
  | 'requested'
  | 'won'
  | 'lost'
  | 'declined'
  | 'closed';

/** What a technician can do with an offer right now. `now` is injectable for tests. */
export function offerPhase(o: TechOffer, now: number = Date.now()): OfferPhase {
  if (o.awarded_to_me) return 'won';
  if (o.status === 'awarded' || o.status === 'escalated') return 'lost';
  if (o.status !== 'open') return 'closed';
  if (new Date(o.expires_at).getTime() <= now) return 'closed';
  if (o.declined) return 'declined';
  if (o.my_bid_status === 'active') return 'requested';
  if (new Date(o.opens_at).getTime() > now) return 'opens_soon';
  return 'claimable';
}

/** “Opens in 4m” style copy for the head-start window. */
export function formatOpensIn(opensAt: string, now: number = Date.now()): string {
  const ms = new Date(opensAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'Open now';
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `Opens in ${totalSec}s`;
  const min = Math.ceil(totalSec / 60);
  if (min < 60) return `Opens in ${min}m`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `Opens in ${h}h` : `Opens in ${h}h ${min % 60}m`;
}

const PHASE_RANK: Record<OfferPhase, number> = {
  claimable: 0,
  opens_soon: 1,
  requested: 2,
  won: 3,
  lost: 4,
  declined: 5,
  closed: 6,
};

/** Actionable first (urgent, then soonest-expiring); history last (newest first). */
export function compareOffers(a: TechOffer, b: TechOffer, now: number = Date.now()): number {
  const pa = PHASE_RANK[offerPhase(a, now)];
  const pb = PHASE_RANK[offerPhase(b, now)];
  if (pa !== pb) return pa - pb;
  const live = pa <= PHASE_RANK.requested;
  if (live && a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1;
  const ea = new Date(a.expires_at).getTime();
  const eb = new Date(b.expires_at).getTime();
  return live ? ea - eb : eb - ea;
}

// ---------------------------------------------------------------------------
// Dispatcher helpers
// ---------------------------------------------------------------------------

/** Posts a dispatcher still has to act on. */
export function needsAttention(p: Pick<JobBoardPost, 'status'>, activeBids: number): boolean {
  return p.status === 'expired' || (p.status === 'open' && activeBids > 0);
}

/** Active bids: technicians first (internal-first), then subcontractors by lowest price. */
export function sortBids(bids: JobBoardBid[]): JobBoardBid[] {
  return bids
    .filter((b) => b.status === 'active')
    .sort((a, b) => {
      if (a.bidder_type !== b.bidder_type) return a.bidder_type === 'technician' ? -1 : 1;
      if (a.bidder_type === 'vendor') {
        const pa = a.price_cents ?? Number.MAX_SAFE_INTEGER;
        const pb = b.price_cents ?? Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
      }
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
}

export interface AudienceCounts {
  techEligible: number;
  techBlocked: number;
  vendorEligible: number;
  vendorBlocked: number;
  firstLook: number;
}

export function audienceCounts(entries: AudienceEntry[]): AudienceCounts {
  const out: AudienceCounts = { techEligible: 0, techBlocked: 0, vendorEligible: 0, vendorBlocked: 0, firstLook: 0 };
  for (const e of entries) {
    const ok = e.blockers.length === 0;
    if (e.recipient_type === 'technician') {
      if (ok) {
        out.techEligible += 1;
        if (e.wave === 1) out.firstLook += 1;
      } else out.techBlocked += 1;
    } else if (ok) out.vendorEligible += 1;
    else out.vendorBlocked += 1;
  }
  return out;
}

/** Fairness spread: how far apart the busiest and the quietest technician are. */
export function fairnessSpread(rows: FairnessRow[]): { min: number; max: number; spread: number; unbalanced: boolean } {
  if (rows.length === 0) return { min: 0, max: 0, spread: 0, unbalanced: false };
  const counts = rows.map((r) => r.awards);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return { min, max, spread: max - min, unbalanced: max - min >= 3 };
}

export function buildVendorLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/job-board/offer/${encodeURIComponent(token)}`;
}

export function vendorMailto(opts: {
  email: string | null;
  company: string;
  title: string;
  link: string;
}): string | null {
  if (!opts.email) return null;
  const subject = `Job offer from ${opts.company}: ${opts.title}`;
  const body = `Hello,\n\nWe have a job we'd like you to quote on:\n\n${opts.title}\n\nView the details and submit your price here:\n${opts.link}\n\nThank you,\n${opts.company}`;
  return `mailto:${encodeURIComponent(opts.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ---------------------------------------------------------------------------
// Form validation (mirrors the RPC's INVALID_INPUT / PII rules for instant feedback)
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(\d[\s().-]*){9,}/;
export function hasContactInfo(text: string): boolean {
  return EMAIL_RE.test(text) || PHONE_RE.test(text);
}

export interface PostFormValues {
  title: string;
  summary: string;
  locationLabel: string;
  offer: string;
  maxBid: string;
  expiresMinutes: string;
  audience: PostAudience;
  claimMode: ClaimMode;
  autoAward: boolean;
}

export type PostFormErrors = Partial<Record<'title' | 'summary' | 'locationLabel' | 'offer' | 'maxBid' | 'expiresMinutes' | 'autoAward', string>>;

export function validatePostForm(v: PostFormValues): { errors: PostFormErrors; offerCents: number | null; maxBidCents: number | null; expiresMinutes: number | null } {
  const errors: PostFormErrors = {};
  const title = v.title.trim();
  if (title.length < 3 || title.length > 120) errors.title = 'Give the shift a short title (3–120 characters).';
  else if (hasContactInfo(title)) errors.title = 'Remove phone numbers and e-mail addresses — the board never carries customer details.';
  if (v.summary.trim().length > 1000) errors.summary = 'Keep the summary under 1,000 characters.';
  else if (hasContactInfo(v.summary)) errors.summary = 'Remove phone numbers and e-mail addresses.';
  if (v.locationLabel.trim().length > 80) errors.locationLabel = 'Keep the location under 80 characters.';
  else if (hasContactInfo(v.locationLabel)) errors.locationLabel = 'Use a neighbourhood or city, not contact details.';

  let offerCents: number | null = null;
  if (v.offer.trim()) {
    offerCents = parseDollarsToCents(v.offer);
    if (offerCents === null) errors.offer = 'Enter a valid amount, e.g. 150 or 150.00.';
  }
  let maxBidCents: number | null = null;
  if (v.maxBid.trim()) {
    maxBidCents = parseDollarsToCents(v.maxBid);
    if (maxBidCents === null) errors.maxBid = 'Enter a valid amount, e.g. 900 or 900.00.';
  }
  let expiresMinutes: number | null = null;
  if (v.expiresMinutes.trim()) {
    const n = Number(v.expiresMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 10080) errors.expiresMinutes = 'Choose between 5 minutes and 7 days (10080).';
    else expiresMinutes = n;
  }
  if (v.autoAward && v.claimMode !== 'bidding') errors.autoAward = 'Auto-award only applies to requests & bids.';
  return { errors, offerCents, maxBidCents, expiresMinutes };
}

export function validateSettings(s: JobBoardSettings): string | null {
  const within = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!within(s.default_expiry_minutes, 5, 10080)) return 'Default expiry must be between 5 minutes and 7 days.';
  if (!within(s.first_look_minutes, 0, 240)) return 'Head-start window must be between 0 and 240 minutes.';
  if (!within(s.first_look_size, 1, 25)) return 'Head-start group must be 1–25 technicians.';
  if (!within(s.internal_first_minutes, 0, 1440)) return 'Technician-first window must be between 0 and 1,440 minutes.';
  if (!within(s.fairness_window_days, 1, 365)) return 'Fairness window must be 1–365 days.';
  if (!within(s.max_active_bids_per_technician, 1, 50)) return 'Pending requests per technician must be 1–50.';
  return null;
}

export function formatShiftWindow(startsAt: string | null, durationMinutes: number | null): string {
  if (!startsAt) return 'Time to be confirmed';
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return 'Time to be confirmed';
  const date = start.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (!durationMinutes) return date;
  const h = Math.floor(durationMinutes / 60);
  const m = durationMinutes % 60;
  return `${date} · ${h > 0 ? `${h}h` : ''}${m > 0 ? `${h > 0 ? ' ' : ''}${m}m` : ''}`;
}
