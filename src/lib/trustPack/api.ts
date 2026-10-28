// Enterprise Trust Pack — browser data access (Supabase RLS does the scoping).
// Pure logic lives in the sibling modules; this file only moves data.

import { supabase } from '@/lib/supabase';
import { isRegionCode, type RegionCode } from './regions';
import type { Incident } from './sla';
import { normalizeCounts, type NoticeInput, type PentestInput, type PentestSummary, type SubprocessorNotice } from './notices';

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = (await ctx.clone().json()) as { error?: string };
        if (j?.error) message = j.error;
      } catch { /* keep generic message */ }
    }
    throw new Error(message);
  }
  return data as T;
}

const must = <T,>(r: { data: T | null; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
};

// ------------------------------------------------------------------ residency
export interface DataRegionRow { code: RegionCode; label: string; is_available: boolean; enforced_at: string | null }
export interface ResidencyRow { region: RegionCode; selected_at: string }
export interface ChangeRequest {
  id: string; user_id: string; from_region: RegionCode; to_region: RegionCode; reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed' | 'cancelled'; decision_note: string | null; created_at: string;
}
export interface DedicatedRow { status: 'requested' | 'provisioning' | 'active' | 'suspended' | 'declined'; region: RegionCode; request_note: string | null; requested_at: string; activated_at: string | null }

export async function fetchRegions(): Promise<DataRegionRow[]> {
  const rows = must(await supabase.from('data_regions').select('code,label,is_available').order('code')) as DataRegionRow[];
  return rows.filter((r) => isRegionCode(r.code));
}
export async function fetchResidency(ownerId: string): Promise<ResidencyRow | null> {
  return must(await supabase.from('tenant_residency').select('region,selected_at').eq('user_id', ownerId).maybeSingle()) as ResidencyRow | null;
}
export async function chooseRegion(ownerId: string, region: RegionCode): Promise<void> {
  must(await supabase.from('tenant_residency').insert({ user_id: ownerId, region }).select('region').single());
  await supabase.rpc('log_audit_event', { p_user_id: ownerId, p_action: 'selected_data_region', p_target_table: 'tenant_residency', p_target_id: ownerId, p_metadata: { region } });
}
export async function fetchChangeRequests(ownerId: string): Promise<ChangeRequest[]> {
  return must(await supabase.from('residency_change_requests').select('*').eq('user_id', ownerId).order('created_at', { ascending: false }).limit(10)) as ChangeRequest[];
}
export async function requestRegionChange(ownerId: string, toRegion: RegionCode, reason: string): Promise<void> {
  must(await supabase.from('residency_change_requests').insert({ user_id: ownerId, from_region: 'us', to_region: toRegion, reason: reason.trim() }).select('id').single());
  await supabase.rpc('log_audit_event', { p_user_id: ownerId, p_action: 'requested_region_change', p_target_table: 'residency_change_requests', p_target_id: null, p_metadata: { to: toRegion } });
}
export async function cancelRegionChange(id: string): Promise<void> {
  must(await supabase.from('residency_change_requests').update({ status: 'cancelled' }).eq('id', id).eq('status', 'pending').select('id').single());
}
export async function fetchDedicated(ownerId: string): Promise<DedicatedRow | null> {
  return must(await supabase.from('dedicated_tenants').select('status,region,request_note,requested_at,activated_at').eq('user_id', ownerId).maybeSingle()) as DedicatedRow | null;
}
export async function requestDedicated(ownerId: string, note: string): Promise<void> {
  must(await supabase.from('dedicated_tenants').insert({ user_id: ownerId, region: 'us', request_note: note.trim() || null }).select('status').single());
  await supabase.rpc('log_audit_event', { p_user_id: ownerId, p_action: 'requested_dedicated_tenant', p_target_table: 'dedicated_tenants', p_target_id: ownerId });
}
export async function withdrawDedicated(ownerId: string): Promise<void> {
  const { error } = await supabase.from('dedicated_tenants').delete().eq('user_id', ownerId).eq('status', 'requested');
  if (error) throw new Error(error.message);
}

// ------------------------------------------------------------------ encryption
export interface KeyRow {
  id: string; key_arn: string; label: string | null; status: 'pending' | 'active' | 'retired' | 'revoked';
  last_validated_at: string | null; last_error: string | null; created_at: string; activated_at: string | null; revoked_at: string | null;
}
export interface EncryptionPolicy { seal_recordings: boolean; seal_transcripts: boolean }
export interface KeySetupInfo { configured: boolean; principalArn: string | null; policyStatement: Record<string, unknown> | null }

export async function fetchKeys(ownerId: string): Promise<KeyRow[]> {
  return must(await supabase.from('tenant_encryption_keys')
    .select('id,key_arn,label,status,last_validated_at,last_error,created_at,activated_at,revoked_at')
    .eq('user_id', ownerId).order('created_at', { ascending: false })) as KeyRow[];
}
export const keySetupInfo = () => invoke<KeySetupInfo>('trust-keys', { action: 'setup_info' });
export const registerKey = (keyArn: string, label: string) => invoke<{ key: KeyRow; rotatedFrom: string | null }>('trust-keys', { action: 'register', keyArn, label });
export const revalidateKey = (keyId: string) => invoke<{ key: KeyRow; ok: boolean; error?: string }>('trust-keys', { action: 'validate', keyId });
export const revokeKey = (keyId: string) => invoke<{ key: KeyRow }>('trust-keys', { action: 'revoke', keyId });
export const rewrapKeys = (fromKeyId: string, toKeyId: string) => invoke<{ rewrapped: number; remaining: number; failed: number }>('trust-keys', { action: 'rewrap', fromKeyId, toKeyId });

export async function fetchEncryptionPolicy(ownerId: string): Promise<EncryptionPolicy> {
  const row = must(await supabase.from('tenant_encryption_policy').select('seal_recordings,seal_transcripts').eq('user_id', ownerId).maybeSingle()) as EncryptionPolicy | null;
  return row ?? { seal_recordings: false, seal_transcripts: false };
}
export async function saveEncryptionPolicy(ownerId: string, policy: EncryptionPolicy): Promise<void> {
  must(await supabase.from('tenant_encryption_policy').upsert({ user_id: ownerId, ...policy }, { onConflict: 'user_id' }).select('user_id').single());
  await supabase.rpc('log_audit_event', { p_user_id: ownerId, p_action: 'updated_encryption_policy', p_target_table: 'tenant_encryption_policy', p_target_id: ownerId, p_metadata: { ...policy } });
}
export async function fetchSealedCounts(ownerId: string): Promise<Record<string, { total: number; byKey: Record<string, number> }>> {
  const rows = must(await supabase.from('sealed_inventory').select('region,key_id').eq('user_id', ownerId).is('purge_requested_at', null).limit(10000)) as { region: string; key_id: string }[];
  const out: Record<string, { total: number; byKey: Record<string, number> }> = {};
  for (const r of rows) {
    const e = (out[r.region] ??= { total: 0, byKey: {} });
    e.total++;
    e.byKey[r.key_id] = (e.byKey[r.key_id] ?? 0) + 1;
  }
  return out;
}

// ------------------------------------------------------------------ SLA
export interface SlaPolicyRow { monthly_fee_cents: number | null; currency: string; tiers: unknown; auto_credit: boolean }
export interface SlaCreditRow {
  id: string; period: string; uptime_pct: number; measured_minutes: number; downtime_minutes: number; credit_pct: number;
  credit_cents: number; monthly_fee_cents: number | null; status: 'none' | 'pending' | 'applied' | 'failed' | 'void'; computed_at: string;
}
export async function fetchSlaPolicy(ownerId: string): Promise<SlaPolicyRow | null> {
  return must(await supabase.from('sla_policies').select('monthly_fee_cents,currency,tiers,auto_credit').eq('user_id', ownerId).maybeSingle()) as SlaPolicyRow | null;
}
export async function fetchIncidents(sinceIso: string): Promise<Incident[]> {
  return must(await supabase.from('sla_incidents').select('*').gte('started_at', sinceIso).order('started_at', { ascending: false }).limit(500)) as Incident[];
}
export async function fetchSlaCredits(ownerId: string): Promise<SlaCreditRow[]> {
  return must(await supabase.from('sla_credits').select('*').eq('user_id', ownerId).order('period', { ascending: false }).limit(24)) as SlaCreditRow[];
}

// ------------------------------------------------------------------ security portal (public reads)
interface PentestRow extends Omit<PentestSummary, 'found' | 'remediated'> { found: unknown; remediated: unknown }
export async function fetchPentests(): Promise<PentestSummary[]> {
  const rows = must(await supabase.from('security_pentests').select('*').order('performed_on', { ascending: false }).limit(50)) as PentestRow[];
  return rows.map((r) => ({ ...r, found: normalizeCounts(r.found), remediated: normalizeCounts(r.remediated) }));
}
export async function fetchNotices(): Promise<SubprocessorNotice[]> {
  return must(await supabase.from('subprocessor_notices').select('*').order('posted_at', { ascending: false }).limit(50)) as SubprocessorNotice[];
}
export const subscribeToNotices = (email: string) => invoke<{ ok: true }>('trust-subscribe', { action: 'subscribe', email });
export const confirmSubscription = (token: string) => invoke<{ ok: true }>('trust-subscribe', { action: 'verify', token });
export const unsubscribeFromNotices = (token: string) => invoke<{ ok: true }>('trust-subscribe', { action: 'unsubscribe', token });
export async function requestFullReport(input: { pentestId: string | null; email: string; company: string; message: string }): Promise<void> {
  const { error } = await supabase.from('security_report_requests').insert({
    pentest_id: input.pentestId, email: input.email.trim(), company: input.company.trim(), message: input.message.trim() || null,
  });
  if (error) throw new Error('Could not send your request. Check the details and try again.');
}

export interface ObjectionRow { id: string; notice_id: string; reason: string; status: 'open' | 'under_review' | 'resolved' | 'withdrawn'; response: string | null; created_at: string }
export async function fetchObjections(ownerId: string): Promise<ObjectionRow[]> {
  return must(await supabase.from('subprocessor_objections').select('id,notice_id,reason,status,response,created_at').eq('user_id', ownerId)) as ObjectionRow[];
}
export async function submitObjection(ownerId: string, noticeId: string, reason: string): Promise<void> {
  const { error } = await supabase.from('subprocessor_objections').insert({ user_id: ownerId, notice_id: noticeId, reason: reason.trim() });
  if (error) throw new Error(error.code === '23505' ? 'You have already objected to this change.' : error.message);
  await supabase.rpc('log_audit_event', { p_user_id: ownerId, p_action: 'objected_to_subprocessor', p_target_table: 'subprocessor_notices', p_target_id: noticeId });
}

// ------------------------------------------------------------------ opening sealed data
export async function openSealedField(sealedId: string): Promise<string> {
  return (await invoke<{ value: string }>('trust-vault', { action: 'open_field', sealedId })).value;
}
export async function openSealedRecording(sealedId: string): Promise<Blob> {
  const { data, error } = await supabase.functions.invoke('trust-vault', { body: { action: 'open_recording', sealedId } });
  if (error) throw new Error(error.message);
  return data as Blob;
}

// ------------------------------------------------------------------ staff
export async function staffCreatePentest(i: PentestInput, publish: boolean): Promise<void> {
  must(await supabase.from('security_pentests').insert({ ...i, published_at: publish ? new Date().toISOString() : null }).select('id').single());
}
export async function staffPublishPentest(id: string): Promise<void> {
  must(await supabase.from('security_pentests').update({ published_at: new Date().toISOString() }).eq('id', id).select('id').single());
}
export async function staffCreateNotice(i: NoticeInput): Promise<string> {
  const row = must(await supabase.from('subprocessor_notices').insert({
    processor_name: i.processor_name.trim(), change_type: i.change_type, replaces_name: i.change_type === 'replace' ? i.replaces_name?.trim() : null,
    purpose: i.purpose.trim(), location: i.location.trim(), data_types: i.data_types.trim(), summary: i.summary.trim(),
    effective_at: i.effective_at, emergency: i.emergency,
  }).select('id').single()) as { id: string };
  return row.id;
}
export const staffDispatchNotice = (noticeId: string) => invoke<{ sent: number; failed: number; skipped: number }>('subprocessor-notice-dispatch', { noticeId });
export async function staffWithdrawNotice(id: string): Promise<void> {
  must(await supabase.from('subprocessor_notices').update({ withdrawn_at: new Date().toISOString() }).eq('id', id).select('id').single());
}
export async function staffSaveIncident(i: Partial<Incident> & Pick<Incident, 'title' | 'kind' | 'scope' | 'started_at'>): Promise<void> {
  must(await supabase.from('sla_incidents').insert(i).select('id').single());
}
export async function staffUpdateIncident(id: string, patch: Partial<Pick<Incident, 'ended_at' | 'confirmed'>>): Promise<void> {
  must(await supabase.from('sla_incidents').update(patch).eq('id', id).select('id').single());
}
export async function staffListIncidents(): Promise<Incident[]> {
  return must(await supabase.from('sla_incidents').select('*').order('started_at', { ascending: false }).limit(50)) as Incident[];
}
export async function staffSetRegionAvailability(code: RegionCode, available: boolean): Promise<void> {
  must(await supabase.from('data_regions').update({ is_available: available, provisioned_at: available ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq('code', code).select('code').single());
}
export async function staffUpsertSlaPolicy(userId: string, p: { monthly_fee_cents: number | null; auto_credit: boolean; tiers?: unknown }): Promise<void> {
  must(await supabase.from('sla_policies').upsert({ user_id: userId, ...p, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).select('user_id').single());
}
export async function staffListChangeRequests(): Promise<ChangeRequest[]> {
  return must(await supabase.from('residency_change_requests').select('*').in('status', ['pending', 'approved']).order('created_at')) as ChangeRequest[];
}
export async function staffDecideChange(id: string, approve: boolean, note: string): Promise<void> {
  const { error } = await supabase.rpc('staff_decide_region_change', { p_id: id, p_approve: approve, p_note: note || null });
  if (error) throw new Error(error.message);
}
export async function staffCompleteChange(id: string): Promise<void> {
  const { error } = await supabase.rpc('staff_complete_region_change', { p_id: id, p_confirm_old_region_clean: true });
  if (error) throw new Error(error.message);
}
export const staffMigrate = (userId: string) => invoke<{ moved: number; remaining: number; failed: number }>('trust-vault', { action: 'migrate', userId });
export async function staffListDedicated(): Promise<(DedicatedRow & { user_id: string })[]> {
  return must(await supabase.from('dedicated_tenants').select('user_id,status,region,request_note,requested_at,activated_at').in('status', ['requested', 'provisioning']).order('requested_at')) as (DedicatedRow & { user_id: string })[];
}
export async function staffUpdateDedicated(userId: string, patch: { status: DedicatedRow['status']; endpoint_url?: string | null; secret_ref?: string | null }): Promise<void> {
  must(await supabase.from('dedicated_tenants').update(patch).eq('user_id', userId).select('user_id').single());
}
