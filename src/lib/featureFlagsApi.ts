// Supabase access for feature flags. Every function throws an Error with a
// message that is safe to show. Tenants only use fetchMyFlagKeys(); everything
// else is staff-only and enforced server-side (RLS + is_vireek_staff in RPCs).
import { supabase } from '@/lib/supabase';
import type {
  FeatureFlag, FlagAuditEntry, FlagOverride, FlagPayload, OverrideInput, TenantHit,
} from '@/lib/featureFlags';

interface DbError { message?: string; code?: string }

function fail(error: DbError | null | undefined, fallback: string): never {
  if (error?.code === '23505') throw new Error('A flag with that key already exists.');
  if (error?.code === '42501') throw new Error('Staff access is required for this action.');
  if (error?.code === 'P0002' || error?.code === '22023') throw new Error(error.message || fallback);
  throw new Error(fallback);
}

const FLAG_COLS = 'id, key, name, description, enabled, rollout_pct, updated_at';

/** Keys that are ON for the signed-in tenant (evaluated server-side). */
export async function fetchMyFlagKeys(): Promise<string[]> {
  const { data, error } = await supabase.rpc('get_my_feature_flags');
  if (error) throw new Error('Could not load feature flags.');
  return ((data ?? []) as { flag_key: string }[]).map((r) => r.flag_key);
}

export async function listFlags(): Promise<FeatureFlag[]> {
  const { data, error } = await supabase.rpc('staff_list_feature_flags');
  if (error) fail(error, 'Could not load feature flags.');
  return ((data ?? []) as FeatureFlag[]).map((f) => ({
    ...f,
    rollout_pct: Number(f.rollout_pct),
    on_overrides: Number(f.on_overrides),
    off_overrides: Number(f.off_overrides),
    reach_tenants: Number(f.reach_tenants),
    total_tenants: Number(f.total_tenants),
  }));
}

export async function createFlag(p: FlagPayload): Promise<void> {
  const { error } = await supabase.from('feature_flags').insert(p).select(FLAG_COLS).single();
  if (error) fail(error, 'Could not create the flag.');
}

/** The key is immutable, so it is never part of an update. */
export async function updateFlag(id: string, patch: Partial<Omit<FlagPayload, 'key'>>): Promise<void> {
  const { error } = await supabase.from('feature_flags').update(patch).eq('id', id).select(FLAG_COLS).single();
  if (error) fail(error, 'Could not update the flag.');
}

export async function deleteFlag(id: string): Promise<void> {
  const { error } = await supabase.from('feature_flags').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the flag.');
}

export async function listOverrides(flagId: string): Promise<FlagOverride[]> {
  const { data, error } = await supabase.rpc('staff_list_flag_overrides', { p_flag_id: flagId });
  if (error) fail(error, 'Could not load tenant overrides.');
  return (data ?? []) as FlagOverride[];
}

export async function searchTenants(query: string): Promise<TenantHit[]> {
  const { data, error } = await supabase.rpc('staff_search_tenants', { p_query: query });
  if (error) fail(error, 'Could not search tenants.');
  return (data ?? []) as TenantHit[];
}

export async function setOverride(flagId: string, tenantId: string, state: OverrideInput, note: string | null): Promise<void> {
  const { error } = await supabase.rpc('staff_set_flag_override', { p_flag_id: flagId, p_tenant_id: tenantId, p_state: state, p_note: note });
  if (error) fail(error, 'Could not save the override.');
}

export async function listAudit(flagKey: string): Promise<FlagAuditEntry[]> {
  const { data, error } = await supabase.rpc('staff_list_flag_audit', { p_flag_key: flagKey });
  if (error) fail(error, 'Could not load history.');
  return ((data ?? []) as FlagAuditEntry[]).map((a) => ({ ...a, id: Number(a.id) }));
}
