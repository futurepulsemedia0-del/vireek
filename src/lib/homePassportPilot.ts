/**
 * Home Service Passport PILOT — client library (flag: home_passport_pilot, default OFF).
 *
 * All writes go through SECURITY DEFINER RPCs (see 20290301000000_home_passport_pilot.sql).
 * Nothing here can type a fact into a passport; predictions are shown only as ranges/windows.
 */

import { supabase } from '@/lib/supabase';

export const PILOT_FLAG_KEY = 'home_passport_pilot';

/** REQUIRES COUNSEL: this wording and its version id are placeholders, not legal text. */
export const CONSENT_TEXT_VERSION = 'DRAFT-v1-REQUIRES-COUNSEL';
export const SHARE_CONSENT_TEXT =
  'I confirm the property owner has agreed to this passport being shared with the recipient chosen above. ' +
  'It contains equipment, service history, permits and known issues, but no customer contact details and no prices.';
export const TRANSFER_CONSENT_TEXT =
  'I confirm the current property owner has explicitly agreed to transfer this property’s passport record at the sale, ' +
  'and that the method of consent selected is accurate.';

export type RecipientType = 'buyer' | 'agent' | 'inspector' | 'insurer' | 'lender' | 'owner';
export type AddressLevel = 'city' | 'full';
export type ConsentMethod = 'owner_in_person' | 'owner_written' | 'owner_electronic';
export type VerificationLevel = 'contractor_verified' | 'contractor_recorded' | 'owner_added';
export type ShareState = 'active' | 'expired' | 'exhausted' | 'revoked';

export interface PilotStatus {
  enabled: boolean;
  contributor_opt_in?: boolean;
  show_company_name?: boolean;
}
export interface PilotSnapshotMeta {
  snapshot_id: string;
  version: number;
  purpose: 'share' | 'ownership_transfer';
  snapshot_hash: string;
  created_at: string;
  active_links: number;
  redaction: Record<string, unknown>;
}
export interface PilotShare {
  link_id: string;
  snapshot_id: string;
  version: number;
  recipient_type: RecipientType;
  label: string | null;
  expires_at: string;
  max_views: number;
  view_count: number;
  last_viewed_at: string | null;
  revoked_at: string | null;
  created_at: string;
  state: ShareState;
}
export interface IssuedShare {
  link_id: string;
  token: string;
  expires_at: string;
  snapshot_id: string;
  version: number;
}
export interface PilotTransfer {
  transfer_id: string;
  customer_id: string;
  site_id: string;
  snapshot_id: string;
  status: 'pending' | 'completed' | 'cancelled' | 'expired';
  consent_method: ConsentMethod;
  consent_text_version: string;
  consent_confirmed_at: string;
  closing_date: string | null;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
}
export interface PilotMetrics {
  window_days: number;
  totals: {
    passports_created: number;
    snapshots_created: number;
    shares_created: number;
    share_views: number;
    shares_revoked: number;
    transfers_requested: number;
    transfers_completed: number;
    transfers_cancelled: number;
  };
  raw_views_all_time: number;
  daily: { day: string; passports: number; shares: number; views: number; transfers: number }[];
}
export interface PilotAuditEntry {
  id: number;
  action: string;
  subject_type: string;
  subject_id: string | null;
  detail: Record<string, unknown>;
  by_me: boolean;
  by_public_visitor: boolean;
  created_at: string;
}

export interface PayloadV2 {
  schema: string;
  generated_at: string;
  serviced_by: string | null;
  property: { address?: string | null; city?: string | null; state?: string | null; postal_code?: string | null; property_kind?: string | null };
  summary: Record<string, number | string | null>;
  health: { score?: number; grade?: string; confidence?: string } | null;
  equipment: Array<Record<string, unknown> & { label?: string; verification?: VerificationLevel }>;
  owner_added_items: Array<{ category?: string; name?: string; brand?: string; model?: string; purchase_date?: string; warranty_expires_at?: string; verification: VerificationLevel }>;
  service_history: Array<Record<string, unknown> & { date?: string; service_type?: string; verification?: VerificationLevel }>;
  permits: Array<Record<string, unknown>>;
  known_problems: Array<{ kind?: string; severity?: string; equipment?: string | null; title?: string; detail?: string }>;
  maintenance_windows: Array<{ equipment?: string; overdue?: boolean; service_window_from?: string; service_window_to?: string; issue_window_from?: string; issue_window_to?: string }>;
  cost_ranges: {
    annual_range: { low: number; high: number };
    five_year_range: { low: number; high: number };
    confidence: string;
    assumptions: string[];
    disclaimer: string;
  } | null;
  prediction_notes: string[];
  verification_levels: Record<VerificationLevel, string>;
  redaction: Record<string, unknown>;
}

export type PublicShareResult =
  | { status: 'valid'; issued_at: string; expires_at: string; recipient_type: RecipientType; version: number; snapshot_hash: string; snapshot: PayloadV2 }
  | { status: 'expired' | 'revoked' | 'exhausted' | 'tampered' | 'not_found' | 'rate_limited' };

// ------------------------------------------------------------------ pure helpers

export const RECIPIENT_OPTIONS: { value: RecipientType; label: string }[] = [
  { value: 'buyer', label: 'Buyer' },
  { value: 'agent', label: 'Real-estate agent' },
  { value: 'inspector', label: 'Inspector' },
  { value: 'insurer', label: 'Insurer' },
  { value: 'lender', label: 'Lender' },
  { value: 'owner', label: 'Owner' },
];

export const CONSENT_METHOD_OPTIONS: { value: ConsentMethod; label: string }[] = [
  { value: 'owner_in_person', label: 'Owner confirmed in person' },
  { value: 'owner_written', label: 'Owner confirmed in writing' },
  { value: 'owner_electronic', label: 'Owner confirmed electronically' },
];

export const VERIFICATION_LABELS: Record<VerificationLevel, string> = {
  contractor_verified: 'Contractor-verified',
  contractor_recorded: 'Contractor-recorded',
  owner_added: 'Owner-added',
};

const ERROR_COPY: Record<string, string> = {
  HPP_DISABLED: 'The Home Passport pilot is not enabled for your account.',
  HPP_FORBIDDEN: 'Only managers can do this.',
  HPP_UNAUTHENTICATED: 'Please sign in again.',
  HPP_OPT_IN_REQUIRED: 'Turn on “Contribute to shared passports” first.',
  HPP_CONSENT_REQUIRED: 'Owner consent must be confirmed.',
  HPP_NOT_FOUND: 'That record was not found.',
  HPP_RATE_LIMITED: 'Too many requests today. Please try again later.',
  HPP_CONFLICT: 'This conflicts with the current state (for example, a transfer is already pending).',
  HPP_EXPIRED: 'This request has expired. Start a new one.',
  HPP_INVALID: 'Some of the values are not valid.',
  HPP_REDACTION_FAILED: 'The passport could not be created because a privacy check failed.',
  HPP_IMMUTABLE: 'This record can no longer be changed.',
};

/** Turns a Supabase/Postgres error into a safe, human sentence. Unknown errors never leak details. */
export function mapPilotError(err: unknown): string {
  const msg = typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err ?? '');
  const m = /HPP_[A-Z_]+/.exec(msg);
  if (m && ERROR_COPY[m[0]]) {
    if (m[0] === 'HPP_INVALID' || m[0] === 'HPP_CONFLICT') {
      const detail = msg.split(`${m[0]}:`)[1]?.trim();
      if (detail && detail.length < 120) return `${ERROR_COPY[m[0]]} (${detail})`;
    }
    return ERROR_COPY[m[0]];
  }
  return 'Something went wrong. Please try again.';
}

export function shareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/passport/share/${token}`;
}

export function formatRange(low: number, high: number, currency = 'USD'): string {
  const f = new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 });
  return `${f.format(low)} – ${f.format(high)}`;
}

export function formatWindow(from?: string | null, to?: string | null): string | null {
  if (!from || !to) return null;
  const f = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const a = f(from);
  const b = f(to);
  return a === b ? a : `${a} – ${b}`;
}

export function shareStateLabel(s: ShareState): string {
  return { active: 'Active', expired: 'Expired', exhausted: 'View limit reached', revoked: 'Revoked' }[s];
}

/** Mirror of the server's forbidden-key list. Used as defence in depth before rendering a public payload. */
const FORBIDDEN_KEYS = new Set([
  'customer_name', 'customer_phone', 'customer_email', 'customer_address', 'phone', 'email', 'price', 'price_cents',
  'purchase_price_cents', 'amount', 'total_cents', 'cost', 'cost_cents', 'invoice', 'invoice_total', 'margin',
  'technician', 'technician_name', 'notes', 'retailer',
]);

export function findForbiddenKeys(value: unknown, found: Set<string> = new Set(), depth = 0): string[] {
  if (depth > 12 || value === null || typeof value !== 'object') return [...found].sort();
  if (Array.isArray(value)) {
    for (const v of value) findForbiddenKeys(v, found, depth + 1);
  } else {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) found.add(k);
      findForbiddenKeys(v, found, depth + 1);
    }
  }
  return [...found].sort();
}

/** A cost block is renderable only as a genuine range with assumptions and a disclaimer. */
export function isRenderableRange(c: PayloadV2['cost_ranges']): c is NonNullable<PayloadV2['cost_ranges']> {
  return !!c && c.annual_range.high > c.annual_range.low && c.five_year_range.high > c.five_year_range.low
    && Array.isArray(c.assumptions) && c.assumptions.length > 0 && typeof c.disclaimer === 'string' && c.disclaimer.length > 0;
}

// ------------------------------------------------------------------------ API

export async function getPilotStatus(): Promise<PilotStatus> {
  const { data, error } = await supabase.rpc('get_home_passport_pilot_status');
  if (error) throw error;
  return data as PilotStatus;
}

export async function setPilotSettings(optIn: boolean, showCompany: boolean): Promise<{ links_revoked: number }> {
  const { data, error } = await supabase.rpc('set_home_passport_pilot_settings', { p_opt_in: optIn, p_show_company: showCompany });
  if (error) throw error;
  return data as { links_revoked: number };
}

export async function createSnapshot(customerId: string, addressLevel: AddressLevel, projections: object | null) {
  const { data, error } = await supabase.rpc('create_home_passport_snapshot', {
    p_customer_id: customerId, p_address_level: addressLevel, p_projections: projections,
  });
  if (error) throw error;
  return data as { snapshot_id: string; version: number; snapshot_hash: string; created_at: string };
}

export async function listSnapshots(customerId: string): Promise<PilotSnapshotMeta[]> {
  const { data, error } = await supabase.rpc('list_home_passport_snapshots', { p_customer_id: customerId });
  if (error) throw error;
  return (data ?? []) as PilotSnapshotMeta[];
}

export async function createShare(args: {
  snapshotId: string; recipientType: RecipientType; label: string; validDays: number; maxViews: number; consent: boolean;
}): Promise<IssuedShare> {
  const { data, error } = await supabase.rpc('create_home_passport_share', {
    p_snapshot_id: args.snapshotId,
    p_recipient_type: args.recipientType,
    p_label: args.label.trim() || null,
    p_valid_days: args.validDays,
    p_max_views: args.maxViews,
    p_owner_consent: args.consent,
    p_consent_text_version: CONSENT_TEXT_VERSION,
  });
  if (error) throw error;
  return data as IssuedShare;
}

export async function listShares(customerId: string): Promise<PilotShare[]> {
  const { data, error } = await supabase.rpc('list_home_passport_shares', { p_customer_id: customerId });
  if (error) throw error;
  return (data ?? []) as PilotShare[];
}

export async function revokeShare(linkId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_home_passport_share', { p_link_id: linkId });
  if (error) throw error;
}

export async function requestTransfer(args: {
  customerId: string; siteId: string; method: ConsentMethod; validDays: number; addressLevel: AddressLevel; projections: object | null;
}) {
  const { data, error } = await supabase.rpc('request_home_ownership_transfer', {
    p_customer_id: args.customerId,
    p_site_id: args.siteId,
    p_consent_method: args.method,
    p_consent_text_version: CONSENT_TEXT_VERSION,
    p_valid_days: args.validDays,
    p_address_level: args.addressLevel,
    p_projections: args.projections,
  });
  if (error) throw error;
  return data as { transfer_id: string; snapshot_id: string; version: number; expires_at: string };
}

export async function completeTransfer(transferId: string, closingDate: string | null) {
  const { data, error } = await supabase.rpc('complete_home_ownership_transfer', { p_transfer_id: transferId, p_closing_date: closingDate });
  if (error) throw error;
  return data as { links_revoked: number };
}

export async function cancelTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_home_ownership_transfer', { p_transfer_id: transferId });
  if (error) throw error;
}

export async function listTransfers(customerId: string | null): Promise<PilotTransfer[]> {
  const { data, error } = await supabase.rpc('list_home_ownership_transfers', { p_customer_id: customerId });
  if (error) throw error;
  return (data ?? []) as PilotTransfer[];
}

export async function getMetrics(days = 30): Promise<PilotMetrics> {
  const { data, error } = await supabase.rpc('get_home_passport_pilot_metrics', { p_days: days });
  if (error) throw error;
  return data as PilotMetrics;
}

export async function listAudit(limit = 50): Promise<PilotAuditEntry[]> {
  const { data, error } = await supabase.rpc('list_home_passport_pilot_audit', { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as PilotAuditEntry[];
}

export async function verifyShare(token: string): Promise<PublicShareResult> {
  const { data, error } = await supabase.rpc('verify_home_passport_share', { p_token: token });
  if (error) throw error;
  return data as PublicShareResult;
}

export async function verifyCode(code: string): Promise<{ found: boolean; rate_limited?: boolean } & Record<string, unknown>> {
  const { data, error } = await supabase.rpc('verify_home_passport_code', { p_code: code });
  if (error) throw error;
  return data as { found: boolean } & Record<string, unknown>;
}
