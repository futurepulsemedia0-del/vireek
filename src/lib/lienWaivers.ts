// Lien Waivers — pure logic shared by the project tab, the public signing page and the tests.
// Rendering and the pay-app rules are mirrored 1:1 in supabase/migrations/20271231150000_lien_waivers.sql
// (lien_waiver_render / payment gate). Change one, change the other.
// State forms are DATA (lien_waiver_templates). Nothing here is legal advice.

import type { InvoiceLite } from '@/lib/installProjects';

export type WaiverType = 'conditional_progress' | 'unconditional_progress' | 'conditional_final' | 'unconditional_final';
export type WaiverDirection = 'given' | 'received';
export type WaiverStatus = 'draft' | 'sent' | 'signed' | 'declined' | 'void';
export type DisplayStatus = WaiverStatus | 'expired';
export type SignatureMethod = 'online' | 'in_app' | 'paper' | 'email' | 'other';

export interface LienWaiver {
  id: string;
  user_id: string;
  waiver_number: string | null;
  project_id: string | null;
  billing_id: string | null;
  invoice_id: string | null;
  direction: WaiverDirection;
  waiver_type: WaiverType;
  state_code: string;
  claimant_name: string;
  claimant_email: string | null;
  claimant_phone: string | null;
  customer_name: string;
  property_address: string | null;
  project_name: string | null;
  through_date: string;
  amount_cents: number;
  exceptions: string | null;
  title: string | null;
  rendered_body: string | null;
  content_hash: string | null;
  statute_ref: string | null;
  requires_notary: boolean;
  payment_confirmed_by: 'invoice' | 'staff' | null;
  status: WaiverStatus;
  sign_token: string;
  expires_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  voided_at: string | null;
  signer_name: string | null;
  signer_title: string | null;
  signature_method: SignatureMethod | null;
  decline_reason: string | null;
  void_reason: string | null;
  created_at: string;
}

export interface LienWaiverTemplate {
  id: string;
  user_id: string | null;
  state_code: string;
  waiver_type: WaiverType;
  title: string;
  body: string;
  statute_ref: string | null;
  is_statutory_form: boolean;
  requires_notary: boolean;
  version: number;
  notes: string | null;
}

export interface LienWaiverEvent {
  id: string;
  waiver_id: string;
  event_type: string;
  actor_type: 'staff' | 'signer' | 'system';
  actor_name: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface PublicLienWaiver {
  number: string | null;
  title: string;
  body: string;
  direction: WaiverDirection;
  waiverType: WaiverType;
  stateCode: string;
  statuteRef: string | null;
  requiresNotary: boolean;
  claimantName: string;
  customerName: string;
  propertyAddress: string | null;
  projectName: string | null;
  throughDate: string;
  amountCents: number;
  status: DisplayStatus;
  sentAt: string | null;
  expiresAt: string | null;
  signedAt: string | null;
  signerName: string | null;
  signerTitle: string | null;
  contentHash: string | null;
  businessName: string | null;
}

export const NOT_LEGAL_ADVICE =
  'Vireek provides templates and e-signature tooling only. This is not legal advice and Vireek is not a law firm. Lien-waiver wording, timing and notary rules vary by state — have your attorney review before you rely on any form.';

export const WAIVER_TYPES: WaiverType[] = ['conditional_progress', 'unconditional_progress', 'conditional_final', 'unconditional_final'];

export const WAIVER_TYPE_LABEL: Record<WaiverType, string> = {
  conditional_progress: 'Conditional · Progress',
  unconditional_progress: 'Unconditional · Progress',
  conditional_final: 'Conditional · Final',
  unconditional_final: 'Unconditional · Final',
};

export const WAIVER_TYPE_HINT: Record<WaiverType, string> = {
  conditional_progress: 'Effective only once the progress payment clears. Give this when you bill.',
  unconditional_progress: 'Effective immediately. Give this only after the progress payment has cleared.',
  conditional_final: 'Effective only once the final payment clears. Give this with the final bill.',
  unconditional_final: 'Effective immediately and releases everything. Give this only after final payment has cleared.',
};

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Awaiting signature',
  signed: 'Signed',
  declined: 'Declined',
  void: 'Void',
  expired: 'Link expired',
};

export const DIRECTION_LABEL: Record<WaiverDirection, string> = {
  given: 'We give (to customer / GC)',
  received: 'We collect (from sub / supplier)',
};

export const US_STATES: { code: string; name: string }[] = [
  { code: 'US', name: 'Generic (no state)' },
  ...Object.entries({
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  }).map(([code, name]) => ({ code, name })),
];

const STATE_CODES = new Set(US_STATES.map((s) => s.code));

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isConditional = (t: WaiverType): boolean => t.startsWith('conditional');
export const isFinal = (t: WaiverType): boolean => t.endsWith('_final');

/** "12 Elm St, Austin, TX 78701" → "TX"; anything unrecognised → "US" (generic). */
export function guessStateCode(address: string | null | undefined): string {
  if (!address) return 'US';
  const zip = /\b([A-Za-z]{2})\.?\s+\d{5}(?:-\d{4})?\b/.exec(address);
  const tail = /,\s*([A-Za-z]{2})\.?\s*$/.exec(address.trim());
  const code = (zip?.[1] ?? tail?.[1] ?? '').toUpperCase();
  return STATE_CODES.has(code) && code !== 'US' ? code : 'US';
}

// ------------------------------------------------------------------
// Rendering (mirrors lien_waiver_render in SQL)
// ------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatUsd = (cents: number): string => USD.format((cents || 0) / 100);

/** "2027-01-10" → "January 10, 2027" (no timezone shifts). */
export function longDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return '—';
  return `${MONTHS[Number(m[2]) - 1] ?? ''} ${Number(m[3])}, ${m[1]}`;
}

export interface RenderVars {
  waiver_number?: string | null;
  claimant_name: string;
  customer_name: string;
  property_address?: string | null;
  project_name?: string | null;
  through_date: string;
  amount_cents: number;
  exceptions?: string | null;
  state_code: string;
  statute_ref?: string | null;
}

export function renderLienWaiver(body: string, v: RenderVars): string {
  const map: Record<string, string> = {
    waiver_number: v.waiver_number ?? '',
    claimant_name: v.claimant_name,
    customer_name: v.customer_name,
    property_address: v.property_address?.trim() || 'Not specified',
    project_name: v.project_name?.trim() || 'Not specified',
    through_date: longDate(v.through_date),
    amount: formatUsd(v.amount_cents),
    exceptions: v.exceptions?.trim() || 'None',
    state: v.state_code,
    statute_ref: v.statute_ref?.trim() || 'Not specified',
  };
  // Sequential like SQL; user values can never contain "{{" (rejected by the database guard and by hasPlaceholder()).
  return Object.entries(map).reduce((text, [k, val]) => text.split(`{{${k}}}`).join(val), body);
}

export const hasPlaceholder = (s: string | null | undefined): boolean => /\{\{|\}\}/.test(s ?? '');
export const hasUnresolved = (rendered: string): boolean => rendered.includes('{{');

/** Picks the wording the database will freeze: state-specific first, then generic; account first, then library. */
export function resolveTemplate(
  templates: LienWaiverTemplate[],
  stateCode: string,
  type: WaiverType,
  ownerId: string,
): LienWaiverTemplate | null {
  const pool = templates.filter((t) => t.waiver_type === type && (t.state_code === stateCode || t.state_code === 'US') && (t.user_id === null || t.user_id === ownerId));
  pool.sort((a, b) => Number(b.state_code === stateCode) - Number(a.state_code === stateCode) || Number(b.user_id !== null) - Number(a.user_id !== null));
  return pool[0] ?? null;
}

// ------------------------------------------------------------------
// Status
// ------------------------------------------------------------------

export function displayStatus(w: Pick<LienWaiver, 'status' | 'expires_at'>, now: number = Date.now()): DisplayStatus {
  if (w.status === 'sent' && w.expires_at && new Date(w.expires_at).getTime() <= now) return 'expired';
  return w.status;
}

export type WaiverTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export const STATUS_TONE: Record<DisplayStatus, WaiverTone> = {
  draft: 'neutral', sent: 'info', signed: 'success', declined: 'danger', void: 'neutral', expired: 'warning',
};

/** Does this waiver need proof of payment before it can be released? (given + unconditional) */
export const needsPaymentProof = (w: Pick<LienWaiver, 'direction' | 'waiver_type'>): boolean =>
  w.direction === 'given' && !isConditional(w.waiver_type);

// ------------------------------------------------------------------
// Pay-app coverage — what each draw still needs
// ------------------------------------------------------------------

export type PayAppState = 'not_invoiced' | 'needs_conditional' | 'conditional_signed' | 'needs_unconditional' | 'complete';

export const PAY_APP_LABEL: Record<PayAppState, string> = {
  not_invoiced: 'Not invoiced yet',
  needs_conditional: 'Conditional waiver needed',
  conditional_signed: 'Conditional signed · awaiting payment',
  needs_unconditional: 'Paid · unconditional waiver needed',
  complete: 'Complete',
};

export const PAY_APP_TONE: Record<PayAppState, WaiverTone> = {
  not_invoiced: 'neutral', needs_conditional: 'warning', conditional_signed: 'info', needs_unconditional: 'danger', complete: 'success',
};

/** Only waivers WE give for this draw count; voided / declined ones never cover anything. */
export function payAppState(invoice: Pick<InvoiceLite, 'status'> | null, waivers: Pick<LienWaiver, 'direction' | 'waiver_type' | 'status'>[]): PayAppState {
  if (!invoice) return 'not_invoiced';
  const signed = waivers.filter((w) => w.direction === 'given' && w.status === 'signed');
  if (invoice.status === 'paid') return signed.some((w) => !isConditional(w.waiver_type)) ? 'complete' : 'needs_unconditional';
  return signed.some((w) => isConditional(w.waiver_type)) ? 'conditional_signed' : 'needs_conditional';
}

/** Which form to suggest for a draw: conditional until paid, then unconditional; "final" for the last draw. */
export function suggestedType(invoice: Pick<InvoiceLite, 'status'> | null, finalDraw: boolean): WaiverType {
  const paid = invoice?.status === 'paid';
  if (finalDraw) return paid ? 'unconditional_final' : 'conditional_final';
  return paid ? 'unconditional_progress' : 'conditional_progress';
}

export function isFinalDraw(draw: { id: string; sort_order: number }, all: { id: string; sort_order: number; percent_of_contract: number }[]): boolean {
  if (all.length < 2) return false;
  const total = all.reduce((s, b) => s + Number(b.percent_of_contract), 0);
  const last = [...all].sort((a, b) => a.sort_order - b.sort_order)[all.length - 1];
  return total >= 99.999 && last.id === draw.id;
}

export interface WaiverSummary { signed: number; awaiting: number; drafts: number; needsAction: number; signedCents: number }

export function summarize(waivers: LienWaiver[], states: PayAppState[], now: number = Date.now()): WaiverSummary {
  let signed = 0, awaiting = 0, drafts = 0, signedCents = 0;
  for (const w of waivers) {
    const s = displayStatus(w, now);
    if (s === 'signed') { signed += 1; signedCents += w.amount_cents; }
    else if (s === 'sent' || s === 'expired') awaiting += 1;
    else if (s === 'draft') drafts += 1;
  }
  return { signed, awaiting, drafts, signedCents, needsAction: states.filter((s) => s === 'needs_conditional' || s === 'needs_unconditional').length };
}

// ------------------------------------------------------------------
// Links & errors
// ------------------------------------------------------------------

export const waiverLink = (token: string, origin: string = typeof window !== 'undefined' ? window.location.origin : ''): string =>
  `${origin}/lien-waiver/${token}`;

const ERROR_COPY: Record<string, string> = {
  not_authorized: 'You do not have permission to manage lien waivers.',
  not_authenticated: 'Your session expired. Sign in again.',
  waiver_not_found: 'That lien waiver was not found.',
  waiver_locked: 'This waiver has been sent or signed, so its content can no longer change. Void it and create a new one.',
  waiver_closed: 'This waiver is already closed.',
  waiver_expired: 'This signing link has expired. Ask the sender for a new one.',
  invalid_status_change: 'That status change is not allowed.',
  duplicate_waiver: 'A waiver of this type for this claimant already exists on this pay app.',
  payment_not_confirmed: 'Unconditional waivers release your rights. Confirm that payment has been received first.',
  invalid_direction: 'Choose whether you are giving or collecting this waiver.',
  invalid_type: 'Choose a waiver type.',
  invalid_state: 'Choose a valid state.',
  claimant_required: 'Enter the name of the party waiving their rights.',
  customer_required: 'Enter the owner / customer name.',
  date_required: 'Enter the “through” date.',
  invalid_amount: 'Enter a valid payment amount.',
  invalid_characters: 'Curly braces ({{ }}) are not allowed in waiver fields.',
  invalid_expiry: 'Choose between 1 and 90 days.',
  invalid_method: 'Choose how the signature was received.',
  name_required: 'Type a full name to sign.',
  reason_required: 'Enter a reason.',
  invalid_decision: 'Choose sign or decline.',
  text_too_long: 'One of the fields is too long.',
  template_not_found: 'No form wording exists for that state and type. Save your own wording first.',
  template_required: 'Enter a title and the waiver wording.',
  unresolved_placeholder: 'The wording contains a {{placeholder}} that Vireek does not recognise. Fix the template and try again.',
  project_not_found: 'That project is not in your account.',
  billing_not_found: 'That billing step is not in this project.',
  invoice_not_found: 'That invoice is not in your account.',
};

export function lienWaiverError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  for (const key of Object.keys(ERROR_COPY)) if (message.includes(key)) return ERROR_COPY[key];
  return fallback;
}

export function parsePublicLienWaiver(raw: unknown): PublicLienWaiver | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const type = str('waiver_type') as WaiverType | null;
  if (!type || !WAIVER_TYPES.includes(type) || !str('body') || !str('claimant_name')) return null;
  return {
    number: str('number'),
    title: str('title') ?? WAIVER_TYPE_LABEL[type],
    body: str('body') as string,
    direction: r.direction === 'received' ? 'received' : 'given',
    waiverType: type,
    stateCode: str('state_code') ?? 'US',
    statuteRef: str('statute_ref'),
    requiresNotary: r.requires_notary === true,
    claimantName: str('claimant_name') as string,
    customerName: str('customer_name') ?? '',
    propertyAddress: str('property_address'),
    projectName: str('project_name'),
    throughDate: str('through_date') ?? '',
    amountCents: Number(r.amount_cents) || 0,
    status: (['sent', 'signed', 'declined', 'void', 'expired'].includes(String(r.status)) ? r.status : 'void') as DisplayStatus,
    sentAt: str('sent_at'),
    expiresAt: str('expires_at'),
    signedAt: str('signed_at'),
    signerName: str('signer_name'),
    signerTitle: str('signer_title'),
    contentHash: str('content_hash'),
    businessName: str('business_name'),
  };
}
