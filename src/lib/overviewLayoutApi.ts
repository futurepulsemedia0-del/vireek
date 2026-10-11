import { supabase } from '@/lib/supabase';
import { LAYOUT_SCHEMA_VERSION, type OverviewLayout } from '@/lib/overviewLayout';

const TABLE = 'overview_layouts';

/** Raw stored layout for the user, or null when they never customized. */
export async function fetchOverviewLayout(userId: string): Promise<unknown | null> {
  const { data, error } = await supabase.from(TABLE).select('layout').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.layout ?? null;
}

export async function saveOverviewLayout(userId: string, layout: OverviewLayout): Promise<void> {
  const { error } = await supabase.from(TABLE).upsert(
    { user_id: userId, layout, preset: layout.preset, schema_version: LAYOUT_SCHEMA_VERSION },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(error.message);
}

/** "Reset to default": removing the row makes the role preset apply again. */
export async function deleteOverviewLayout(userId: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('user_id', userId);
  if (error) throw new Error(error.message);
}
