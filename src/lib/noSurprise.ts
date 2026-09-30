/**
 * Vireek «No-Surprise» Engine — pure domain layer (types, validation, formatting).
 *
 * No network access here on purpose: everything in this file is deterministic and unit-tested.
 * Server counterpart: supabase/migrations/20270201000000_no_surprise_engine.sql
 * API layer:          src/lib/noSurpriseApi.ts
 */

// ============================================================
// TYPES
// ============================================================

export type RequestStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'withdrawn';
export type Necessity = 'required' | 'recommended' | 'optional';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type OptionKind = 'perform' | 'defer';

export interface NoSurpriseOption {
  id: string;
  label: string;
  description: string;
  kind: OptionKind;
  cost_low_cents: number;
  cost_high_cents: number;
  recommended?: boolean;
}

/** Row as the dashboard sees it (RLS-scoped). */
export interface NoSurpriseRequest {
  id: string;
  job_id: string;
  status: RequestStatus;
  title: string;
  trigger_note: string | null;
  why: string;
  necessity: Necessity;
  risk_level: RiskLevel;
  consequence: string;
  options: NoSurpriseOption[];
  cost_low_cents: number;
  cost_high_cents: number;
  work_paused: boolean;
  ai_assisted: boolean;
  expires_at: string;
  created_by_name: string | null;
  created_at: string;
  decided_at: string | null;
  decided_option_id: string | null;
  approved_cost_high_cents: number | null;
  signed_name: string | null;
  decision_note: string | null;
  risk_acknowledged: boolean;
  withdrawn_reason: string | null;
  disclosure_entry_id: string | null;
  decision_entry_id: string | null;
}

/** What the customer sees (token-gated RPC). */
export interface PublicRequest {
  id: string;
  status: Exclude<RequestStatus, 'withdrawn'>;
  title: string;
  why: string;
  necessity: Necessity;
  risk_level: RiskLevel;
  consequence: string;
  options: NoSurpriseOption[];
  cost_low_cents: number;
  cost_high_cents: number;
  work_paused: boolean;
  ai_assisted: boolean;
  requested_by: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_option_id: string | null;
  approved_cost_high_cents: number | null;
  signed_name: string | null;
}

export type CertLevel =
  | 'certified'
  | 'awaiting_customer'
  | 'protected'
  | 'unverified'
  | 'violated'
  | 'not_applicable';

export type CertReason =
  | 'open_request'
  | 'no_agreed_price'
  | 'invoice_exceeds_approved'
  | 'chain_integrity'
  | 'work_before_approval';

export interface Certification {
  level: CertLevel;
  certified: boolean;
  job_status: string;
  baseline_cents: number | null;
  approved_extra_cents: number;
  ceiling_cents: number | null;
  invoice_cents: number | null;
  requests: { total: number; pending: number; approved: number; declined: number; expired: number };
  reasons: CertReason[];
  evidence_head_hash: string | null;
  evaluated_at: string;
}

export interface NoSurpriseRoom {
  business_name: string | null;
  customer_name: string;
  service_type: string | null;
  job_status: string;
  technician_name: string | null;
  requests: PublicRequest[];
  certification: Certification | null;
}

/** Editable draft (composer state + AI output). Money is kept in dollars-as-text for form editing. */
export interface DraftOption {
  label: string;
  description: string;
  kind: OptionKind;
  low: string;
  high: string;
  recommended: boolean;
}

export interface NoSurpriseDraft {
  title: string;
  why: string;
  necessity: Necessity;
  risk_level: RiskLevel;
  consequence: string;
  options: DraftOption[];
  work_paused: boolean;
  expires_in_hours: number;
}

/** Shape returned by the no-surprise-assess edge function. */
export interface AiAssessment {
  title: string;
  why: string;
  necessity: Necessity;
  risk_level: RiskLevel;
  consequence: string;
  options: {
    label: string;
    description: string;
    kind: OptionKind;
    cost_low_cents: number;
    cost_high_cents: number;
    recommended: boolean;
  }[];
  safety_flag: boolean;
  confidence: number;
  missing_info: string[];
}

// ============================================================
// LIMITS (mirror the SQL CHECK constraints)
// ============================================================

export const LIMITS = {
  title: [3, 160],
  why: [10, 2000],
  consequence: [10, 1500],
  optionLabel: [1, 120],
  optionDescription: 500,
  maxOptions: 4,
  maxCents: 100_000_000,
  findings: [10, 1500],
  expiryHours: [1, 168],
} as const;

export const EXPIRY_CHOICES: { hours: number; label: string }[] = [
  { hours: 2, label: '2 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 48, label: '48 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
];

// ============================================================
// LABELS
// ============================================================

export const NECESSITY_META: Record<Necessity, { label: string; hint: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  required: { label: 'Necessary', hint: 'Needed for safety or for the repair to work.', tone: 'danger' },
  recommended: { label: 'Recommended', hint: 'Strongly advised, but the repair can proceed without it.', tone: 'warning' },
  optional: { label: 'Optional', hint: 'Nice to have. Safe to skip.', tone: 'neutral' },
};

export const RISK_META: Record<RiskLevel, { label: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  low: { label: 'Low risk', tone: 'neutral' },
  medium: { label: 'Medium risk', tone: 'warning' },
  high: { label: 'High risk', tone: 'danger' },
  critical: { label: 'Safety-critical', tone: 'danger' },
};

export const STATUS_META: Record<RequestStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  pending: { label: 'Waiting for customer', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  declined: { label: 'Not approved', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};

export const CERT_META: Record<CertLevel, { label: string; description: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  certified: {
    label: 'Vireek Certified No-Surprise Service',
    description: 'Every extra cost on this job was explained and approved before it was added. The record is sealed in the evidence chain.',
    tone: 'success',
  },
  awaiting_customer: {
    label: 'Waiting for your approval',
    description: 'Additional work was flagged. Nothing is added to the price until the customer decides.',
    tone: 'warning',
  },
  protected: {
    label: 'No-Surprise protected',
    description: 'No cost can be added to this job without the customer’s explicit approval.',
    tone: 'success',
  },
  unverified: {
    label: 'No-Surprise: price not verified',
    description: 'The job is complete, but there is no accepted estimate to verify the final price against.',
    tone: 'neutral',
  },
  violated: {
    label: 'Not certified',
    description: 'The record shows a cost or a step that was not approved first.',
    tone: 'danger',
  },
  not_applicable: {
    label: 'Not applicable',
    description: 'This job was cancelled.',
    tone: 'neutral',
  },
};

export const CERT_REASON_LABELS: Record<CertReason, string> = {
  open_request: 'A request is still waiting for the customer',
  no_agreed_price: 'No accepted estimate is linked to this job',
  invoice_exceeds_approved: 'Invoice is higher than the estimate plus approved additions',
  chain_integrity: 'Evidence chain integrity check failed',
  work_before_approval: 'Work started before the customer approved',
};

// ============================================================
// MONEY
// ============================================================

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function formatUsd(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  return cents % 100 === 0 ? usdWhole.format(cents / 100) : usd.format(cents / 100);
}

export function formatRange(lowCents: number, highCents: number): string {
  if (lowCents === highCents) return formatUsd(highCents);
  return `${formatUsd(lowCents)} – ${formatUsd(highCents)}`;
}

/** "1,250.50" / "$1250" -> 125050. Returns null when it is not a valid non-negative amount. */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isFinite(cents) && cents >= 0 && cents <= LIMITS.maxCents ? cents : null;
}

export function centsToDollarsText(cents: number): string {
  return (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}

// ============================================================
// DRAFTS
// ============================================================

export function emptyDraft(): NoSurpriseDraft {
  return {
    title: '',
    why: '',
    necessity: 'recommended',
    risk_level: 'medium',
    consequence: '',
    options: [
      { label: '', description: '', kind: 'perform', low: '', high: '', recommended: true },
      { label: 'Not now', description: 'Skip this for now. No extra charge.', kind: 'defer', low: '0', high: '0', recommended: false },
    ],
    work_paused: true,
    expires_in_hours: 48,
  };
}

export function draftFromAssessment(a: AiAssessment): NoSurpriseDraft {
  const options: DraftOption[] = a.options.slice(0, LIMITS.maxOptions).map((o) => ({
    label: o.label,
    description: o.description,
    kind: o.kind,
    low: centsToDollarsText(o.cost_low_cents),
    high: centsToDollarsText(o.cost_high_cents),
    recommended: o.recommended,
  }));
  return {
    title: a.title,
    why: a.why,
    necessity: a.necessity,
    risk_level: a.risk_level,
    consequence: a.consequence,
    options,
    work_paused: a.necessity !== 'optional',
    expires_in_hours: a.risk_level === 'critical' ? 2 : 48,
  };
}

function inRange(value: string, [min, max]: readonly [number, number]): boolean {
  const n = value.trim().length;
  return n >= min && n <= max;
}

/** Human-readable problems; empty array = valid. Mirrors the database rules. */
export function validateDraft(d: NoSurpriseDraft): string[] {
  const errors: string[] = [];
  if (!inRange(d.title, LIMITS.title)) errors.push('Add a short title (3–160 characters).');
  if (!inRange(d.why, LIMITS.why)) errors.push('Explain why the extra work is needed (at least 10 characters).');
  if (!inRange(d.consequence, LIMITS.consequence)) errors.push('Say what happens if the customer does nothing.');
  if (d.options.length < 1 || d.options.length > LIMITS.maxOptions) errors.push('Add between 1 and 4 options.');

  let performs = 0;
  d.options.forEach((o, i) => {
    const n = i + 1;
    if (!inRange(o.label, LIMITS.optionLabel)) errors.push(`Option ${n}: add a label.`);
    if (o.description.length > LIMITS.optionDescription) errors.push(`Option ${n}: description is too long.`);
    const low = dollarsToCents(o.low);
    const high = dollarsToCents(o.high);
    if (low == null || high == null) {
      errors.push(`Option ${n}: enter valid amounts.`);
    } else if (high < low) {
      errors.push(`Option ${n}: the high price is below the low price.`);
    } else if (o.kind === 'defer' && high !== 0) {
      errors.push(`Option ${n}: deferring must cost $0.`);
    }
    if (o.kind === 'perform') performs += 1;
  });
  if (performs < 1) errors.push('At least one option must be work that will be performed.');

  const [minH, maxH] = LIMITS.expiryHours;
  if (!Number.isInteger(d.expires_in_hours) || d.expires_in_hours < minH || d.expires_in_hours > maxH) {
    errors.push('Choose how long the customer has to decide.');
  }
  return errors;
}

/** Converts a valid draft into rows for insert. Option ids are assigned here (a, b, c, d). */
export function draftToOptions(d: NoSurpriseDraft): NoSurpriseOption[] {
  return d.options.map((o, i) => {
    const low = dollarsToCents(o.low) ?? 0;
    const high = dollarsToCents(o.high) ?? low;
    return {
      id: String.fromCharCode(97 + i),
      label: o.label.trim(),
      description: o.description.trim(),
      kind: o.kind,
      cost_low_cents: o.kind === 'defer' ? 0 : low,
      cost_high_cents: o.kind === 'defer' ? 0 : high,
      recommended: o.recommended && o.kind === 'perform',
    };
  });
}

/** Overall range across the options that would actually be performed. */
export function performRange(options: NoSurpriseOption[]): { low: number; high: number } {
  const perform = options.filter((o) => o.kind === 'perform');
  if (perform.length === 0) return { low: 0, high: 0 };
  return {
    low: Math.min(...perform.map((o) => o.cost_low_cents)),
    high: Math.max(...perform.map((o) => o.cost_high_cents)),
  };
}

// ============================================================
// STATE HELPERS
// ============================================================

export function isPastDeadline(expiresAt: string, now: number = Date.now()): boolean {
  return new Date(expiresAt).getTime() <= now;
}

/** "2h 15m left" / "Expires in 3 days" / "Expired". */
export function timeLeftLabel(expiresAt: string, now: number = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'Expired';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m left`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} left`;
}

/** Status the UI should show: a pending request past its deadline is already expired for everyone. */
export function effectiveStatus(r: { status: RequestStatus; expires_at: string }, now: number = Date.now()): RequestStatus {
  return r.status === 'pending' && isPastDeadline(r.expires_at, now) ? 'expired' : r.status;
}

/** Customer must explicitly acknowledge the consequence before declining these. */
export function declineNeedsAcknowledgement(r: Pick<PublicRequest, 'necessity' | 'risk_level'>): boolean {
  return r.necessity === 'required' || r.risk_level === 'high' || r.risk_level === 'critical';
}

// ============================================================
// ERRORS
// ============================================================

export const RESPOND_ERRORS: Record<string, string> = {
  invalid_request: 'Something went wrong with this request. Please reload the page.',
  not_found: 'This request could not be found.',
  expired: 'This request has expired. Please contact the business if you still want this work.',
  already_resolved: 'A decision has already been recorded for this request.',
  invalid_name: 'Please type your full name.',
  invalid_option: 'Please choose one of the options.',
  signature_required: 'Please type your full name to approve.',
  acknowledgement_required: 'Please confirm you understand the consequence before declining.',
};

export function respondErrorMessage(code: string | null | undefined): string {
  return (code && RESPOND_ERRORS[code]) || 'We could not record your decision. Please try again.';
}

const DB_ERROR_MESSAGES: [string, string][] = [
  ['NO_SURPRISE_JOB_CLOSED', 'This job is already closed, so no additional work can be requested.'],
  ['NO_SURPRISE_LIMIT', 'There are already 3 open requests on this job. Resolve or withdraw one first.'],
  ['NO_SURPRISE_INVALID', 'Some details are invalid. Check the options and amounts.'],
  ['NO_SURPRISE_IMMUTABLE', 'This request can no longer be changed.'],
  ['NO_SURPRISE_FORBIDDEN', 'You are not allowed to do that.'],
];

export function friendlyDbError(message: string | null | undefined): string {
  const text = message ?? '';
  const hit = DB_ERROR_MESSAGES.find(([code]) => text.includes(code));
  return hit ? hit[1] : 'Could not save. Please try again.';
}

// ============================================================
// SHARE TEXT
// ============================================================

export function approvalMessage(opts: { customerName: string; businessName: string | null; title: string; link: string }): string {
  const from = opts.businessName ? ` from ${opts.businessName}` : '';
  return (
    `Hi ${opts.customerName.split(' ')[0] || 'there'}, your technician${from} found something that may add to your bill: ` +
    `"${opts.title}". Nothing will be added without your OK. See the details, your options and decide here: ${opts.link}`
  );
}
