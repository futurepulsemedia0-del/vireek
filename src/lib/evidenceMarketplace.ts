/**
 * Vireek Evidence Marketplace.
 *
 * Validated, anonymized industry intelligence for the ecosystem (OEMs, parts
 * suppliers, insurers, contractors, training providers): "this failure pattern
 * was observed in 14,000 jobs", never a person, a customer or a business.
 *
 * Every privacy guarantee is enforced SERVER-SIDE (see the migration). This
 * file only shows what the server released and talks to the RPCs:
 *  - opt-in only, owner only, versioned consent, append-only audit log
 *  - patterns need >= 5 businesses, >= 30 observations, no business > 40%
 *  - counts rounded down, rates carry calibrated noise (disclosure control,
 *    not a formal differential-privacy proof)
 *  - releases are immutable and content-hashed
 *  - only contributing businesses can read the network intelligence
 *
 * Server counterpart: supabase/migrations/20270215000000_evidence_marketplace.sql
 * Partner API:        supabase/functions/evidence-marketplace-api
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type Grade = 'A' | 'B' | 'C';
export type PartnerType = 'oem' | 'parts_supplier' | 'insurer' | 'contractor' | 'training_provider';
export type PartnerStatus = 'pending' | 'active' | 'suspended';
export type PatternScope = 'cause' | 'equipment';

export interface PatternRow {
  id: string;
  release_id: string;
  scope: PatternScope;
  industry: string;
  job_type_key: string;
  root_cause_key: string;
  make: string;
  age_band: string;
  observations_display: number;
  contributors_display: number;
  ftf_rate: number;
  callback_rate: number;
  median_minutes: number | null;
  top_parts: Array<{ part: string; share: number }>;
  evidence_backed_pct: number;
  grade: Grade;
}

export interface ReleaseRow {
  id: string;
  period_start: string;
  period_end: string;
  pattern_count: number;
  content_hash: string;
  created_at: string;
}

export interface ProductRow {
  slug: string;
  name: string;
  description: string;
  partner_types: PartnerType[];
  scope: 'cause' | 'equipment' | 'all';
  fields: string[];
  sort_order: number;
}

export interface ConsentRow {
  enabled: boolean;
  share_part_usage: boolean;
  share_equipment_signals: boolean;
  consent_version: number;
  consented_at: string | null;
  revoked_at: string | null;
}

export interface Contribution {
  enabled: boolean;
  eligible_outcomes: number;
  patterns_contributed_to: number;
  partner_requests_30d: number;
  window_days: number;
  consent_version: number;
}

export interface EcosystemRow {
  partner_type: PartnerType;
  active_partners: number;
  requests_30d: number;
}

export interface PartnerRow {
  id: string;
  name: string;
  partner_type: PartnerType;
  status: PartnerStatus;
  contact_email: string | null;
  contract_ref: string | null;
  contract_expires_at: string | null;
  allowed_products: string[];
  rate_limit_per_minute: number;
  created_at: string;
}

export interface PartnerKeyRow {
  id: string;
  partner_id: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface AccessLogRow {
  partner_id: string;
  product: string;
  rows_returned: number;
  created_at: string;
}

// ============================================================
// CONSTANTS & PURE HELPERS
// ============================================================

export const PARTNER_TYPE_LABELS: Record<PartnerType, string> = {
  oem: 'OEM / manufacturer',
  parts_supplier: 'Parts supplier',
  insurer: 'Insurer',
  contractor: 'Contractor',
  training_provider: 'Training provider',
};

export const PARTNER_TYPES = Object.keys(PARTNER_TYPE_LABELS) as PartnerType[];

export const GRADE_META: Record<Grade, { label: string; className: string; description: string }> = {
  A: { label: 'Grade A', className: 'bg-success-500/10 text-success-500', description: '25+ businesses, 500+ jobs, at least half backed by photo/measurement/test evidence' },
  B: { label: 'Grade B', className: 'bg-accent/10 text-accent', description: '10+ businesses and 100+ jobs' },
  C: { label: 'Grade C', className: 'bg-bg-tertiary text-text-secondary', description: 'Meets the privacy floor (5+ businesses, 30+ jobs); treat as directional' },
};

/** What a business shares and, just as important, what never leaves. */
export const SHARED_FIELDS = [
  'Trade (e.g. HVAC) and job type',
  'Root cause key recorded by your technician',
  'Whether the job was fixed on the first visit, and how long it took (rounded)',
  'Optional: equipment make and age band (never serial numbers)',
  'Optional: part names from a strict vocabulary',
] as const;

export const NEVER_SHARED = [
  'Customer names, phone numbers, emails or addresses',
  'Your business name, team, technicians or prices',
  'Job notes, photos, videos or any free text',
  'Job, customer or technician identifiers',
] as const;

export const SAFEGUARDS = [
  { title: 'Opt-in only', body: 'Nothing leaves your account until the owner opts in. You can opt out at any time.' },
  { title: '5+ businesses per pattern', body: 'A pattern is released only when at least 5 different businesses and 30 jobs contributed.' },
  { title: 'No dominant contributor', body: 'If one business would supply more than 40% of a pattern, it is not released.' },
  { title: 'Rounded and noised', body: 'Counts are rounded down, rates carry calibrated noise. This is disclosure control, not a formal differential-privacy proof.' },
  { title: 'Validated', body: 'Rework is excluded and every pattern shows how much of it is backed by photo, measurement or test evidence.' },
  { title: 'Auditable', body: 'Releases are immutable and content-hashed, so what any partner received can always be reproduced.' },
] as const;

export function humanizeKey(key: string): string {
  if (!key || key === '*') return 'Any';
  const s = key.replace(/[_\-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function formatPct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Counts are rounded DOWN server-side, so the honest wording is "N+". */
export function observedHeadline(p: Pick<PatternRow, 'observations_display' | 'contributors_display'>): string {
  return `Observed in ${formatCount(p.observations_display)}+ jobs across ${formatCount(p.contributors_display)}+ businesses`;
}

export function patternTitle(p: Pick<PatternRow, 'job_type_key' | 'root_cause_key' | 'make' | 'age_band'>): string {
  const base = `${humanizeKey(p.job_type_key)}: ${humanizeKey(p.root_cause_key)}`;
  if (p.make !== '*' && p.age_band !== '*') return `${base} (${humanizeKey(p.make)}, ${p.age_band} yrs)`;
  return base;
}

export interface PatternFilter {
  query: string;
  grade: Grade | 'all';
  scope: PatternScope;
}

export function filterPatterns(rows: PatternRow[], f: PatternFilter): PatternRow[] {
  const q = f.query.trim().toLowerCase();
  return rows
    .filter((r) => r.scope === f.scope)
    .filter((r) => f.grade === 'all' || r.grade === f.grade)
    .filter((r) => !q || `${r.industry} ${r.job_type_key} ${r.root_cause_key} ${r.make}`.replace(/[_\-]/g, ' ').toLowerCase().includes(q))
    .sort((a, b) => b.observations_display - a.observations_display || a.root_cause_key.localeCompare(b.root_cause_key));
}

/** Browser-side key generation: the raw key is shown once and only its hash is stored. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function generatePartnerKey(): Promise<{ rawKey: string; prefix: string; hash: string }> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  const rawKey = `vev_live_${body}`;
  return { rawKey, prefix: rawKey.slice(0, 13), hash: await sha256Hex(rawKey) };
}

export function productsFor(partnerType: PartnerType, products: ProductRow[]): ProductRow[] {
  return products.filter((p) => p.partner_types.includes(partnerType));
}

export interface PartnerUsage {
  requests: number;
  rows: number;
  lastAt: string | null;
}

export function summarizeUsage(log: AccessLogRow[]): Map<string, PartnerUsage> {
  const out = new Map<string, PartnerUsage>();
  for (const l of log) {
    const cur = out.get(l.partner_id) ?? { requests: 0, rows: 0, lastAt: null };
    cur.requests += 1;
    cur.rows += l.rows_returned;
    if (!cur.lastAt || l.created_at > cur.lastAt) cur.lastAt = l.created_at;
    out.set(l.partner_id, cur);
  }
  return out;
}

// ============================================================
// DATA LAYER (everything below does I/O)
// ============================================================

function fail(error: unknown): never {
  throw error instanceof Error ? error : new Error(typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : 'Request failed');
}

export async function fetchConsent(): Promise<ConsentRow | null> {
  const { data, error } = await supabase
    .from('evidence_sharing_consent')
    .select('enabled, share_part_usage, share_equipment_signals, consent_version, consented_at, revoked_at')
    .maybeSingle();
  if (error) fail(error);
  return (data as ConsentRow | null) ?? null;
}

export async function setEvidenceSharing(p: { enabled: boolean; sharePartUsage: boolean; shareEquipmentSignals: boolean; consentVersion: number }): Promise<void> {
  const { error } = await supabase.rpc('set_evidence_sharing', {
    p_enabled: p.enabled,
    p_share_part_usage: p.sharePartUsage,
    p_share_equipment_signals: p.shareEquipmentSignals,
    p_consent_version: p.consentVersion,
  });
  if (error) fail(error);
}

export async function fetchContribution(): Promise<Contribution> {
  const { data, error } = await supabase.rpc('get_evidence_contribution');
  if (error) fail(error);
  return data as Contribution;
}

export async function fetchEcosystem(): Promise<EcosystemRow[]> {
  const { data, error } = await supabase.rpc('get_evidence_ecosystem_summary');
  if (error) return [];
  return (data ?? []) as EcosystemRow[];
}

export async function fetchProducts(): Promise<ProductRow[]> {
  const { data, error } = await supabase.from('evidence_products').select('slug, name, description, partner_types, scope, fields, sort_order').order('sort_order');
  if (error) return [];
  return (data ?? []) as ProductRow[];
}

/** RLS returns rows only for businesses that opted in, and only the latest release. */
export async function fetchPatterns(): Promise<{ patterns: PatternRow[]; release: ReleaseRow | null }> {
  const [pats, rel] = await Promise.all([
    supabase.from('evidence_patterns').select('*').order('observations_display', { ascending: false }).limit(600),
    supabase.from('evidence_releases').select('id, period_start, period_end, pattern_count, content_hash, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (pats.error) fail(pats.error);
  return {
    patterns: ((pats.data ?? []) as PatternRow[]).map((p) => ({ ...p, ftf_rate: Number(p.ftf_rate), callback_rate: Number(p.callback_rate) })),
    release: (rel.data as ReleaseRow | null) ?? null,
  };
}

// ---- staff ----

export async function listPartners(): Promise<PartnerRow[]> {
  const { data, error } = await supabase.from('evidence_partners').select('*').order('created_at', { ascending: false });
  if (error) fail(error);
  return (data ?? []) as PartnerRow[];
}

export async function listPartnerKeys(): Promise<PartnerKeyRow[]> {
  const { data, error } = await supabase.from('evidence_partner_keys').select('id, partner_id, key_prefix, created_at, revoked_at, last_used_at').order('created_at', { ascending: false });
  if (error) fail(error);
  return (data ?? []) as PartnerKeyRow[];
}

export async function listAccessLog(days = 30): Promise<AccessLogRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase.from('evidence_access_log').select('partner_id, product, rows_returned, created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(5000);
  if (error) fail(error);
  return (data ?? []) as AccessLogRow[];
}

export async function savePartner(p: {
  id: string | null;
  name: string;
  partnerType: PartnerType;
  status: PartnerStatus;
  contactEmail: string;
  contractRef: string;
  contractExpiresAt: string | null;
  allowedProducts: string[];
  rateLimit: number;
}): Promise<string> {
  const { data, error } = await supabase.rpc('staff_save_evidence_partner', {
    p_id: p.id,
    p_name: p.name,
    p_partner_type: p.partnerType,
    p_status: p.status,
    p_contact_email: p.contactEmail,
    p_contract_ref: p.contractRef,
    p_contract_expires_at: p.contractExpiresAt,
    p_allowed_products: p.allowedProducts,
    p_rate_limit: p.rateLimit,
  });
  if (error) fail(error);
  return data as string;
}

export async function issuePartnerKey(partnerId: string): Promise<string> {
  const { rawKey, prefix, hash } = await generatePartnerKey();
  const { error } = await supabase.rpc('staff_issue_evidence_partner_key', { p_partner_id: partnerId, p_key_hash: hash, p_key_prefix: prefix });
  if (error) fail(error);
  return rawKey;
}

export async function revokePartnerKey(keyId: string): Promise<void> {
  const { error } = await supabase.rpc('staff_revoke_evidence_partner_key', { p_key_id: keyId });
  if (error) fail(error);
}

export async function runEvidenceRelease(): Promise<string | null> {
  const { data, error } = await supabase.rpc('staff_run_evidence_release');
  if (error) fail(error);
  return (data as string | null) ?? null;
}
