import { supabase } from '@/lib/supabase';

/**
 * Talent Network — client library.
 * Thin wrapper over supabase/migrations/20271201000000_talent_network.sql. Authorization and the hire
 * gate live in Postgres (RLS + SECURITY DEFINER RPCs); this file only shapes data and validates input.
 */

// ------------------------------------------------------------------
// Constants (keep in sync with the SQL helper functions)
// ------------------------------------------------------------------

export const TRADES = [
  ['hvac', 'HVAC'], ['plumbing', 'Plumbing'], ['electrical', 'Electrical'], ['roofing', 'Roofing'],
  ['restoration', 'Restoration'], ['locksmith', 'Locksmith'], ['appliance_repair', 'Appliance repair'],
  ['garage_door', 'Garage door'], ['pest_control', 'Pest control'], ['landscaping', 'Landscaping'],
  ['solar', 'Solar'], ['general_handyman', 'General handyman'], ['painting', 'Painting'],
  ['flooring', 'Flooring'], ['carpentry', 'Carpentry'], ['welding', 'Welding'],
] as const;
export type Trade = (typeof TRADES)[number][0];
const TRADE_SET = new Set<string>(TRADES.map((t) => t[0]));

export const WORK_TYPES = [
  ['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contract', 'Contract'], ['gig', 'Gig / overflow'],
] as const;
export type WorkType = (typeof WORK_TYPES)[number][0];

export const WORKER_TAGS: Record<string, string> = {
  reliable: 'Reliable', skilled: 'Skilled', safe_work: 'Safe work', communicates_well: 'Communicates well',
  on_time: 'On time', professional: 'Professional', no_show: 'No-show', unsafe: 'Unsafe',
  poor_quality: 'Poor quality', unprofessional: 'Unprofessional',
};
export const BUSINESS_TAGS: Record<string, string> = {
  paid_on_time: 'Paid on time', clear_scope: 'Clear scope', respectful: 'Respectful', safe_site: 'Safe site',
  good_communication: 'Good communication', late_payment: 'Late payment', unclear_scope: 'Unclear scope',
  unsafe_site: 'Unsafe site', disrespectful: 'Disrespectful',
};
export const REFERENCE_STRENGTHS: Record<string, string> = {
  reliable: 'Reliable', skilled: 'Skilled', safe: 'Safe', teamwork: 'Teamwork', communication: 'Communication',
  leadership: 'Leadership', fast_learner: 'Fast learner',
};
export const RELATIONSHIPS: Record<string, string> = {
  supervisor: 'Supervisor', coworker: 'Coworker', client: 'Client', business_owner: 'Business owner',
  instructor: 'Instructor', other: 'Other',
};
export const REJECTION_REASONS: Record<string, string> = {
  not_a_fit: 'Not a fit for this role', position_filled: 'Position filled', missing_credentials: 'Missing required credentials',
  better_qualified_candidate: 'Another candidate was better qualified', other: 'Other',
};

export type ApplicationStatus = 'submitted' | 'reviewing' | 'interview' | 'offer' | 'hired' | 'rejected' | 'withdrawn';
export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  submitted: 'New', reviewing: 'Reviewing', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn',
};
export const PIPELINE: ApplicationStatus[] = ['submitted', 'reviewing', 'interview', 'offer'];
export type PostingStatus = 'draft' | 'open' | 'paused' | 'filled' | 'closed';
export type PostingKind = 'job' | 'gig';
export type EngagementType = 'w2' | '1099';
export type EngagementStatus = 'onboarding' | 'active' | 'completed' | 'terminated';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface PostingSummary {
  id: string; slug: string; kind: PostingKind; title: string; trade: string; summary: string; company_name: string;
  city: string | null; region: string | null; country: string; employment_type: string; pay_type: string;
  pay_min_cents: number | null; pay_max_cents: number | null; pay_currency: string;
  starts_on: string | null; ends_on: string | null; headcount: number; requires_license: boolean;
  published_at: string | null; company_rating_avg: number | null; company_rating_count: number | null;
}
export interface PostingDetail extends PostingSummary {
  description: string; requirements: string[]; engagement_type: EngagementType;
  requires_background_check: boolean; min_references: number;
}
export interface PostingRow extends Omit<PostingDetail, 'company_rating_avg' | 'company_rating_count'> {
  status: PostingStatus; closed_at: string | null; created_at: string; updated_at: string;
}
export interface PostingInput {
  kind: PostingKind; title: string; trade: string; summary: string; description: string; requirements: string[];
  company_name: string; city: string; region: string; employment_type: string; engagement_type: EngagementType;
  pay_type: string; pay_min: string; pay_max: string; starts_on: string; ends_on: string; headcount: string;
  requires_license: boolean; requires_background_check: boolean; min_references: string;
}

export interface TalentProfile {
  id: string; display_name: string; headline: string | null; bio: string | null; contact_email: string; phone: string | null;
  trades: string[]; experience_years: number | null; city: string | null; region: string | null; country: string;
  service_radius_miles: number | null; open_to: string[]; desired_hourly_cents: number | null;
  availability: 'open' | 'limited' | 'unavailable'; status: 'active' | 'paused'; terms_accepted_at: string | null;
}
export interface ProfileInput {
  display_name: string; headline: string; bio: string; phone: string; trades: string[]; experience_years: string;
  city: string; region: string; country: string; service_radius_miles: string; open_to: string[];
  desired_hourly: string; availability: string; status: string;
}
export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'failed' | 'expired';
export interface Credential {
  id: string; profile_id: string; kind: 'license' | 'certification'; name: string; issuing_authority: string | null;
  credential_number: string | null; region: string | null; issued_on: string | null; expires_on: string | null;
  document_path: string | null; verification_status: VerificationStatus; verification_method: string | null; verified_at: string | null;
}
export interface CredentialInput {
  kind: 'license' | 'certification'; name: string; issuing_authority: string; credential_number: string;
  region: string; issued_on: string; expires_on: string;
}
export interface Reference {
  id: string; referee_name: string; referee_email: string; referee_phone: string | null; relationship: string;
  company: string | null; years_known: number | null; status: 'added' | 'requested' | 'received' | 'declined' | 'expired';
  requested_at: string | null; request_count: number; responded_at: string | null;
}
export interface ReferenceInput { referee_name: string; referee_email: string; referee_phone: string; relationship: string; company: string; years_known: string }

export interface ApplicationRow {
  id: string; posting_id: string; status: ApplicationStatus; cover_note: string | null; expected_rate_cents: number | null;
  profile_snapshot: { display_name?: string; headline?: string; trades?: string[]; experience_years?: number | null; city?: string; region?: string };
  created_at: string; talent_postings: { title: string; kind: PostingKind; slug: string } | null;
}
export interface MyApplication {
  application_id: string; status: ApplicationStatus; applied_at: string; posting_id: string; posting_title: string; company_name: string;
  kind: PostingKind; trade: string; city: string | null; region: string | null; decision_reason: string | null;
  background_check_status: string | null; background_check_url: string | null;
}
export interface ComplianceCheck { key: string; label: string; status: 'pass' | 'fail' | 'pending' | 'warn' | 'info'; blocking: boolean; detail: string }
export interface Compliance { checks: ComplianceCheck[]; blockers: number; can_hire: boolean }
export interface BackgroundCheck {
  id: string; status: string; result: 'clear' | 'consider' | null; decision: 'pending_review' | 'engage' | 'pre_adverse_sent' | 'adverse_final' | null;
  pre_adverse_sent_at: string | null; adverse_final_at: string | null; requested_at: string; completed_at: string | null; package: string; decision_note: string | null;
}
export interface ApplicantDetail {
  application: ApplicationRow & { decision_reason: string | null; decision_note: string | null; availability_note: string | null };
  profile: (Omit<TalentProfile, 'id' | 'status' | 'service_radius_miles' | 'terms_accepted_at'>) | null;
  credentials: Array<Credential & { attestation: { outcome: string; method: string; note: string | null; at: string } | null }>;
  references: Array<{ id: string; referee_name: string; relationship: string; company: string | null; status: string; rating: number | null; would_rehire: string | null; strengths: string[]; comment: string | null; responded_at: string | null }>;
  background_check: BackgroundCheck | null;
  compliance: Compliance;
  reputation: Reputation | null;
  events: Array<{ kind: string; actor_role: string; detail: Record<string, unknown>; created_at: string }>;
}
export interface Reputation { count: number; avg: number | null; tags: Array<{ tag: string; count: number }> }
export interface EngagementRow {
  engagement_id: string; application_id?: string; posting_title: string; kind: PostingKind; worker_name?: string; company_name?: string;
  engagement_type: EngagementType; status: EngagementStatus; starts_on: string; ends_on: string | null;
  agreement_signed_at?: string | null; tax_form_received_at?: string | null; i9_completed_at?: string | null;
  direct_deposit_set_at?: string | null; onboarding_completed_at?: string | null; completed_at: string | null;
  team_member_id?: string | null; my_rating_submitted: boolean; counterpart_revealed: boolean;
}
export interface EngagementRatings {
  mine: { rating: number; tags: string[]; comment: string | null } | null;
  theirs: { rating: number; tags: string[]; comment: string | null } | null;
  revealed: boolean;
}
export type ChecklistItem = 'agreement_signed' | 'tax_form_received' | 'i9_completed' | 'direct_deposit_set';

// ------------------------------------------------------------------
// Pure helpers (unit-tested)
// ------------------------------------------------------------------

export function tradeLabel(v: string): string {
  return TRADES.find((t) => t[0] === v)?.[1] ?? v;
}
export function workTypeLabel(v: string): string {
  return WORK_TYPES.find((t) => t[0] === v)?.[1] ?? v;
}

export function dollarsToCents(v: string): number | null {
  const s = v.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
export function centsToDollars(c: number | null | undefined): string {
  return c == null ? '' : (c / 100).toFixed(2);
}

export function formatPay(p: Pick<PostingSummary, 'pay_min_cents' | 'pay_max_cents' | 'pay_type' | 'pay_currency'>): string {
  if (p.pay_min_cents == null || p.pay_max_cents == null) return 'Pay not listed';
  const fmt = (c: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: p.pay_currency, maximumFractionDigits: c % 100 === 0 ? 0 : 2 }).format(c / 100);
  const range = p.pay_min_cents === p.pay_max_cents ? fmt(p.pay_min_cents) : `${fmt(p.pay_min_cents)}–${fmt(p.pay_max_cents)}`;
  return p.pay_type === 'hourly' ? `${range}/hr` : p.pay_type === 'salary' ? `${range}/yr` : `${range} flat`;
}

export function locationLabel(o: { city?: string | null; region?: string | null }): string {
  return [o.city, o.region].filter(Boolean).join(', ') || 'Location not listed';
}

export function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return '';
  const f = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return end ? `${f(start)} – ${f(end)}` : `From ${f(start)}`;
}

/** Whole days from `today` to `date` (negative = past). Uses calendar dates, not timestamps. */
export function daysUntil(date: string | null, today: Date = new Date()): number | null {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const a = Date.UTC(y, m - 1, d);
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((a - b) / 86_400_000);
}

export function credentialBadge(c: Pick<Credential, 'verification_status' | 'expires_on'>, today: Date = new Date()): { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  const d = daysUntil(c.expires_on, today);
  if (d !== null && d < 0) return { label: 'Expired', tone: 'bad' };
  if (c.verification_status === 'verified') return d !== null && d <= 30 ? { label: `Verified · expires in ${d}d`, tone: 'warn' } : { label: 'Verified', tone: 'good' };
  if (c.verification_status === 'failed') return { label: 'Could not verify', tone: 'bad' };
  if (c.verification_status === 'expired') return { label: 'Expired', tone: 'bad' };
  if (c.verification_status === 'pending') return { label: 'Checking', tone: 'neutral' };
  return { label: 'Not verified yet', tone: 'neutral' };
}

/** Share of the profile that makes a worker ready to apply (0–100). */
export function profileCompleteness(p: Partial<TalentProfile> | null, credentialCount: number, referenceCount: number): number {
  if (!p) return 0;
  const parts = [
    Boolean(p.display_name && p.display_name.trim().length >= 2),
    Boolean(p.trades && p.trades.length > 0),
    Boolean(p.city && p.region),
    Boolean(p.headline),
    Boolean(p.bio && p.bio.length >= 40),
    Boolean(p.phone),
    credentialCount > 0,
    referenceCount > 0,
  ];
  return Math.round((parts.filter(Boolean).length / parts.length) * 100);
}

export function ratingDisplay(avg: number | null | undefined, count: number | null | undefined): string {
  if (!count || avg == null) return 'New';
  return count < 3 ? `New (${count})` : `${avg.toFixed(1)} (${count})`;
}

/** Weekdays strictly after `from` up to and including `to` (mirrors talent_business_days_between). */
export function businessDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  let n = 0;
  for (let t = a + 86_400_000; t <= b; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/** First calendar date on which the 5-business-day wait after a pre-adverse notice has elapsed. */
export function adverseEligibleOn(preAdverseSentAt: string | null): Date | null {
  if (!preAdverseSentAt) return null;
  const sent = new Date(preAdverseSentAt);
  const start = new Date(sent.getFullYear(), sent.getMonth(), sent.getDate());
  for (let i = 1; i <= 21; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (businessDaysBetween(start, d) >= 5) return d;
  }
  return null;
}

export function canMoveTo(from: ApplicationStatus, to: ApplicationStatus): boolean {
  if (!PIPELINE.includes(from)) return false;
  if (to === 'rejected') return true;
  return PIPELINE.includes(to) && to !== 'submitted' && to !== from;
}

export function blockerKeys(c: Compliance): string[] {
  return c.checks.filter((k) => k.blocking && (k.status === 'fail' || k.status === 'pending')).map((k) => k.key);
}
export const NON_OVERRIDABLE = ['background_check'];
export function hireGate(c: Compliance): { canHire: boolean; needsOverride: boolean; hardBlocked: boolean } {
  const keys = blockerKeys(c);
  const hardBlocked = keys.some((k) => NON_OVERRIDABLE.includes(k));
  return { canHire: keys.length === 0, needsOverride: keys.length > 0 && !hardBlocked, hardBlocked };
}

export function slugifyForDisplay(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function validateProfile(i: ProfileInput): string | null {
  if (i.display_name.trim().length < 2) return 'Enter your name (at least 2 characters).';
  if (i.trades.length === 0) return 'Select at least one trade.';
  if (i.trades.some((t) => !TRADE_SET.has(t))) return 'Invalid trade selected.';
  if (i.trades.length > 8) return 'Select up to 8 trades.';
  if (i.open_to.length === 0) return 'Choose at least one type of work you are open to.';
  if (!i.city.trim() || !i.region.trim()) return 'Enter your city and state/region.';
  if (i.headline.length > 120) return 'Headline must be 120 characters or fewer.';
  if (i.bio.length > 2000) return 'Bio must be 2000 characters or fewer.';
  const exp = i.experience_years.trim();
  if (exp && (!/^\d+$/.test(exp) || Number(exp) > 60)) return 'Experience must be a whole number from 0 to 60.';
  const radius = i.service_radius_miles.trim();
  if (radius && (!/^\d+$/.test(radius) || Number(radius) < 1 || Number(radius) > 500)) return 'Service radius must be 1–500 miles.';
  if (i.desired_hourly.trim() && (dollarsToCents(i.desired_hourly) ?? -1) < 0) return 'Enter a valid hourly rate, like 38.50.';
  return null;
}

export function validateCredential(i: CredentialInput): string | null {
  if (i.name.trim().length < 2) return 'Enter the credential name.';
  if (i.issued_on && i.expires_on && i.expires_on < i.issued_on) return 'Expiry must be after the issue date.';
  return null;
}

export function validateReference(i: ReferenceInput, ownEmail?: string): string | null {
  if (i.referee_name.trim().length < 2) return 'Enter the reference’s name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.referee_email.trim())) return 'Enter a valid email address.';
  if (ownEmail && i.referee_email.trim().toLowerCase() === ownEmail.toLowerCase()) return 'A reference must be another person.';
  if (!(i.relationship in RELATIONSHIPS)) return 'Choose how you know them.';
  return null;
}

export function validatePosting(i: PostingInput, forPublish: boolean): string | null {
  if (i.title.trim().length < 5) return 'Title must be at least 5 characters.';
  if (!TRADE_SET.has(i.trade)) return 'Choose a trade.';
  if (i.summary.trim().length < 20) return 'Summary must be at least 20 characters.';
  if (i.description.trim().length < 40) return 'Description must be at least 40 characters.';
  const min = i.pay_min ? dollarsToCents(i.pay_min) : null;
  const max = i.pay_max ? dollarsToCents(i.pay_max) : null;
  if ((i.pay_min && min === null) || (i.pay_max && max === null)) return 'Enter pay as a number, like 32 or 32.50.';
  if ((min === null) !== (max === null)) return 'Enter both a minimum and a maximum pay.';
  if (min !== null && max !== null && (min <= 0 || min > max)) return 'Minimum pay must be above zero and not exceed the maximum.';
  if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) return 'End date must be after the start date.';
  const hc = Number(i.headcount);
  if (!Number.isInteger(hc) || hc < 1 || hc > 50) return 'Openings must be between 1 and 50.';
  if (forPublish) {
    if (min === null) return 'A pay range is required to publish (pay-transparency laws apply in many states).';
    if (!i.city.trim() || !i.region.trim()) return 'City and state/region are required to publish.';
    if (i.kind === 'gig' && (!i.starts_on || !i.ends_on)) return 'Gig work needs a start and end date.';
  }
  return null;
}

export function toPostingPayload(i: PostingInput) {
  return {
    kind: i.kind, title: i.title.trim(), trade: i.trade, summary: i.summary.trim(), description: i.description.trim(),
    requirements: i.requirements.map((r) => r.trim()).filter(Boolean).slice(0, 15),
    company_name: i.company_name.trim(), city: i.city.trim() || null, region: i.region.trim().toUpperCase() || null,
    employment_type: i.kind === 'gig' ? 'contract' : i.employment_type, engagement_type: i.engagement_type, pay_type: i.pay_type,
    pay_min_cents: i.pay_min ? dollarsToCents(i.pay_min) : null, pay_max_cents: i.pay_max ? dollarsToCents(i.pay_max) : null,
    starts_on: i.starts_on || null, ends_on: i.ends_on || null, headcount: Number(i.headcount),
    requires_license: i.requires_license, requires_background_check: i.requires_background_check,
    min_references: Number(i.min_references),
  };
}

export const EMPTY_POSTING: PostingInput = {
  kind: 'job', title: '', trade: 'hvac', summary: '', description: '', requirements: [], company_name: '', city: '', region: '',
  employment_type: 'full_time', engagement_type: 'w2', pay_type: 'hourly', pay_min: '', pay_max: '', starts_on: '', ends_on: '',
  headcount: '1', requires_license: false, requires_background_check: false, min_references: '0',
};

interface PgError { code?: string; message?: string }
/** Postgres 22023 messages are written for end users; everything else gets a safe generic text. */
export function friendlyError(error: PgError | null | undefined, fallback: string): Error {
  if (!error) return new Error(fallback);
  if (error.code === '22023' && error.message) return new Error(error.message);
  if (error.code === '42501') return new Error("You don't have permission to do that.");
  if (error.code === '23505') return new Error('That already exists.');
  return new Error(fallback);
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export async function listOpenPostings(f: { trade?: string; kind?: string; region?: string; query?: string; offset?: number; limit?: number }): Promise<PostingSummary[]> {
  const { data, error } = await supabase.rpc('talent_list_open_postings', {
    p_trade: f.trade || null, p_kind: f.kind || null, p_region: f.region || null, p_query: f.query || null,
    p_limit: f.limit ?? 24, p_offset: f.offset ?? 0,
  });
  if (error) throw friendlyError(error, 'Could not load jobs.');
  return (data as PostingSummary[]) ?? [];
}

export async function getOpenPosting(slug: string): Promise<PostingDetail | null> {
  const { data, error } = await supabase.rpc('talent_get_open_posting', { p_slug: slug });
  if (error) throw friendlyError(error, 'Could not load this job.');
  return (data as PostingDetail | null) ?? null;
}

export async function getReferenceRequest(token: string): Promise<{ referee_name: string; relationship: string; worker_first_name: string } | null> {
  const { data, error } = await supabase.rpc('talent_get_reference_request', { p_token: token });
  if (error) throw friendlyError(error, 'Could not load this request.');
  return (data as { referee_name: string; relationship: string; worker_first_name: string } | null) ?? null;
}

export async function submitReference(token: string, v: { rating: number; wouldRehire: string; strengths: string[]; comment: string }): Promise<boolean> {
  const { data, error } = await supabase.rpc('talent_submit_reference', {
    p_token: token, p_rating: v.rating, p_would_rehire: v.wouldRehire, p_strengths: v.strengths, p_comment: v.comment || null,
  });
  if (error) throw friendlyError(error, 'Could not submit your reference.');
  return Boolean((data as { ok?: boolean } | null)?.ok);
}

// ------------------------------------------------------------------
// Worker API
// ------------------------------------------------------------------

const PROFILE_COLS = 'id, display_name, headline, bio, contact_email, phone, trades, experience_years, city, region, country, service_radius_miles, open_to, desired_hourly_cents, availability, status, terms_accepted_at';
const CREDENTIAL_COLS = 'id, profile_id, kind, name, issuing_authority, credential_number, region, issued_on, expires_on, document_path, verification_status, verification_method, verified_at';
const REFERENCE_COLS = 'id, referee_name, referee_email, referee_phone, relationship, company, years_known, status, requested_at, request_count, responded_at';

export async function fetchMyProfile(): Promise<TalentProfile | null> {
  const { data, error } = await supabase.from('talent_profiles').select(PROFILE_COLS).maybeSingle();
  if (error) throw friendlyError(error, 'Could not load your profile.');
  return (data as TalentProfile | null) ?? null;
}

export async function saveMyProfile(i: ProfileInput): Promise<string> {
  const exp = i.experience_years.trim();
  const radius = i.service_radius_miles.trim();
  const { data, error } = await supabase.rpc('talent_save_profile', {
    p_display_name: i.display_name, p_headline: i.headline, p_bio: i.bio, p_phone: i.phone, p_trades: i.trades,
    p_experience_years: exp ? Number(exp) : null, p_city: i.city, p_region: i.region, p_country: i.country || 'US',
    p_service_radius_miles: radius ? Number(radius) : null, p_open_to: i.open_to,
    p_desired_hourly_cents: i.desired_hourly.trim() ? dollarsToCents(i.desired_hourly) : null,
    p_availability: i.availability, p_status: i.status,
  });
  if (error) throw friendlyError(error, 'Could not save your profile.');
  return data as string;
}

export async function acceptTerms(version = 'v1'): Promise<void> {
  const { error } = await supabase.rpc('talent_accept_terms', { p_version: version });
  if (error) throw friendlyError(error, 'Could not record your acceptance.');
}

export async function fetchMyCredentials(): Promise<Credential[]> {
  const { data, error } = await supabase.from('talent_credentials').select(CREDENTIAL_COLS).order('kind').order('name');
  if (error) throw friendlyError(error, 'Could not load credentials.');
  return (data as Credential[]) ?? [];
}

export async function saveCredential(profileId: string, i: CredentialInput, id?: string, documentPath?: string | null): Promise<void> {
  const row = {
    kind: i.kind, name: i.name.trim(), issuing_authority: i.issuing_authority.trim() || null,
    credential_number: i.credential_number.trim() || null, region: i.region.trim().toUpperCase() || null,
    issued_on: i.issued_on || null, expires_on: i.expires_on || null,
    ...(documentPath !== undefined ? { document_path: documentPath } : {}),
  };
  const { error } = id
    ? await supabase.from('talent_credentials').update(row).eq('id', id)
    : await supabase.from('talent_credentials').insert({ ...row, profile_id: profileId });
  if (error) throw friendlyError(error, 'Could not save the credential.');
}

export async function deleteCredential(c: Credential): Promise<void> {
  if (c.document_path) await supabase.storage.from('talent-docs').remove([c.document_path]);
  const { error } = await supabase.from('talent_credentials').delete().eq('id', c.id);
  if (error) throw friendlyError(error, 'Could not delete the credential.');
}

const MAX_DOC_BYTES = 10 * 1024 * 1024;
const DOC_TYPES: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
};
export function validateDocument(f: { size: number; type: string }): string | null {
  if (!(f.type in DOC_TYPES)) return 'Upload a PDF or an image (JPG, PNG, WebP, HEIC).';
  if (f.size > MAX_DOC_BYTES) return 'The file must be 10 MB or smaller.';
  return null;
}
export async function uploadCredentialDocument(userId: string, file: File): Promise<string> {
  const problem = validateDocument(file);
  if (problem) throw new Error(problem);
  const path = `${userId}/${crypto.randomUUID()}.${DOC_TYPES[file.type]}`;
  const { error } = await supabase.storage.from('talent-docs').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error('Could not upload the document.');
  return path;
}
export async function signedDocumentUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('talent-docs').createSignedUrl(path, 300);
  return data?.signedUrl ?? null;
}

export async function fetchMyReferences(): Promise<Reference[]> {
  const { data, error } = await supabase.from('talent_references').select(REFERENCE_COLS).order('created_at');
  if (error) throw friendlyError(error, 'Could not load references.');
  return (data as Reference[]) ?? [];
}
export async function addReference(profileId: string, i: ReferenceInput): Promise<void> {
  const { error } = await supabase.from('talent_references').insert({
    profile_id: profileId, referee_name: i.referee_name.trim(), referee_email: i.referee_email.trim(),
    referee_phone: i.referee_phone.trim() || null, relationship: i.relationship, company: i.company.trim() || null,
    years_known: i.years_known.trim() ? Number(i.years_known) : null,
  });
  if (error) throw friendlyError(error, 'Could not add the reference.');
}
export async function deleteReference(id: string): Promise<void> {
  const { error } = await supabase.from('talent_references').delete().eq('id', id);
  if (error) throw friendlyError(error, 'Could not remove the reference.');
}

interface FnError { message?: string; context?: { json?: () => Promise<{ error?: string; code?: string }> } }
async function invokeTalent<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('talent-network', { body });
  if (error) {
    let message = fallback;
    try {
      const j = await (error as FnError).context?.json?.();
      if (j?.error) message = j.error;
    } catch { /* keep fallback */ }
    throw new Error(message);
  }
  return data as T;
}
export const requestReference = (referenceId: string) => invokeTalent<{ ok: boolean }>({ action: 'reference_request', referenceId }, 'Could not send the request.');
export const startBackgroundCheck = (applicationId: string, pkg?: string) => invokeTalent<{ ok: boolean }>({ action: 'background_start', applicationId, package: pkg }, 'Could not start the background check.');

export async function applyToPosting(postingId: string, v: { coverNote: string; expectedRate: string; availabilityNote: string }): Promise<string> {
  const rate = v.expectedRate.trim() ? dollarsToCents(v.expectedRate) : null;
  if (v.expectedRate.trim() && rate === null) throw new Error('Enter a valid hourly rate, like 38.50.');
  const { data, error } = await supabase.rpc('talent_apply', {
    p_posting_id: postingId, p_cover_note: v.coverNote || null, p_expected_rate_cents: rate, p_availability_note: v.availabilityNote || null,
  });
  if (error) throw friendlyError(error, 'Could not submit your application.');
  return data as string;
}
export async function withdrawApplication(id: string): Promise<void> {
  const { error } = await supabase.rpc('talent_withdraw_application', { p_application_id: id });
  if (error) throw friendlyError(error, 'Could not withdraw the application.');
}
export async function fetchMyApplications(): Promise<MyApplication[]> {
  const { data, error } = await supabase.rpc('talent_my_applications');
  if (error) throw friendlyError(error, 'Could not load your applications.');
  return (data as MyApplication[]) ?? [];
}
export async function fetchMyReputation(): Promise<Reputation> {
  const { data, error } = await supabase.rpc('talent_my_reputation');
  if (error) throw friendlyError(error, 'Could not load your ratings.');
  return data as Reputation;
}
export async function fetchMyEngagements(): Promise<EngagementRow[]> {
  const { data, error } = await supabase.rpc('talent_list_engagements_worker');
  if (error) throw friendlyError(error, 'Could not load your engagements.');
  return (data as EngagementRow[]) ?? [];
}
export async function exportMyData(): Promise<string> {
  const { data, error } = await supabase.rpc('talent_export_my_data');
  if (error) throw friendlyError(error, 'Could not export your data.');
  return JSON.stringify(data, null, 2);
}
export async function deleteMyProfile(userId: string, documentPaths: string[]): Promise<void> {
  if (documentPaths.length > 0) await supabase.storage.from('talent-docs').remove(documentPaths);
  const { error } = await supabase.rpc('talent_delete_my_profile');
  if (error) throw friendlyError(error, 'Could not delete your profile.');
  void userId;
}

// ------------------------------------------------------------------
// Business API
// ------------------------------------------------------------------

const POSTING_COLS = 'id, slug, kind, title, trade, summary, description, requirements, company_name, city, region, country, employment_type, engagement_type, pay_type, pay_min_cents, pay_max_cents, pay_currency, starts_on, ends_on, headcount, requires_license, requires_background_check, min_references, status, published_at, closed_at, created_at, updated_at';

export async function fetchPostings(): Promise<PostingRow[]> {
  const { data, error } = await supabase.from('talent_postings').select(POSTING_COLS).order('created_at', { ascending: false });
  if (error) throw friendlyError(error, 'Could not load postings.');
  return (data as unknown as PostingRow[]) ?? [];
}
export async function savePosting(i: PostingInput, status: PostingStatus, id?: string): Promise<void> {
  const payload = { ...toPostingPayload(i), status };
  const { error } = id ? await supabase.from('talent_postings').update(payload).eq('id', id) : await supabase.from('talent_postings').insert(payload);
  if (error) throw friendlyError(error, 'Could not save the posting.');
}
export async function setPostingStatus(id: string, status: PostingStatus): Promise<void> {
  const { error } = await supabase.from('talent_postings').update({ status }).eq('id', id);
  if (error) throw friendlyError(error, 'Could not update the posting.');
}
export function postingToInput(p: PostingRow): PostingInput {
  return {
    kind: p.kind, title: p.title, trade: p.trade, summary: p.summary, description: p.description, requirements: p.requirements,
    company_name: p.company_name, city: p.city ?? '', region: p.region ?? '', employment_type: p.employment_type,
    engagement_type: p.engagement_type, pay_type: p.pay_type, pay_min: centsToDollars(p.pay_min_cents), pay_max: centsToDollars(p.pay_max_cents),
    starts_on: p.starts_on ?? '', ends_on: p.ends_on ?? '', headcount: String(p.headcount), requires_license: p.requires_license,
    requires_background_check: p.requires_background_check, min_references: String(p.min_references),
  };
}

export async function fetchApplications(): Promise<ApplicationRow[]> {
  const { data, error } = await supabase
    .from('talent_applications')
    .select('id, posting_id, status, cover_note, expected_rate_cents, profile_snapshot, created_at, talent_postings(title, kind, slug)')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw friendlyError(error, 'Could not load applicants.');
  return (data as unknown as ApplicationRow[]) ?? [];
}
export async function fetchApplicant(id: string): Promise<ApplicantDetail> {
  const { data, error } = await supabase.rpc('talent_get_applicant', { p_application_id: id });
  if (error) throw friendlyError(error, 'Could not load this applicant.');
  return data as ApplicantDetail;
}
export async function setApplicationStatus(id: string, status: ApplicationStatus, reason?: string, note?: string): Promise<void> {
  const { error } = await supabase.rpc('talent_set_application_status', { p_application_id: id, p_status: status, p_reason: reason ?? null, p_note: note ?? null });
  if (error) throw friendlyError(error, 'Could not update the application.');
}
export async function attestCredential(applicationId: string, credentialId: string, outcome: 'verified' | 'not_verified', method: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('talent_attest_credential', {
    p_application_id: applicationId, p_credential_id: credentialId, p_outcome: outcome, p_method: method, p_note: note || null,
  });
  if (error) throw friendlyError(error, 'Could not record the verification.');
}
export async function recordBackgroundDecision(checkId: string, decision: 'engage' | 'pre_adverse_sent' | 'adverse_final', note: string): Promise<void> {
  const { error } = await supabase.rpc('talent_record_background_decision', { p_check_id: checkId, p_decision: decision, p_note: note || null });
  if (error) throw friendlyError(error, 'Could not record the decision.');
}
export async function hireApplicant(v: { applicationId: string; engagementType: EngagementType; startsOn: string; endsOn: string; hourlyRate: string; overrideReason: string }) {
  const rate = dollarsToCents(v.hourlyRate);
  if (rate === null) throw new Error('Enter a valid hourly rate, like 38.50.');
  const { data, error } = await supabase.rpc('talent_hire_applicant', {
    p_application_id: v.applicationId, p_engagement_type: v.engagementType, p_starts_on: v.startsOn, p_ends_on: v.endsOn || null,
    p_hourly_rate_cents: rate, p_override_reason: v.overrideReason.trim() || null,
  });
  if (error) throw friendlyError(error, 'Could not complete the hire.');
  const r = data as { engagement_id: string; team_member_id: string; invite_email: string; member_name: string };
  // Email the technician invite through the existing team-invite function. A mail failure never undoes the hire.
  let inviteSent = true;
  const { error: mailError } = await supabase.functions.invoke('send-team-invite', {
    body: { memberEmail: r.invite_email, memberName: r.member_name, role: 'technician' },
  });
  if (mailError) inviteSent = false;
  return { ...r, inviteSent };
}
export async function fetchBusinessEngagements(): Promise<EngagementRow[]> {
  const { data, error } = await supabase.rpc('talent_list_engagements_business');
  if (error) throw friendlyError(error, 'Could not load engagements.');
  return (data as EngagementRow[]) ?? [];
}
export async function markOnboardingItem(engagementId: string, item: ChecklistItem, done: boolean): Promise<void> {
  const { error } = await supabase.rpc('talent_mark_onboarding_item', { p_engagement_id: engagementId, p_item: item, p_done: done });
  if (error) throw friendlyError(error, 'Could not update the checklist.');
}
export async function completeEngagement(engagementId: string, outcome: 'completed' | 'terminated'): Promise<void> {
  const { error } = await supabase.rpc('talent_complete_engagement', { p_engagement_id: engagementId, p_outcome: outcome, p_ends_on: null });
  if (error) throw friendlyError(error, 'Could not end the engagement.');
}
export async function submitRating(engagementId: string, rating: number, tags: string[], comment: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('talent_submit_rating', { p_engagement_id: engagementId, p_rating: rating, p_tags: tags, p_comment: comment || null });
  if (error) throw friendlyError(error, 'Could not submit your rating.');
  return Boolean((data as { revealed?: boolean } | null)?.revealed);
}
export async function fetchEngagementRatings(engagementId: string): Promise<EngagementRatings> {
  const { data, error } = await supabase.rpc('talent_get_engagement_ratings', { p_engagement_id: engagementId });
  if (error) throw friendlyError(error, 'Could not load ratings.');
  return data as EngagementRatings;
}
