// Supabase access for module entitlements. Every function throws an Error with a message that is safe to show.
// Tenants only use fetchMyEntitlements(); the rest is staff-only and enforced server-side (RPCs re-check is_vireek_staff).
import { supabase } from '@/lib/supabase';
import type { Entitlement, EntitlementAuditEntry, EntitlementPayload, StaffEntitlement } from '@/lib/entitlements';

interface DbError { message?: string; code?: string }

function fail(error: DbError | null | undefined, fallback: string): never {
  if (error?.code === '42501') throw new Error('Staff access is required for this action.');
  if (error?.code === 'P0002' || error?.code === '22023') throw new Error(error.message || fallback);
  throw new Error(fallback);
}

/** ALL modules for the signed-in tenant in one call (team members resolve to their account owner server-side). */
export async function fetchMyEntitlements(): Promise<Entitlement[]> {
  const { data, error } = await supabase.rpc('get_my_entitlements');
  if (error) throw new Error('Could not load your modules.');
  return (data ?? []) as Entitlement[];
}

export async function listAccountEntitlements(tenantId: string): Promise<StaffEntitlement[]> {
  const { data, error } = await supabase.rpc('staff_list_account_entitlements', { p_tenant: tenantId });
  if (error) fail(error, 'Could not load this account’s modules.');
  return (data ?? []) as StaffEntitlement[];
}

export async function setEntitlement(tenantId: string, p: EntitlementPayload): Promise<void> {
  const { error } = await supabase.rpc('staff_set_entitlement', {
    p_tenant: tenantId, p_module: p.module_id, p_state: p.state, p_source: p.source, p_expires_at: p.expires_at, p_reason: p.reason,
  });
  if (error) fail(error, 'Could not save the change.');
}

export async function listEntitlementAudit(tenantId: string): Promise<EntitlementAuditEntry[]> {
  const { data, error } = await supabase.rpc('staff_list_entitlement_audit', { p_tenant: tenantId, p_limit: 50 });
  if (error) fail(error, 'Could not load history.');
  return ((data ?? []) as EntitlementAuditEntry[]).map((a) => ({ ...a, id: Number(a.id) }));
}
