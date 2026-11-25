/**
 * Subcontractor compliance — licence verification + insurance certificates (COI).
 *
 * Sits on top of Vendor Management (vendorManagement.ts) and the job board. All rules that decide
 * what is "ok / expiring / expired / blocked" are PURE functions (injectable `now`) and mirror the
 * SQL in 20290311000001 / 20290311000002; every write goes through a SECURITY DEFINER RPC.
 */

import { supabase } from './supabase';

// ============================================================ types

export type CoverageType = 'general_liability' | 'workers_comp' | 'commercial_auto' | 'umbrella';
export type CoiRecordStatus = 'pending' | 'verified' | 'rejected';
export type CoiState = 'ok' | 'pending' | 'expired' | 'missing' | 'below_minimum';
export type LicenseStatus = 'active' | 'inactive' | 'expired' | 'suspended' | 'revoked' | 'unknown';
export type ExpiryState = 'expired' | 'expiring' | 'valid' | 'none';

export const COVERAGE_LABELS: Record<CoverageType, string> = {
  general_liability: 'General liability',
  workers_comp: 'Workers’ compensation',
  commercial_auto: 'Commercial auto',
  umbrella: 'Umbrella / excess',
};
export const COVERAGE_OPTIONS = Object.keys(COVERAGE_LABELS) as CoverageType[];

export const LICENSE_STATUS_LABELS: Record<LicenseStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  expired: 'Expired',
  suspended: 'Suspended',
  revoked: 'Revoked',
  unknown: 'Could not confirm',
};
export const LICENSE_STATUS_OPTIONS = Object.keys(LICENSE_STATUS_LABELS) as LicenseStatus[];

export const COI_STATE_LABELS: Record<CoiState, string> = {
  ok: 'Valid',
  pending: 'Awaiting verification',
  expired: 'Expired',
  missing: 'Missing',
  below_minimum: 'Below required limit',
};

export const EXPIRY_WARNING_DAYS = 30;

export interface VendorCoverage {
  id: string;
  vendor_id: string;
  coverage_type: CoverageType;
  carrier: string | null;
  policy_number: string | null;
  effective_on: string | null;
  expires_on: string;
  each_occurrence_cents: number | null;
  aggregate_cents: number | null;
  file_path: string | null;
  extraction_method: 'manual' | 'ocr';
  status: CoiRecordStatus;
  verified_at: string | null;
  notes: string | null;
}

export interface VendorLicenseCheck {
  id: string;
  vendor_id: string;
  license_number: string;
  jurisdiction: string;
  trade: string | null;
  holder_name: string | null;
  license_status: LicenseStatus;
  effective_status: LicenseStatus;
  expires_on: string | null;
  source_url: string | null;
  method: 'manual' | 'primary_source_api';
  checked_by: string | null;
  checked_at: string;
  next_check_at: string | null;
  notes: string | null;
}

export interface ComplianceSettings {
  coi_enforcement: 'off' | 'block';
  coi_required_coverages: CoverageType[];
  coi_grace_days: number;
  coi_min_general_liability_cents: number | null;
  license_recheck_days: number | null;
}

export interface CoiStatusPayload {
  enforcement: 'off' | 'block';
  exempt: boolean;
  exempt_reason: string | null;
  blocked: boolean;
  coverages: { coverage_type: CoverageType; state: CoiState; expires_on: string | null }[];
}

// ============================================================ pure helpers

const DAY_MS = 86_400_000;

function dayNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : Math.floor(t / DAY_MS);
}

function todayNumber(now: Date): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
}

export function daysLeft(expiresOn: string | null | undefined, now: Date = new Date()): number | null {
  const d = dayNumber(expiresOn);
  return d === null ? null : d - todayNumber(now);
}

export function expiryState(expiresOn: string | null | undefined, now: Date = new Date()): ExpiryState {
  const left = daysLeft(expiresOn, now);
  if (left === null) return 'none';
  if (left < 0) return 'expired';
  return left <= EXPIRY_WARNING_DAYS ? 'expiring' : 'valid';
}

/** Mirrors vendor_coi_status() in SQL: newest non-rejected row per required coverage wins. */
export function evaluateCoi(
  required: CoverageType[],
  rows: Pick<VendorCoverage, 'coverage_type' | 'status' | 'expires_on' | 'each_occurrence_cents'>[],
  opts: { graceDays?: number; minGlCents?: number | null; now?: Date } = {},
): { coverage_type: CoverageType; state: CoiState; expires_on: string | null }[] {
  const now = opts.now ?? new Date();
  const grace = Math.max(0, opts.graceDays ?? 0);
  return required.map((type) => {
    const best = rows
      .filter((r) => r.coverage_type === type && r.status !== 'rejected')
      .sort((a, b) => (a.expires_on < b.expires_on ? 1 : a.expires_on > b.expires_on ? -1 : 0))[0];
    if (!best) return { coverage_type: type, state: 'missing' as const, expires_on: null };
    const left = daysLeft(best.expires_on, now);
    let state: CoiState = 'ok';
    if (left !== null && left + grace < 0) state = 'expired';
    else if (best.status !== 'verified') state = 'pending';
    else if (type === 'general_liability' && opts.minGlCents != null && (best.each_occurrence_cents ?? 0) < opts.minGlCents) {
      state = 'below_minimum';
    }
    return { coverage_type: type, state, expires_on: best.expires_on };
  });
}

export function isCoiBlocking(
  enforcement: 'off' | 'block',
  exempt: boolean,
  statuses: { state: CoiState }[],
): boolean {
  return enforcement === 'block' && !exempt && statuses.some((s) => s.state !== 'ok');
}

export interface CoverageInput {
  coverage_type: CoverageType;
  carrier: string;
  policy_number: string;
  effective_on: string;
  expires_on: string;
  each_occurrence: string;
  aggregate: string;
  notes: string;
}

/** "1,000,000" / "1000000.50" -> cents; '' -> null; invalid -> undefined. */
export function parseMoneyToCents(raw: string): number | null | undefined {
  const t = raw.trim().replace(/[$,\s]/g, '');
  if (t === '') return null;
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
}

/** Returns a human-readable problem, or null when the form can be submitted. */
export function validateCoverageInput(i: CoverageInput): string | null {
  if (!COVERAGE_OPTIONS.includes(i.coverage_type)) return 'Choose a coverage type.';
  if (dayNumber(i.expires_on) === null) return 'Enter the policy expiry date.';
  if (i.effective_on && dayNumber(i.effective_on) === null) return 'The effective date is not a valid date.';
  if (i.effective_on && dayNumber(i.effective_on)! > dayNumber(i.expires_on)!) return 'The policy expires before it starts.';
  if (parseMoneyToCents(i.each_occurrence) === undefined) return 'The each-occurrence limit must be a number.';
  if (parseMoneyToCents(i.aggregate) === undefined) return 'The aggregate limit must be a number.';
  if (i.carrier.length > 200 || i.policy_number.length > 80 || i.notes.length > 1000) return 'One of the text fields is too long.';
  return null;
}

export interface LicenseInput {
  license_number: string;
  jurisdiction: string;
  status: LicenseStatus;
  expires_on: string;
  source_url: string;
  holder_name: string;
  trade: string;
  notes: string;
}

export const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD',
  'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

export function validateLicenseInput(i: LicenseInput, now: Date = new Date()): string | null {
  if (!i.license_number.trim()) return 'Enter the licence number.';
  if (i.license_number.trim().length > 64) return 'The licence number is too long.';
  if (!/^US-[A-Z]{2}$/.test(i.jurisdiction) || !(US_STATE_CODES as readonly string[]).includes(i.jurisdiction.slice(3))) {
    return 'Choose the issuing state.';
  }
  if (!LICENSE_STATUS_OPTIONS.includes(i.status)) return 'Choose the licence status.';
  if (i.expires_on) {
    const d = dayNumber(i.expires_on);
    if (d === null) return 'The expiry date is not a valid date.';
    if (d > todayNumber(now) + 365 * 20) return 'The expiry date is too far in the future.';
  }
  const url = i.source_url.trim();
  if (url && (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 500)) return 'The source link must be a valid https:// address.';
  if (i.status === 'active' && !url) return 'Paste the link to the licensing-board record that shows this licence as active.';
  if (i.holder_name.length > 200 || i.trade.length > 80 || i.notes.length > 1000) return 'One of the text fields is too long.';
  return null;
}

export const ALLOWED_COI_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const MAX_COI_BYTES = 10 * 1024 * 1024;

export function validateCoiFile(file: { type: string; size: number }): string | null {
  if (!ALLOWED_COI_MIME.includes(file.type)) return 'Upload a PDF or a photo (JPG, PNG, WebP, HEIC).';
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > MAX_COI_BYTES) return 'The file is larger than 10 MB.';
  return null;
}

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/** {owner}/{vendor}/{uuid}.{ext}  — the SQL RPC rejects any path outside this shape. */
export function coiStoragePath(ownerId: string, vendorId: string, mime: string, uuid: string): string {
  return `${ownerId}/${vendorId}/${uuid}.${EXT_BY_MIME[mime] ?? 'bin'}`;
}

/** Maps RPC / constraint errors to something a person can act on. */
export function complianceErrorMessage(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : '';
  if (/FORBIDDEN/.test(msg)) return 'Only an owner, admin or billing manager can change vendor compliance.';
  if (/VENDOR_NOT_FOUND/.test(msg)) return 'That vendor no longer exists.';
  if (/SOURCE_URL_REQUIRED|vlc_active_has_source/.test(msg)) return 'An active licence needs a link to the licensing-board record.';
  if (/EXPIRY_REQUIRED/.test(msg)) return 'Enter the policy expiry date.';
  if (/INVALID_FILE_PATH/.test(msg)) return 'The uploaded file does not belong to this vendor. Upload it again.';
  if (/COVERAGE_NOT_FOUND/.test(msg)) return 'That coverage record no longer exists.';
  if (/REASON_REQUIRED|vcr_exempt_needs_reason/.test(msg)) return 'Write a short reason for the exemption.';
  if (/vlc_|vcc_|violates check constraint/.test(msg)) return 'One of the values is not allowed. Check the dates, limits and licence number.';
  return fallback;
}

/** Friendly reason shown in the job board when an award is refused. */
export const COI_BLOCK_MESSAGE =
  'Insurance certificate missing, unverified or expired. Add and verify the coverage in Vendors, or switch enforcement off in compliance settings.';

// ============================================================ data access

function throwIfError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export async function fetchVendorCoverages(vendorId: string): Promise<VendorCoverage[]> {
  const { data, error } = await supabase
    .from('vendor_coi_coverages')
    .select('id, vendor_id, coverage_type, carrier, policy_number, effective_on, expires_on, each_occurrence_cents, aggregate_cents, file_path, extraction_method, status, verified_at, notes')
    .eq('vendor_id', vendorId)
    .order('expires_on', { ascending: false });
  throwIfError(error);
  return (data ?? []) as VendorCoverage[];
}

export async function fetchVendorCoiStatus(vendorId: string): Promise<CoiStatusPayload> {
  const { data, error } = await supabase.rpc('get_vendor_coi_status', { p_vendor_id: vendorId });
  throwIfError(error);
  return data as CoiStatusPayload;
}

export async function saveVendorCoverage(vendorId: string, i: CoverageInput, filePath: string | null, id?: string): Promise<string> {
  const problem = validateCoverageInput(i);
  if (problem) throw new Error(problem);
  const { data, error } = await supabase.rpc('save_vendor_coi_coverage', {
    p_vendor_id: vendorId,
    p_coverage_type: i.coverage_type,
    p_expires_on: i.expires_on,
    p_carrier: i.carrier.trim() || null,
    p_policy_number: i.policy_number.trim() || null,
    p_effective_on: i.effective_on || null,
    p_each_occurrence_cents: parseMoneyToCents(i.each_occurrence) ?? null,
    p_aggregate_cents: parseMoneyToCents(i.aggregate) ?? null,
    p_file_path: filePath,
    p_notes: i.notes.trim() || null,
    p_id: id ?? null,
  });
  throwIfError(error);
  return data as string;
}

export async function setCoverageStatus(id: string, status: CoiRecordStatus): Promise<void> {
  const { error } = await supabase.rpc('set_vendor_coi_coverage_status', { p_id: id, p_status: status });
  throwIfError(error);
}

export async function deleteCoverage(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_vendor_coi_coverage', { p_id: id });
  throwIfError(error);
}

export async function setCoiRequirement(vendorId: string, exempt: boolean, reason: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_vendor_coi_requirement', {
    p_vendor_id: vendorId,
    p_exempt: exempt,
    p_reason: reason,
    p_required: null,
  });
  throwIfError(error);
}

export async function uploadCoiFile(ownerId: string, vendorId: string, file: File): Promise<string> {
  const problem = validateCoiFile(file);
  if (problem) throw new Error(problem);
  const path = coiStoragePath(ownerId, vendorId, file.type, crypto.randomUUID());
  const { error } = await supabase.storage.from('vendor-documents').upload(path, file, { contentType: file.type, upsert: false });
  throwIfError(error);
  return path;
}

export async function signedCoiUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('vendor-documents').createSignedUrl(path, 120);
  throwIfError(error);
  return data!.signedUrl;
}

export async function fetchLicenseChecks(vendorId: string): Promise<{ current: VendorLicenseCheck[]; history: VendorLicenseCheck[] }> {
  const cols = 'id, vendor_id, license_number, jurisdiction, trade, holder_name, license_status, expires_on, source_url, method, checked_by, checked_at, next_check_at, notes';
  const [cur, hist] = await Promise.all([
    supabase.from('vendor_license_current').select(`${cols}, effective_status`).eq('vendor_id', vendorId).order('checked_at', { ascending: false }),
    supabase.from('vendor_license_checks').select(cols).eq('vendor_id', vendorId).order('checked_at', { ascending: false }).limit(50),
  ]);
  throwIfError(cur.error);
  throwIfError(hist.error);
  return {
    current: (cur.data ?? []) as VendorLicenseCheck[],
    history: ((hist.data ?? []) as Omit<VendorLicenseCheck, 'effective_status'>[]).map((r) => ({ ...r, effective_status: r.license_status })),
  };
}

export async function recordLicenseCheck(vendorId: string, i: LicenseInput): Promise<string> {
  const problem = validateLicenseInput(i);
  if (problem) throw new Error(problem);
  const { data, error } = await supabase.rpc('record_vendor_license_check', {
    p_vendor_id: vendorId,
    p_license_number: i.license_number.trim(),
    p_jurisdiction: i.jurisdiction,
    p_status: i.status,
    p_expires_on: i.expires_on || null,
    p_source_url: i.source_url.trim() || null,
    p_holder_name: i.holder_name.trim() || null,
    p_trade: i.trade.trim() || null,
    p_notes: i.notes.trim() || null,
  });
  throwIfError(error);
  return data as string;
}

export async function fetchComplianceSettings(): Promise<ComplianceSettings> {
  const { data, error } = await supabase.rpc('get_vendor_compliance_settings');
  throwIfError(error);
  return data as ComplianceSettings;
}

export async function saveComplianceSettings(patch: Partial<ComplianceSettings>): Promise<void> {
  const { error } = await supabase.rpc('save_vendor_compliance_settings', { p: patch });
  throwIfError(error);
}
