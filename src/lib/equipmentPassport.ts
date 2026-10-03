/**
 * VIREEK Equipment Passport — client API + pure helpers.
 *
 * One permanent identity per physical machine (QR / NFC), independent of any contractor or owner.
 * All reads/writes go through SECURITY DEFINER RPCs (see 20270210000000_equipment_passport.sql).
 */

import { supabase } from '@/lib/supabase';

export type PassportEventType =
  | 'registered'
  | 'installed'
  | 'service_visit'
  | 'inspection'
  | 'repair'
  | 'part_replaced'
  | 'outcome'
  | 'warranty_event'
  | 'custody_change'
  | 'identity_corrected'
  | 'note'
  | 'decommissioned';

export type ManualEventType = Extract<PassportEventType, 'inspection' | 'repair' | 'part_replaced' | 'note' | 'decommissioned'>;

export interface PassportSummary {
  service_type?: string;
  diagnosis?: string;
  technician?: string;
  parts?: { name: string; qty?: number | null }[];
  photos?: { count: number; fingerprinted: number };
  warranty?: { expires_at?: string; active_at_service?: boolean; claims?: number; claim_status?: string; claim_deadline?: string };
  work?: string[];
  outcome?: { resolution?: string; first_time_fix?: boolean; customer_rating?: number };
  evidence?: { score?: number; level?: string; integrity_valid?: boolean };
  manual?: boolean;
  action?: string;
}

export interface PassportEvent {
  id: string;
  seq: number;
  event_type: PassportEventType;
  title: string;
  detail: string | null;
  occurred_at: string;
  recorded_at: string;
  contributor_name: string | null;
  is_mine: boolean;
  visibility: 'public' | 'network';
  summary: PassportSummary;
  entry_hash: string;
}

export interface PassportCore {
  code: string;
  status: 'active' | 'retired' | 'merged';
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  created_at: string;
}

export interface PassportIntegrity {
  valid: boolean;
  checked: number;
  broken_at_seq?: number;
  head_hash?: string | null;
}

export interface PassportData {
  found: boolean;
  access?: 'member' | 'public';
  passport?: PassportCore;
  link?: { role: 'installer' | 'servicer'; verified: boolean; show_contractor_publicly: boolean; equipment_id: string | null } | null;
  events?: PassportEvent[];
  stats?: {
    event_count: number;
    service_count: number;
    contractor_count: number;
    last_service_at: string | null;
    first_event_at: string | null;
  };
  integrity?: PassportIntegrity;
}

export interface PassportListItem {
  code: string | null; // null until the contractor proves physical access (scans the label)
  status: 'active' | 'retired' | 'merged';
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  equipment_id: string | null;
  verified: boolean;
  role: 'installer' | 'servicer';
  linked_at: string;
  show_contractor_publicly: boolean;
  customer_id: string | null;
  customer_name: string | null;
  event_count: number;
  service_count: number;
  last_service_at: string | null;
}

// ─── Code helpers (must mirror vp_generate_code / vp_normalize_code in SQL) ────────────────────

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** Accepts "VEQ-ABCD-EFGH-JKMN", a raw 12-char code, or a full scanned URL ending in /e/<code>. */
export function normalizePassportCode(input: string): string {
  let raw = (input ?? '').trim();
  const urlMatch = raw.match(/\/e\/([^/?#\s]+)/i);
  if (urlMatch) raw = urlMatch[1];
  let c = raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  if (c.length === 15 && c.startsWith('VEQ')) c = c.slice(3);
  return c;
}

export function isValidPassportCode(input: string): boolean {
  return CODE_RE.test(normalizePassportCode(input));
}

export function formatPassportCode(input: string): string {
  const c = normalizePassportCode(input);
  return CODE_RE.test(c) ? `VEQ-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}` : input;
}

/** The URL encoded in the QR code and written to NFC tags. Short on purpose (lower QR density). */
export function passportUrl(code: string, origin: string = typeof window !== 'undefined' ? window.location.origin : 'https://vireek.com'): string {
  return `${origin.replace(/\/$/, '')}/e/${normalizePassportCode(code)}`;
}

export function maskSerial(serial: string | null | undefined): string {
  const s = (serial ?? '').trim();
  if (!s) return '—';
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

export function equipmentTitle(p: Pick<PassportCore, 'make' | 'model' | 'equipment_type'>): string {
  return [p.make, p.model].filter(Boolean).join(' ') || p.equipment_type;
}

export type WarrantyState = 'unknown' | 'active' | 'expiring' | 'expired';

export function warrantyState(expiresAt: string | null | undefined, now: Date = new Date()): { state: WarrantyState; daysLeft: number | null } {
  if (!expiresAt) return { state: 'unknown', daysLeft: null };
  const end = new Date(`${expiresAt.slice(0, 10)}T23:59:59`);
  if (Number.isNaN(end.getTime())) return { state: 'unknown', daysLeft: null };
  const daysLeft = Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
  if (daysLeft < 0) return { state: 'expired', daysLeft };
  return { state: daysLeft <= 90 ? 'expiring' : 'active', daysLeft };
}

// ─── The service journey: Diagnosis → Technician → Parts → Photos → Warranty → Repair → Outcome ─

export type JourneyKey = 'diagnosis' | 'technician' | 'parts' | 'photos' | 'warranty' | 'repair' | 'outcome';

export interface JourneyStep {
  key: JourneyKey;
  label: string;
  done: boolean;
  text: string;
}

const RESOLUTION_LABEL: Record<string, string> = {
  fixed: 'Fixed',
  resolved: 'Resolved',
  part_ordered: 'Part ordered',
  needs_followup: 'Needs follow-up',
  referred: 'Referred',
  no_fault_found: 'No fault found',
};

export function resolutionLabel(resolution: string | undefined): string {
  if (!resolution) return 'Recorded';
  return RESOLUTION_LABEL[resolution] ?? resolution.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function buildJourney(s: PassportSummary): JourneyStep[] {
  const parts = (s.parts ?? []).filter((p) => p.name);
  const photos = s.photos?.count ?? 0;
  const w = s.warranty;
  const warrantyText = w?.claims
    ? `${w.claims} warranty claim${w.claims === 1 ? '' : 's'} filed`
    : w?.active_at_service === true
      ? 'Under warranty at the time of service'
      : w?.active_at_service === false
        ? 'Out of warranty at the time of service'
        : '';
  const o = s.outcome;
  const outcomeText = o
    ? `${resolutionLabel(o.resolution)}${o.first_time_fix === true ? ' · first-time fix' : o.first_time_fix === false ? ' · rework / callback' : ''}`
    : '';
  const work = (s.work ?? []).filter(Boolean);

  return [
    { key: 'diagnosis', label: 'Diagnosis', done: !!s.diagnosis, text: s.diagnosis ?? '' },
    { key: 'technician', label: 'Technician', done: !!s.technician, text: s.technician ?? '' },
    {
      key: 'parts',
      label: 'Parts',
      done: parts.length > 0,
      text: parts.map((p) => (p.qty && Number(p.qty) > 1 ? `${p.name} ×${p.qty}` : p.name)).join(', '),
    },
    {
      key: 'photos',
      label: 'Photos',
      done: photos > 0,
      text: photos > 0 ? `${photos} photo${photos === 1 ? '' : 's'} on file${s.photos?.fingerprinted ? ` · ${s.photos.fingerprinted} cryptographically fingerprinted` : ''}` : '',
    },
    { key: 'warranty', label: 'Warranty', done: !!warrantyText, text: warrantyText },
    { key: 'repair', label: 'Repair', done: work.length > 0, text: work.join(' → ') },
    { key: 'outcome', label: 'Outcome', done: !!o, text: outcomeText },
  ];
}

export function journeyCompleteness(steps: JourneyStep[]): number {
  return steps.length === 0 ? 0 : Math.round((steps.filter((s) => s.done).length / steps.length) * 100);
}

// ─── Errors ───────────────────────────────────────────────────────────────────────────────────

const ERROR_COPY: Record<string, string> = {
  PASSPORT_UNAUTHORIZED: 'Please sign in to continue.',
  PASSPORT_NOT_FOUND: 'No passport matches that code. Check the label and try again.',
  PASSPORT_EQUIPMENT_NOT_FOUND: 'That equipment record was not found in your account.',
  PASSPORT_CUSTOMER_NOT_FOUND: 'That customer was not found in your account.',
  PASSPORT_ALREADY_LINKED: 'This passport is already attached to equipment in your account.',
  PASSPORT_CONFLICT: 'This equipment already carries a different passport with history, so it cannot be merged automatically.',
  PASSPORT_FORBIDDEN: 'Only a verified servicing company can add to this passport. Scan the label to verify.',
  PASSPORT_IMMUTABLE: 'Passport history is append-only.',
  PASSPORT_INVALID: 'Some of the details are not valid.',
};

export function passportErrorMessage(err: unknown): string {
  const msg = typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err ?? '');
  const key = Object.keys(ERROR_COPY).find((k) => msg.includes(k));
  if (key === 'PASSPORT_INVALID') {
    const detail = msg.split('PASSPORT_INVALID:')[1]?.trim();
    return detail ? `Not valid: ${detail}` : ERROR_COPY.PASSPORT_INVALID;
  }
  return key ? ERROR_COPY[key] : 'Something went wrong. Please try again.';
}

// ─── API ──────────────────────────────────────────────────────────────────────────────────────

/** Public, no login. Sanitised view (public events only, serial masked). */
export async function fetchPublicPassport(code: string): Promise<PassportData> {
  const { data, error } = await supabase.rpc('verify_equipment_passport', { p_code: normalizePassportCode(code) });
  if (error) throw error;
  return data as PassportData;
}

/** Signed in. Full history when this account has a verified link, otherwise the public view. */
export async function fetchPassport(code: string): Promise<PassportData> {
  const { data, error } = await supabase.rpc('get_equipment_passport', { p_code: normalizePassportCode(code) });
  if (error) throw error;
  return data as PassportData;
}

export async function listPassports(): Promise<PassportListItem[]> {
  const { data, error } = await supabase.rpc('list_equipment_passports');
  if (error) throw error;
  return (data as PassportListItem[]) ?? [];
}

export async function issuePassportForEquipment(equipmentId: string): Promise<string> {
  const { data, error } = await supabase.rpc('issue_equipment_passport', { p_equipment_id: equipmentId });
  if (error) throw error;
  return data as string;
}

export async function claimPassport(code: string, equipmentId: string): Promise<PassportData> {
  const { data, error } = await supabase.rpc('claim_equipment_passport', {
    p_code: normalizePassportCode(code),
    p_equipment_id: equipmentId,
  });
  if (error) throw error;
  return data as PassportData;
}

export async function adoptPassport(code: string, customerId: string): Promise<string> {
  const { data, error } = await supabase.rpc('adopt_equipment_passport', {
    p_code: normalizePassportCode(code),
    p_customer_id: customerId,
  });
  if (error) throw error;
  return data as string;
}

export interface AddPassportEventInput {
  code: string;
  type: ManualEventType;
  title: string;
  detail?: string;
  occurredAt?: string;
  isPublic?: boolean;
}

export async function addPassportEvent(input: AddPassportEventInput): Promise<string> {
  const { data, error } = await supabase.rpc('add_equipment_passport_event', {
    p_code: normalizePassportCode(input.code),
    p_type: input.type,
    p_title: input.title.trim(),
    p_detail: input.detail?.trim() || null,
    p_occurred_at: input.occurredAt ? new Date(input.occurredAt).toISOString() : null,
    p_public: input.isPublic ?? false,
  });
  if (error) throw error;
  return data as string;
}

export async function setPassportSharing(code: string, showContractor: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_equipment_passport_sharing', {
    p_code: normalizePassportCode(code),
    p_show_contractor: showContractor,
  });
  if (error) throw error;
}

/** Looks up the passport code for one equipment row (null if none / not yet verified). */
export async function passportCodeForEquipment(equipmentId: string): Promise<string | null> {
  const { data } = await supabase
    .from('equipment_passport_links')
    .select('verified, passport:passport_id (public_code)')
    .eq('equipment_id', equipmentId)
    .eq('status', 'active')
    .maybeSingle();
  const row = data as unknown as { verified: boolean; passport: { public_code: string } | { public_code: string }[] | null } | null;
  if (!row?.verified || !row.passport) return null;
  return Array.isArray(row.passport) ? (row.passport[0]?.public_code ?? null) : row.passport.public_code;
}
