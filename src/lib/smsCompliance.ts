import { supabase } from '@/lib/supabase';

/**
 * SMS compliance (A2P 10DLC) data layer.
 *
 * Real sources only — nothing here is mocked:
 *   - profiles            → brand / campaign registration status (written by the
 *                           register-a2p-brand edge function)
 *   - consent_records     → opt-in proof ledger (consent_type = 'marketing_sms')
 *   - dnc_suppressions    → opt-out log (written by sms-webhook on STOP, and by
 *                           the owner here). The same table gates sendCompliantSms().
 *
 * Every query is explicitly scoped to `accountOwnerId` on top of RLS.
 */

export type RegistrationStatus = 'not_started' | 'pending' | 'approved' | 'rejected';
export type OptOutReason = 'customer_opt_out' | 'manual' | 'national_registry';
export type OptInSource = 'ivr_verbal' | 'web_form' | 'manual' | 'import' | 'sms_reply';

export interface A2pRegistration {
  legal_business_name: string | null;
  ein: string | null;
  business_registration_type: string | null;
  business_website: string | null;
  sms_sample_message: string | null;
  sms_opt_in_description: string | null;
  a2p_brand_status: RegistrationStatus;
  a2p_campaign_status: RegistrationStatus;
  a2p_brand_sid: string | null;
  a2p_campaign_sid: string | null;
  a2p_requested_at: string | null;
  a2p_rejection_reason: string | null;
}

export interface OptOutRow {
  id: string;
  phone_number: string;
  reason: OptOutReason;
  created_at: string;
}

export interface OptInRow {
  id: string;
  contact_phone: string | null;
  contact_email: string | null;
  granted: boolean;
  source: OptInSource;
  notes: string | null;
  ip_address: string | null;
  created_at: string;
}

export type OverallState = 'not_started' | 'in_review' | 'approved' | 'action_required';

export interface Readiness {
  missing: { key: keyof A2pRegistration; label: string }[];
  complete: boolean;
}

export const OPT_OUT_PAGE_SIZE = 25;

const REGISTRATION_COLUMNS =
  'legal_business_name, ein, business_registration_type, business_website, sms_sample_message, sms_opt_in_description, a2p_brand_status, a2p_campaign_status, a2p_brand_sid, a2p_campaign_sid, a2p_requested_at, a2p_rejection_reason';

/** The fields register-a2p-brand refuses to run without. */
const REQUIRED_FIELDS: { key: keyof A2pRegistration; label: string }[] = [
  { key: 'legal_business_name', label: 'Legal business name' },
  { key: 'ein', label: 'EIN' },
  { key: 'business_registration_type', label: 'Business registration type' },
  { key: 'sms_sample_message', label: 'Sample message' },
  { key: 'sms_opt_in_description', label: 'Opt-in description' },
];

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/** Mirrors supabase/functions/_shared/compliance/dncCheck.ts so lookups match. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** E.164: + followed by 8–15 digits, first digit non-zero. */
export function isValidPhone(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(normalizePhone(phone));
}

export function maskEin(ein: string | null): string {
  if (!ein) return '—';
  const digits = ein.replace(/\D/g, '');
  return digits.length >= 4 ? `••-•••${digits.slice(-4)}` : '••••';
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length > 4 ? `${phone.slice(0, phone.length - 4).replace(/\d/g, '•')}${phone.slice(-4)}` : phone;
}

export function computeReadiness(reg: A2pRegistration): Readiness {
  const missing = REQUIRED_FIELDS.filter(({ key }) => !String(reg[key] ?? '').trim());
  return { missing, complete: missing.length === 0 };
}

/**
 * The send gate (a2pGate.ts) only checks campaign approval, so "can send" is
 * defined exactly the same way — the UI never claims more than the backend enforces.
 */
export function canSendSms(reg: Pick<A2pRegistration, 'a2p_campaign_status'>): boolean {
  return reg.a2p_campaign_status === 'approved';
}

export function overallState(reg: A2pRegistration): OverallState {
  if (reg.a2p_brand_status === 'rejected' || reg.a2p_campaign_status === 'rejected') return 'action_required';
  if (canSendSms(reg)) return 'approved';
  if (reg.a2p_brand_status === 'pending' || reg.a2p_campaign_status === 'pending') return 'in_review';
  return 'not_started';
}

/** Whether the owner may (re)submit through register-a2p-brand. */
export function canSubmit(reg: A2pRegistration): boolean {
  const state = overallState(reg);
  return (state === 'not_started' || state === 'action_required') && computeReadiness(reg).complete;
}

/** Ledger → current consent per contact (latest row wins), newest-first input expected. */
export function currentConsent(rows: OptInRow[]): { granted: number; revoked: number } {
  const seen = new Map<string, boolean>();
  for (const r of rows) {
    const key = r.contact_phone ? normalizePhone(r.contact_phone) : r.contact_email?.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.set(key, r.granted);
  }
  let granted = 0;
  for (const v of seen.values()) if (v) granted += 1;
  return { granted, revoked: seen.size - granted };
}

function csvCell(value: string | number | boolean | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formula injection, but keep phone numbers (+1555…) intact.
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?\d[\d\s().-]*$/.test(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Pulls the real message out of a failed edge-function call. */
export async function extractFunctionError(error: unknown, fallback: string): Promise<string> {
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const body = await ctx.json();
      if (body?.error) return String(body.detail?.message ? `${body.error}: ${body.detail.message}` : body.error);
    }
  } catch {
    /* fall through */
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export async function fetchRegistration(accountOwnerId: string): Promise<A2pRegistration> {
  const { data, error } = await supabase
    .from('profiles')
    .select(REGISTRATION_COLUMNS)
    .eq('id', accountOwnerId)
    .single();
  if (error) throw error;
  return data as A2pRegistration;
}

/** Calls the register-a2p-brand edge function (submits brand, stores the SID). */
export async function submitRegistration(): Promise<{ brandSid: string; status: string }> {
  const { data, error } = await supabase.functions.invoke('register-a2p-brand');
  if (error) throw new Error(await extractFunctionError(error, 'Registration failed'));
  if (!data?.success) throw new Error(data?.error ?? 'Registration failed');
  return { brandSid: data.brandSid, status: data.status };
}

export async function fetchOptOuts(
  accountOwnerId: string,
  opts: { search?: string; offset?: number; limit?: number } = {},
): Promise<{ rows: OptOutRow[]; total: number }> {
  const limit = opts.limit ?? OPT_OUT_PAGE_SIZE;
  const offset = opts.offset ?? 0;
  let filtered = supabase
    .from('dnc_suppressions')
    .select('id, phone_number, reason, created_at', { count: 'exact' })
    .eq('user_id', accountOwnerId);

  const digits = (opts.search ?? '').replace(/\D/g, '');
  if (digits) filtered = filtered.ilike('phone_number', `%${digits}%`);

  const { data, error, count } = await filtered
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: (data ?? []) as OptOutRow[], total: count ?? 0 };
}

/** Adds a number to the suppression list. Idempotent (existing rows are kept). */
export async function addManualOptOut(accountOwnerId: string, phone: string): Promise<void> {
  if (!isValidPhone(phone)) throw new Error('Enter a valid phone number');
  const { error } = await supabase
    .from('dnc_suppressions')
    .upsert(
      { user_id: accountOwnerId, phone_number: normalizePhone(phone), reason: 'manual' },
      { onConflict: 'user_id,phone_number', ignoreDuplicates: true },
    );
  if (error) throw error;
}

export async function fetchOptInProof(accountOwnerId: string, limit = 500): Promise<OptInRow[]> {
  const { data, error } = await supabase
    .from('consent_records')
    .select('id, contact_phone, contact_email, granted, source, notes, ip_address, created_at')
    .eq('user_id', accountOwnerId)
    .eq('consent_type', 'marketing_sms')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as OptInRow[];
}

/** Appends an opt-in to the consent ledger. Evidence notes are mandatory — that is the "proof". */
export async function recordOptIn(
  accountOwnerId: string,
  input: { phone: string; source: OptInSource; notes: string },
): Promise<void> {
  if (!isValidPhone(input.phone)) throw new Error('Enter a valid phone number');
  if (input.notes.trim().length < 10) throw new Error('Describe how consent was obtained (at least 10 characters)');
  const { error } = await supabase.from('consent_records').insert({
    user_id: accountOwnerId,
    contact_phone: normalizePhone(input.phone),
    consent_type: 'marketing_sms',
    granted: true,
    source: input.source,
    notes: input.notes.trim(),
  });
  if (error) throw error;
}
