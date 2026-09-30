/**
 * Technician Passport 2.0 (Technician Identity Graph) — client library.
 *
 * Every metric comes from public.get_technician_identity_passport(), which derives
 * them from real job outcomes. Only insurance is manager-entered, and it counts
 * toward the Passport Index only once a manager verifies it.
 * Portable passports are sealed server-side (SHA-256) and cannot be edited.
 */

import { supabase } from '@/lib/supabase';

export type PassportTier = 'elite' | 'trusted' | 'established' | 'emerging' | 'unrated';

export type InsuranceType =
  | 'general_liability'
  | 'workers_comp'
  | 'commercial_auto'
  | 'professional_liability'
  | 'umbrella'
  | 'other';

export const INSURANCE_LABELS: Record<InsuranceType, string> = {
  general_liability: 'General liability',
  workers_comp: "Workers' compensation",
  commercial_auto: 'Commercial auto',
  professional_liability: 'Professional liability',
  umbrella: 'Umbrella',
  other: 'Other',
};

export const INSURANCE_TYPES = Object.keys(INSURANCE_LABELS) as InsuranceType[];

export const TIER_META: Record<PassportTier, { label: string; ringClass: string; badgeClass: string }> = {
  elite: { label: 'Elite', ringClass: 'text-success-500', badgeClass: 'bg-success-500/10 text-success-500' },
  trusted: { label: 'Trusted', ringClass: 'text-accent', badgeClass: 'bg-accent/10 text-accent' },
  established: { label: 'Established', ringClass: 'text-warning-500', badgeClass: 'bg-warning-500/10 text-warning-500' },
  emerging: { label: 'Emerging', ringClass: 'text-text-secondary', badgeClass: 'bg-bg-tertiary text-text-secondary' },
  unrated: { label: 'Not enough history', ringClass: 'text-text-secondary', badgeClass: 'bg-bg-tertiary text-text-secondary' },
};

export interface SkillConfidence {
  skill_key: string;
  job_count: number;
  effective_jobs: number;
  fix_rate: number | null;
  avg_rating: number | null;
  confidence: number;
  last_job_at: string | null;
}

export interface PassportMetrics {
  jobs_completed: number;
  verified_jobs: number;
  lifetime_jobs: number;
  lifetime_verified_jobs: number;
  first_time_fix_rate: number | null;
  callback_rate: number | null;
  rated_jobs: number;
  customer_rating_avg: number | null;
  safety_required_jobs: number;
  safety_compliance_rate: number | null;
  diagnosed_jobs: number;
  diagnosis_accuracy: number | null;
  timed_jobs: number;
  response_reliability: number | null;
}

export interface PassportCertification {
  type: string;
  name: string | null;
  issuer: string | null;
  issued_at: string | null;
  expires_at: string | null;
  valid?: boolean;
}

export interface PassportInsurance {
  id?: string;
  type: InsuranceType;
  carrier: string;
  coverage_amount_cents: number | null;
  expires_at: string;
  verified?: boolean;
  valid?: boolean;
}

export interface PassportTraining {
  lessons_completed: number;
  apprenticeship_target_level: number | null;
  simulator_attempts: number;
  simulator_passed: number;
  simulator_avg_score: number | null;
}

export interface IdentityPayload {
  schema: string;
  window_days: number;
  generated_at: string;
  company_name: string | null;
  index: number | null;
  index_coverage: number;
  tier: PassportTier;
  metrics: PassportMetrics;
  skills: SkillConfidence[];
  equipment_expertise: SkillConfidence[];
  certifications: PassportCertification[];
  insurance: PassportInsurance[];
  training: PassportTraining;
  languages: string[];
  declared_skills: string[];
  regions: string[];
  internal: { unresolved_complaints: number };
}

export interface TechnicianIdentityPassport {
  technician_id: string;
  technician_name: string;
  payload: IdentityPayload;
  generated_at: string;
}

export interface PassportShare {
  id: string;
  technician_id: string;
  label: string | null;
  snapshot_hash: string;
  issued_by_role: 'technician' | 'manager';
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
}

export interface IssuedShare {
  share_id: string;
  token: string;
  expires_at: string;
  snapshot_hash: string;
}

export interface PublicPassportSnapshot {
  schema: string;
  display_name: string;
  issuer_company: string | null;
  issued_at: string;
  window_days: number;
  index: number | null;
  index_coverage: number;
  tier: PassportTier;
  metrics: PassportMetrics;
  skills: SkillConfidence[];
  equipment_expertise: SkillConfidence[];
  certifications: PassportCertification[];
  insurance: PassportInsurance[];
  training: PassportTraining;
  languages: string[];
  regions: string[];
}

export interface PublicPassportResult {
  status: 'valid' | 'expired' | 'revoked' | 'tampered' | 'not_found';
  issued_at?: string;
  expires_at?: string;
  issued_by_role?: 'technician' | 'manager';
  snapshot_hash?: string;
  snapshot?: PublicPassportSnapshot | null;
}

export interface InsurancePolicyRow {
  id: string;
  technician_id: string;
  policy_type: InsuranceType;
  carrier: string;
  policy_number: string | null;
  coverage_amount_cents: number | null;
  effective_date: string | null;
  expires_at: string;
  status: 'active' | 'cancelled';
  verified_at: string | null;
}

// ============================================================
// DATA ACCESS
// ============================================================

export async function fetchIdentityPassports(windowDays = 365): Promise<TechnicianIdentityPassport[]> {
  const { data, error } = await supabase.rpc('get_technician_identity_passport', {
    p_technician_id: null,
    p_window_days: windowDays,
  });
  if (error) throw error;
  return ((data as TechnicianIdentityPassport[] | null) ?? []).filter((r) => r.payload);
}

export async function issuePassportShare(args: {
  technicianId: string;
  label?: string;
  validDays?: number;
  windowDays?: number;
}): Promise<IssuedShare> {
  const { data, error } = await supabase.rpc('issue_technician_passport_share', {
    p_technician_id: args.technicianId,
    p_label: args.label?.trim() || null,
    p_valid_days: args.validDays ?? 30,
    p_window_days: args.windowDays ?? 365,
  });
  if (error) throw error;
  return data as IssuedShare;
}

export async function revokePassportShare(shareId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_technician_passport_share', { p_share_id: shareId });
  if (error) throw error;
}

export async function listPassportShares(technicianId: string): Promise<PassportShare[]> {
  const { data, error } = await supabase
    .from('technician_passport_shares')
    .select('id, technician_id, label, snapshot_hash, issued_by_role, issued_at, expires_at, revoked_at, view_count, last_viewed_at')
    .eq('technician_id', technicianId)
    .order('issued_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data as PassportShare[]) ?? [];
}

export async function fetchPublicPassport(token: string): Promise<PublicPassportResult> {
  const { data, error } = await supabase.rpc('verify_technician_passport', { p_token: token });
  if (error) throw error;
  return data as PublicPassportResult;
}

export async function listInsurancePolicies(technicianId: string): Promise<InsurancePolicyRow[]> {
  const { data, error } = await supabase
    .from('technician_insurance_policies')
    .select('id, technician_id, policy_type, carrier, policy_number, coverage_amount_cents, effective_date, expires_at, status, verified_at')
    .eq('technician_id', technicianId)
    .eq('status', 'active')
    .order('expires_at', { ascending: false });
  if (error) throw error;
  return (data as InsurancePolicyRow[]) ?? [];
}

export async function addInsurancePolicy(input: {
  technicianId: string;
  policyType: InsuranceType;
  carrier: string;
  policyNumber: string | null;
  coverageCents: number | null;
  expiresAt: string;
  verified: boolean;
}): Promise<void> {
  const { error } = await supabase.from('technician_insurance_policies').insert({
    technician_id: input.technicianId,
    policy_type: input.policyType,
    carrier: input.carrier.trim(),
    policy_number: input.policyNumber?.trim() || null,
    coverage_amount_cents: input.coverageCents,
    expires_at: input.expiresAt,
    verified_at: input.verified ? new Date().toISOString() : null,
  });
  if (error) throw error;
}

export async function setInsuranceVerified(id: string, verified: boolean): Promise<void> {
  const { error } = await supabase
    .from('technician_insurance_policies')
    .update({ verified_at: verified ? new Date().toISOString() : null })
    .eq('id', id);
  if (error) throw error;
}

export async function removeInsurancePolicy(id: string): Promise<void> {
  const { error } = await supabase.from('technician_insurance_policies').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// HELPERS
// ============================================================

export function passportUrl(token: string): string {
  return `${window.location.origin}/verify/technician/${token}`;
}

export function skillLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (w === w.toUpperCase() && w.length <= 4 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function confidenceLevel(confidence: number, jobs: number): { label: string; barClass: string } {
  if (jobs < 5) return { label: 'Provisional', barClass: 'bg-accent/40' };
  if (confidence >= 90) return { label: 'Expert', barClass: 'bg-success-500' };
  if (confidence >= 75) return { label: 'Proficient', barClass: 'bg-accent' };
  if (confidence >= 50) return { label: 'Developing', barClass: 'bg-warning-500' };
  return { label: 'Novice', barClass: 'bg-danger' };
}

export function formatCoverage(cents: number | null): string {
  if (cents === null) return 'Coverage not stated';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function shareState(s: Pick<PassportShare, 'revoked_at' | 'expires_at'>): 'active' | 'expired' | 'revoked' {
  if (s.revoked_at) return 'revoked';
  return new Date(s.expires_at).getTime() <= Date.now() ? 'expired' : 'active';
}
