import { supabase } from '@/lib/supabase';

export interface SavedView {
  id: string;
  user_id: string;
  page: 'calls' | 'leads' | 'jobs';
  name: string;
  filters: Record<string, unknown>;
  created_at: string;
}

export async function listSavedViews(page: SavedView['page']): Promise<SavedView[]> {
  const { data, error } = await supabase
    .from('saved_views')
    .select('*')
    .eq('page', page)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as SavedView[];
}

export async function createSavedView(
  page: SavedView['page'],
  name: string,
  filters: Record<string, unknown>
): Promise<SavedView> {
  const { data, error } = await supabase
    .from('saved_views')
    .insert({ page, name, filters })
    .select('*')
    .single();
  if (error) throw error;
  return data as SavedView;
}

export async function deleteSavedView(id: string): Promise<void> {
  const { error } = await supabase.from('saved_views').delete().eq('id', id);
  if (error) throw error;
}
