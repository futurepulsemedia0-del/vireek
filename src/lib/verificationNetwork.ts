/**
 * VIREEK Verification Network - client domain logic.
 *
 * Backend pieces:
 *   supabase/migrations/20270401000000_verification_network.sql
 *   supabase/functions/verification-network            (request / resolve / sweep)
 *   supabase/functions/_shared/verification-network    (pure engine + Socrata adapter)
 *
 * Nothing here can mark anyone "verified": results are written only by the edge function
 * (service role). The browser reads through RLS and asks the function to run or resolve checks.
 */

import { supabase } from '@/lib/supabase';

export type VerificationKind = 'license' | 'insurance' | 'background';
export type CheckStatus =
  'pending' | 'verified_primary' | 'verified_document' | 'needs_review' | 'adverse' | 'error';
export type VerificationTier = 'verified' | 'partially_verified' | 'unverified' | 'attention';

export interface KindSummary {
  subjects: number;
  verified: number;
  adverse: number;
  needs_review: number;
  unchecked: number;
}

export interface VerificationBlocker {
  code: string;
  kind: VerificationKind;
  count: number;
}

export interface VerificationProfile {
  technician_id: string;
  technician_name: string | null;
  verification_score: number;
  tier: VerificationTier;
  blockers: VerificationBlocker[];
  kinds: Partial<Record<VerificationKind, KindSummary>>;
  pending_count: number;
  last_verified_at: string | null;
  generated_at: string;
}

export interface VerificationCheck {
  id: string;
  technician_id: string;
  kind: VerificationKind;
  subject_key: string;
  credential_id: string | null;
  insurance_policy_id: string | null;
  jurisdiction: string | null;
  status: CheckStatus;
  reason: string | null;
  method: string | null;
  license_status: string | null;
  holder_name: string | null;
  name_match_score: number | null;
  classification: string | null;
  expires_on: string | null;
  disciplinary_flag: boolean | null;
  coverage_cents: number | null;
  carrier: string | null;
  evidence_sha256: string | null;
  checked_at: string | null;
  next_check_at: string | null;
  created_at: string;
}

export interface CredentialSubject {
  id: string;
  credential_type: string;
  credential_name: string | null;
  issuing_authority: string | null;
  expires_at: string | null;
  status: string;
}

export interface PolicySubject {
  id: string;
  policy_type: string;
  carrier: string;
  coverage_amount_cents: number | null;
  expires_at: string;
  status: string;
}

export interface VerificationSource {
  id: string;
  source_key: string;
  label: string;
  jurisdiction: string;
  kind: VerificationKind;
  active: boolean;
}

// ---------------------------------------------------------------- presentation

export const STATUS_META: Record<CheckStatus, { label: string; className: string }> = {
  verified_primary: {
    label: 'Verified at source',
    className: 'bg-success-500/15 text-success-500',
  },
  verified_document: {
    label: 'Verified by document',
    className: 'bg-success-500/10 text-success-500',
  },
  needs_review: { label: 'Needs review', className: 'bg-warning-500/10 text-warning-500' },
  adverse: { label: 'Adverse finding', className: 'bg-danger/10 text-danger' },
  error: { label: 'Retrying', className: 'bg-bg-tertiary text-text-secondary' },
  pending: { label: 'Checking…', className: 'bg-accent/10 text-accent' },
};

export const TIER_LABELS: Record<VerificationTier, { label: string; className: string }> = {
  verified: { label: 'Verified', className: 'bg-success-500/15 text-success-500' },
  partially_verified: {
    label: 'Partially verified',
    className: 'bg-warning-500/10 text-warning-500',
  },
  unverified: { label: 'Unverified', className: 'bg-bg-tertiary text-text-secondary' },
  attention: { label: 'Needs attention', className: 'bg-danger/10 text-danger' },
};

export const KIND_LABELS: Record<VerificationKind, string> = {
  license: 'Licence',
  insurance: 'Insurance',
  background: 'Background',
};

const REASON_TEXT: Record<string, string> = {
  matched_active: 'Active record found at the licensing board; the holder name matches.',
  record_not_found:
    'No record with this number was found at the source. Check the number and state.',
  name_mismatch: 'A record exists but the holder name does not match this technician or company.',
  name_unavailable: 'The source record has no holder name, so identity could not be confirmed.',
  status_unrecognised: 'The source reports a status Vireek does not recognise. Review manually.',
  license_expired: 'The licence has expired.',
  license_suspended: 'The licence is suspended.',
  license_revoked: 'The licence is revoked.',
  license_inactive: 'The licence is inactive.',
  jurisdiction_unknown: 'Could not tell which state issued this licence. Set the state and re-run.',
  no_source_for_jurisdiction:
    'No live licensing-board connection exists for this state yet. Record a manual result.',
  source_misconfigured: 'The connection for this state is misconfigured. Contact support.',
  missing_license_number: 'This credential has no licence number.',
  credential_missing: 'The credential was removed.',
  policy_ok: 'Policy is active, in date, meets the minimum cover and its certificate was reviewed.',
  policy_expired: 'The policy has expired.',
  policy_cancelled: 'The policy is cancelled.',
  policy_missing: 'The policy was removed.',
  policy_not_yet_effective: 'The policy is not in force yet.',
  expiry_invalid: 'The policy expiry date is invalid.',
  coverage_below_minimum: 'Coverage is below the required minimum.',
  coverage_unknown: 'Coverage amount is missing.',
  coi_not_reviewed: 'The certificate of insurance has not been reviewed by a manager yet.',
  consent_missing: 'The technician has not given background-check consent.',
  awaiting_provider: 'Consent recorded. Add the result from your background-check vendor.',
  manual_verified: 'Verified manually from supporting evidence.',
  manual_adverse: 'Recorded as an adverse finding from supporting evidence.',
  manual_expired: 'The recorded evidence shows it has expired.',
  provider_error: 'The source was unreachable. Vireek will retry automatically.',
  provider_unavailable: 'The source stayed unreachable. Record a manual result or try again later.',
  expired_since_check: 'It was verified, but has since expired.',
};

export function reasonText(code: string | null | undefined): string {
  if (!code) return '';
  return REASON_TEXT[code] ?? code.replace(/_/g, ' ');
}

export function blockerText(b: VerificationBlocker): string {
  const kind = KIND_LABELS[b.kind].toLowerCase();
  switch (b.code) {
    case 'no_license_on_file':
      return 'No licence on file';
    case 'no_insurance_on_file':
      return 'No insurance on file';
    case 'disciplinary_action':
      return 'Disciplinary action on record';
    default:
      if (b.code.startsWith('adverse_')) return `Adverse ${kind} finding`;
      if (b.code.startsWith('unverified_')) return `${b.count} ${kind} not verified yet`;
      return b.code.replace(/_/g, ' ');
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Overall Vireek Trust Score: 80% operational track record (Passport Index) +
 * 20% external verification. With no track record yet, verification alone is not enough
 * to claim a score, so it stays null.
 */
export function combinedTrustScore(
  passportIndex: number | null,
  verificationScore: number | null,
): number | null {
  if (passportIndex === null || verificationScore === null) return null;
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  return Math.round(0.8 * clamp(passportIndex) + 0.2 * clamp(verificationScore));
}

/** Latest meaningful check for a credential/policy, with a pending re-check taking display priority. */
export function pickCheck(
  checks: VerificationCheck[],
  match: { credentialId?: string; policyId?: string; kind?: VerificationKind },
): VerificationCheck | null {
  const rows = checks.filter((c) =>
    match.credentialId
      ? c.credential_id === match.credentialId
      : match.policyId
        ? c.insurance_policy_id === match.policyId
        : c.kind === match.kind,
  );
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}

// ---------------------------------------------------------------- data access

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('verification-network', { body });
  if (error) {
    throw new Error(
      await functionErrorMessage(
        error,
        'Could not reach the verification network. Check your connection and try again.',
      ),
    );
  }
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}

export async function fetchVerificationProfiles(
  technicianId: string | null = null,
): Promise<VerificationProfile[]> {
  const { data, error } = await supabase.rpc('get_technician_verification_profile', {
    p_technician_id: technicianId,
  });
  if (error) throw error;
  return (data as VerificationProfile[]) ?? [];
}

export async function fetchTechnicianChecks(technicianId: string): Promise<VerificationCheck[]> {
  const { data, error } = await supabase
    .from('verification_checks')
    .select(
      'id, technician_id, kind, subject_key, credential_id, insurance_policy_id, jurisdiction, status, reason, method, license_status, holder_name, name_match_score, classification, expires_on, disciplinary_flag, coverage_cents, carrier, evidence_sha256, checked_at, next_check_at, created_at',
    )
    .eq('technician_id', technicianId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as VerificationCheck[]) ?? [];
}

export async function fetchTechnicianSubjects(technicianId: string): Promise<{
  credentials: CredentialSubject[];
  policies: PolicySubject[];
}> {
  const [cred, pol] = await Promise.all([
    supabase
      .from('technician_credentials')
      .select('id, credential_type, credential_name, issuing_authority, expires_at, status')
      .eq('technician_id', technicianId)
      .neq('status', 'revoked')
      .order('credential_type'),
    supabase
      .from('technician_insurance_policies')
      .select('id, policy_type, carrier, coverage_amount_cents, expires_at, status')
      .eq('technician_id', technicianId)
      .eq('status', 'active')
      .order('expires_at', { ascending: false }),
  ]);
  if (cred.error) throw cred.error;
  if (pol.error) throw pol.error;
  return {
    credentials: (cred.data as CredentialSubject[]) ?? [],
    policies: (pol.data as PolicySubject[]) ?? [],
  };
}

export async function fetchVerificationSources(): Promise<VerificationSource[]> {
  const { data, error } = await supabase
    .from('verification_sources')
    .select('id, source_key, label, jurisdiction, kind, active')
    .eq('active', true)
    .order('jurisdiction');
  if (error) throw error;
  return (data as VerificationSource[]) ?? [];
}

export async function hasBackgroundConsent(technicianId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('background_consents')
    .select('id')
    .eq('technician_id', technicianId)
    .is('revoked_at', null)
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function recordBackgroundConsent(): Promise<void> {
  const { error } = await supabase.rpc('record_background_consent', { p_version: 'v1' });
  if (error) throw error;
}

export interface RequestInput {
  technicianId: string;
  kind: VerificationKind;
  credentialId?: string;
  policyId?: string;
  jurisdiction?: string;
}

export function requestVerification(
  input: RequestInput,
): Promise<{ check: { status: CheckStatus; reason: string | null } | null; processing: boolean }> {
  return invoke({ action: 'request', ...input });
}

export interface ResolveInput {
  checkId: string;
  outcome: 'verified' | 'adverse';
  note: string;
  reference?: string;
  licenseStatus?: string;
  expiresOn?: string;
}

export function resolveVerification(
  input: ResolveInput,
): Promise<{ checkId: string; status: CheckStatus; reason: string }> {
  return invoke({ action: 'resolve', ...input });
}

export const US_JURISDICTIONS: string[] =
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'
    .split(' ')
    .map((c) => `US-${c}`);
