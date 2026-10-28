import { supabase } from '@/lib/supabase';
import { LAYOUT_SCHEMA_VERSION, type OverviewLayout } from '@/lib/overviewLayout';
import { isRoleKey, type RoleKey } from '@/lib/dashboardRoleLayouts';

const TABLE = 'dashboard_role_layouts';

export interface StoredRoleLayout {
  roleKey: RoleKey;
  /** Raw JSON from the database; always pass it through sanitizeLayout before use. */
  layout: unknown;
  updatedAt: string | null;
}

/** Every role layout the account has published. `ownerId` is the ACCOUNT OWNER's id. */
export async function fetchRoleLayouts(ownerId: string): Promise<StoredRoleLayout[]> {
  const { data, error } = await supabase.from(TABLE).select('role_key, layout, updated_at').eq('user_id', ownerId);
  if (error) throw new Error(error.message);
  const rows: StoredRoleLayout[] = [];
  for (const row of data ?? []) {
    if (isRoleKey(row.role_key)) rows.push({ roleKey: row.role_key, layout: row.layout, updatedAt: row.updated_at ?? null });
  }
  return rows;
}

/** Raw layout the account published for one role, or null when none. */
export async function fetchRoleLayout(ownerId: string, role: RoleKey): Promise<unknown> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('layout')
    .eq('user_id', ownerId)
    .eq('role_key', role)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.layout ?? null;
}

export async function saveRoleLayout(ownerId: string, role: RoleKey, layout: OverviewLayout): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .upsert(
      { user_id: ownerId, role_key: role, layout, schema_version: LAYOUT_SCHEMA_VERSION },
      { onConflict: 'user_id,role_key' },
    );
  if (error) throw new Error(error.message);
}

/** "Reset to default": removing the row makes the built-in preset apply again. */
export async function deleteRoleLayout(ownerId: string, role: RoleKey): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('user_id', ownerId).eq('role_key', role);
  if (error) throw new Error(error.message);
}
