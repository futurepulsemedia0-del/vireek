// src/lib/reputationCredentials/api.ts - thin client for the reputation RPCs / edge functions. Authorisation is enforced in the database.
import { supabase } from '@/lib/supabase';
import type { CredentialStatus, ReputationScope } from './core';

export interface RepTechnician { id: string; name: string }
export interface RepConsent { technician_id: string | null; subject_type: 'technician' | 'contractor'; scopes: ReputationScope[]; granted_at: string }
export interface RepCredentialRow {
  id: string; subject_type: 'technician' | 'contractor'; technician_id: string | null; subject_name: string; label: string | null;
  scopes: ReputationScope[]; issued_at: string; expires_at: string; revoked_at: string | null; revoked_reason: string | null;
}
export interface RepLicense { id: string; technician_id: string; type: string; name: string | null; issuer: string | null; expires_at: string | null; checked_at: string | null; method: string | null }
export interface RepOverview {
  is_manager: boolean; self_technician_id: string | null; company: string;
  technicians: RepTechnician[]; consents: RepConsent[]; credentials: RepCredentialRow[]; licenses: RepLicense[];
}

/** Local (display only) status. The public verify page is the authority - it checks the signature too. */
export function rowStatus(r: Pick<RepCredentialRow, 'revoked_at' | 'expires_at'>, now = new Date()): Extract<CredentialStatus, 'valid' | 'expired' | 'revoked'> {
  if (r.revoked_at) return 'revoked';
  return new Date(r.expires_at).getTime() <= now.getTime() ? 'expired' : 'valid';
}

export function friendlyReputationError(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === '42501' || e?.code === '54000' || e?.code === 'P0001' || e?.code === '22023' || e?.code === 'P0002') return e.message || 'This action is not allowed.';
  return 'Something went wrong. Please try again.';
}

export async function fetchReputationOverview(): Promise<RepOverview> {
  const { data, error } = await supabase.rpc('reputation_overview');
  if (error) throw error;
  return data as RepOverview;
}
export async function setReputationConsent(technicianId: string | null, scopes: ReputationScope[]): Promise<{ credentials_revoked: number }> {
  const { data, error } = await supabase.rpc('reputation_consent_set', { p_technician_id: technicianId, p_scopes: scopes });
  if (error) throw error;
  return data as { credentials_revoked: number };
}
export async function recordLicenseCheck(credentialId: string, method: 'licensing_authority_lookup' | 'document_review'): Promise<void> {
  const { error } = await supabase.rpc('reputation_record_license_check', { p_credential_id: credentialId, p_method: method });
  if (error) throw error;
}
export async function revokeReputationCredential(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('reputation_revoke_credential', { p_id: id, p_reason: reason || null });
  if (error) throw error;
}
export interface IssuedCredential { id: string; link: string; badge_html: string; expires_at: string }
export async function issueReputationCredential(input: { technicianId: string | null; scopes: ReputationScope[]; validDays: number; label?: string }): Promise<IssuedCredential> {
  const { data, error } = await supabase.functions.invoke('reputation-credential', {
    body: { action: 'issue', technician_id: input.technicianId, scopes: input.scopes, valid_days: input.validDays, label: input.label ?? null },
  });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const b = (await ctx.json().catch(() => null)) as { message?: string } | null;
      if (b?.message) throw Object.assign(new Error(b.message), { code: 'P0001' });
    }
    throw error;
  }
  return data as IssuedCredential;
}

export interface PublicCredential {
  status: CredentialStatus; kid: string | null; alg?: string;
  credential: null | {
    id: string; subject: { type: 'technician' | 'contractor'; name: string; company: string }; scopes: ReputationScope[];
    claims: Record<string, Record<string, unknown> | unknown[]>; issuedAt: string; expiresAt: string; revokedAt: string | null;
  };
  payload: string | null; signature: string | null;
}
const FN = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/functions/v1/reputation-verify`;
export async function fetchPublicCredential(id: string, signal?: AbortSignal): Promise<PublicCredential> {
  const res = await fetch(`${FN}?id=${encodeURIComponent(id)}`, { signal, credentials: 'omit' });
  if (res.status === 404) return { status: 'not_found', kid: null, credential: null, payload: null, signature: null };
  if (!res.ok) throw new Error('verification_unavailable');
  return (await res.json()) as PublicCredential;
}
export const jwksUrl = `${FN}?jwks=1`;
