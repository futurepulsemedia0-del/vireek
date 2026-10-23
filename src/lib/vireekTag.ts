/**
 * Vireek Tag — client API + pure helpers.
 * A tag is a physical QR/NFC sticker bound to an Equipment Passport. Its token is NOT the passport code,
 * so a sticker can be rotated or revoked without touching the machine's identity or history.
 */

import { supabase } from '@/lib/supabase';
import type { PassportData } from '@/lib/equipmentPassport';

export type TagStatus = 'unassigned' | 'active' | 'rotated' | 'revoked';
export type RotationReason = 'lost' | 'damaged' | 'suspected_tamper' | 'scheduled';
export type TagSource = 'qr' | 'nfc' | 'link';
export type TagDevice = 'mobile' | 'tablet' | 'desktop' | 'unknown';
export type TagAction = 'manual_click' | 'register_click' | 'request_click' | 'tamper_report';
export type Urgency = 'routine' | 'soon' | 'urgent';

export interface TagBusiness { name: string; booking_slug: string | null }
export interface TagDocument { doc_type: string; title: string; url: string; language: string }

export type TagResolve =
  | { found: false; state: 'unknown' }
  | { found: true; state: 'unassigned' | 'rotated' | 'revoked'; business: TagBusiness; can_assign: boolean }
  | {
      found: true;
      state: 'active';
      viewer: 'public' | 'member';
      tag: { id: string | null; assigned_at: string | null };
      business: TagBusiness;
      passport: PassportData;
      documents: TagDocument[];
      warranty_registered: boolean;
      equipment_id: string | null;
    };

export interface TagRow {
  id: string;
  token: string;
  status: TagStatus;
  batch_id: string | null;
  batch_label: string | null;
  created_at: string;
  assigned_at: string | null;
  retired_at: string | null;
  rotated_from_id: string | null;
  rotation_reason: RotationReason | null;
  passport_code: string | null;
  equipment_type: string | null;
  make: string | null;
  model: string | null;
  scan_count: number;
  last_scan_at: string | null;
  request_count: number;
  report_count: number;
}

export interface TagAnalytics {
  range_days: number;
  totals: {
    scans: number; unique_visitors: number; team_scans: number; stale_scans: number; request_clicks: number;
    requests: number; manual_clicks: number; register_clicks: number; tamper_reports: number;
  };
  by_day: { day: string; scans: number }[];
  by_source: { key: string; count: number }[];
  by_device: { key: string; count: number }[];
  top_tags: { tag_id: string; token: string; label: string | null; scans: number }[];
  inventory: { unassigned: number; active: number; rotated: number; revoked: number; active_never_scanned: number };
}

// ─── Token helpers (mirror vt_normalize_token in SQL) ─────────────────────────────────────────
const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** Accepts "VTG-ABCD-…", a raw 16-char token, or a full scanned URL ending in /t/<token>. */
export function normalizeTagToken(input: string): string {
  let raw = (input ?? '').trim();
  const m = raw.match(/\/t\/([^/?#\s]+)/i);
  if (m) raw = m[1];
  let c = raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  if (c.length === 19 && c.startsWith('VTG')) c = c.slice(3);
  return c;
}

export function isValidTagToken(input: string): boolean {
  return TOKEN_RE.test(normalizeTagToken(input));
}

export function formatTagToken(input: string): string {
  const c = normalizeTagToken(input);
  return TOKEN_RE.test(c) ? `VTG-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}` : input;
}

/** URL encoded in the QR (no query = smallest QR) or written to NFC (?s=nfc so analytics can tell them apart). */
export function tagUrl(token: string, source: TagSource = 'qr', origin: string = typeof window !== 'undefined' ? window.location.origin : 'https://vireek.com'): string {
  const base = `${origin.replace(/\/$/, '')}/t/${normalizeTagToken(token)}`;
  return source === 'qr' ? base : `${base}?s=${source}`;
}

export function tagTitle(t: Pick<TagRow, 'make' | 'model' | 'equipment_type'>): string {
  return [t.make, t.model].filter(Boolean).join(' ') || t.equipment_type || 'Unassigned';
}

// ─── Privacy-safe client signals ──────────────────────────────────────────────────────────────
export function detectDevice(ua: string | null | undefined): TagDevice {
  if (!ua) return 'unknown';
  if (/ipad|tablet|playbook|silk|android(?!.*mobile)/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

export function detectSource(search: string): TagSource {
  const s = new URLSearchParams(search).get('s');
  return s === 'nfc' ? 'nfc' : s === 'link' ? 'link' : 'qr';
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Random per-tab id (never an IP / fingerprint). The server salts + hashes it per tag. */
export function getTagSessionId(): string {
  const KEY = 'vireek_tag_sid';
  try {
    let v = window.sessionStorage.getItem(KEY);
    if (!v) { v = randomId(); window.sessionStorage.setItem(KEY, v); }
    return v;
  } catch {
    return randomId();
  }
}

// ─── Service-request validation (mirrors submit_tag_service_request) ──────────────────────────
export interface ServiceRequestInput {
  token: string; name: string; phone: string; email: string; issue: string; urgency: Urgency; website: string;
}

export function validateServiceRequest(i: Pick<ServiceRequestInput, 'name' | 'phone' | 'email' | 'issue'>): Partial<Record<'name' | 'contact' | 'phone' | 'email' | 'issue', string>> {
  const errors: Partial<Record<'name' | 'contact' | 'phone' | 'email' | 'issue', string>> = {};
  const name = i.name.trim();
  const phone = i.phone.trim();
  const email = i.email.trim();
  if (name.length < 2 || name.length > 120) errors.name = 'Enter your name.';
  if (!phone && !email) errors.contact = 'Add a phone number or an email so the company can reach you.';
  if (phone) {
    const digits = phone.replace(/\D/g, '').length;
    if (digits < 7 || digits > 15) errors.phone = 'Enter a valid phone number.';
  }
  if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) errors.email = 'Enter a valid email address.';
  if (i.issue.length > 1000) errors.issue = 'Keep the description under 1,000 characters.';
  return errors;
}

// ─── Errors ───────────────────────────────────────────────────────────────────────────────────
const ERROR_COPY: Record<string, string> = {
  TAG_UNAUTHORIZED: 'Please sign in to continue.',
  TAG_FORBIDDEN: 'You do not have permission to do that for this tag.',
  TAG_NOT_FOUND: 'That tag was not found in your account.',
  TAG_NOT_ACTIVE: 'This tag is no longer active.',
  TAG_ALREADY_ASSIGNED: 'This tag is already attached to a machine.',
  TAG_PASSPORT_ALREADY_TAGGED: 'This machine already has an active tag. Rotate it instead of adding a second one.',
  TAG_EQUIPMENT_NOT_FOUND: 'That equipment record was not found in your account.',
  TAG_NO_EQUIPMENT: 'Link this machine to an equipment record in your account first.',
  TAG_STOCK_LIMIT: 'You have too many unused tags. Use or revoke some before creating more.',
  TAG_RATE_LIMITED: 'Too many requests from this tag right now. Please call the company directly.',
  TAG_INVALID: 'Some of the details are not valid.',
};

export function tagErrorMessage(err: unknown): string {
  const msg = typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err ?? '');
  const key = Object.keys(ERROR_COPY).find((k) => msg.includes(k));
  return key ? ERROR_COPY[key] : 'Something went wrong. Please try again.';
}

// ─── API ──────────────────────────────────────────────────────────────────────────────────────
export async function resolveTag(token: string, source: TagSource): Promise<TagResolve> {
  const { data, error } = await supabase.rpc('resolve_equipment_tag', {
    p_token: normalizeTagToken(token),
    p_session: getTagSessionId(),
    p_source: source,
    p_device: detectDevice(typeof navigator !== 'undefined' ? navigator.userAgent : ''),
  });
  if (error) throw error;
  return data as TagResolve;
}

/** Fire-and-forget funnel signal. Never throws. */
export async function recordTagAction(token: string, action: TagAction, source: TagSource = 'qr'): Promise<void> {
  try {
    await supabase.rpc('record_tag_action', {
      p_token: normalizeTagToken(token), p_action: action, p_session: getTagSessionId(), p_source: source,
      p_device: detectDevice(typeof navigator !== 'undefined' ? navigator.userAgent : ''),
    });
  } catch { /* analytics only */ }
}

export async function submitTagServiceRequest(i: ServiceRequestInput): Promise<{ reference?: string }> {
  const { data, error } = await supabase.rpc('submit_tag_service_request', {
    p_token: normalizeTagToken(i.token), p_name: i.name.trim(), p_phone: i.phone.trim() || null, p_email: i.email.trim() || null,
    p_issue: i.issue.trim() || null, p_urgency: i.urgency, p_session: getTagSessionId(), p_website: i.website || null,
  });
  if (error) throw error;
  return { reference: (data as { reference?: string } | null)?.reference };
}

export async function generateTags(count: number, batchLabel?: string): Promise<{ id: string; token: string }[]> {
  const { data, error } = await supabase.rpc('generate_equipment_tags', { p_count: count, p_batch_label: batchLabel?.trim() || null });
  if (error) throw error;
  return ((data as { tags?: { id: string; token: string }[] } | null)?.tags) ?? [];
}

export async function listTags(status: TagStatus | null, limit = 50, offset = 0): Promise<{ total: number; tags: TagRow[] }> {
  const { data, error } = await supabase.rpc('list_equipment_tags', { p_status: status, p_limit: limit, p_offset: offset });
  if (error) throw error;
  const d = data as { total?: number; tags?: TagRow[] } | null;
  return { total: d?.total ?? 0, tags: d?.tags ?? [] };
}

export async function assignTag(token: string, equipmentId: string): Promise<{ passport_code: string; equipment_id: string }> {
  const { data, error } = await supabase.rpc('assign_equipment_tag', { p_token: normalizeTagToken(token), p_equipment_id: equipmentId });
  if (error) throw error;
  return data as { passport_code: string; equipment_id: string };
}

export async function rotateTag(tagId: string, reason: RotationReason): Promise<{ id: string; token: string }> {
  const { data, error } = await supabase.rpc('rotate_equipment_tag', { p_tag_id: tagId, p_reason: reason });
  if (error) throw error;
  return data as { id: string; token: string };
}

export async function revokeTag(tagId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_equipment_tag', { p_tag_id: tagId });
  if (error) throw error;
}

export async function createJobFromTag(token: string, serviceType: string): Promise<{ job_id: string; existing: boolean }> {
  const { data, error } = await supabase.rpc('create_job_from_tag', { p_token: normalizeTagToken(token), p_service_type: serviceType, p_assign_to_me: true });
  if (error) throw error;
  return data as { job_id: string; existing: boolean };
}

export async function getTagAnalytics(days: number): Promise<TagAnalytics> {
  const { data, error } = await supabase.rpc('get_tag_analytics', { p_days: days });
  if (error) throw error;
  return data as TagAnalytics;
}
