import { supabase } from '@/lib/supabase';

export type RoadmapStatus = 'under_review' | 'planned' | 'in_progress' | 'shipped' | 'declined';
export type RoadmapCategory = 'feature' | 'integration' | 'improvement' | 'general';

export interface RoadmapItem {
  id: string;
  title: string;
  description: string;
  category: RoadmapCategory;
  status: RoadmapStatus;
  votes_count: number;
  submitted_by: string | null;
  admin_note: string | null;
  created_at: string;
  updated_at: string;
}

export const ROADMAP_STATUS_META: Record<Exclude<RoadmapStatus, 'declined'>, { label: string }> = {
  under_review: { label: 'Under Review' },
  planned: { label: 'Planned' },
  in_progress: { label: 'In Progress' },
  shipped: { label: 'Shipped' },
};

export const ROADMAP_CATEGORY_META: Record<RoadmapCategory, { label: string }> = {
  feature: { label: 'New Feature' },
  integration: { label: 'Integration' },
  improvement: { label: 'Improvement' },
  general: { label: 'General' },
};

export async function fetchRoadmapItems(): Promise<RoadmapItem[]> {
  const { data, error } = await supabase
    .from('roadmap_items')
    .select('*')
    .neq('status', 'declined')
    .order('votes_count', { ascending: false });
  if (error) throw error;
  return (data ?? []) as RoadmapItem[];
}

export async function fetchMyVotedItemIds(userId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('roadmap_votes').select('item_id').eq('user_id', userId);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.item_id as string));
}

export async function submitRoadmapItem(input: {
  title: string;
  description: string;
  category: RoadmapCategory;
  userId: string;
}): Promise<RoadmapItem> {
  const { data, error } = await supabase
    .from('roadmap_items')
    .insert({
      title: input.title.trim(),
      description: input.description.trim(),
      category: input.category,
      submitted_by: input.userId,
    })
    .select()
    .single();
  if (error) throw error;
  return data as RoadmapItem;
}

export async function requestIntegration(title: string, note?: string): Promise<RoadmapItem> {
  const { data, error } = await supabase.rpc('request_marketplace_integration', {
    p_title: title.trim(),
    p_note: note?.trim() || null,
  });
  if (error) throw error;
  return data as RoadmapItem;
}
export async function voteRoadmapItem(itemId: string, userId: string) {
  const { error } = await supabase.from('roadmap_votes').insert({ item_id: itemId, user_id: userId });
  if (error) throw error;
}

export async function unvoteRoadmapItem(itemId: string, userId: string) {
  const { error } = await supabase.from('roadmap_votes').delete().eq('item_id', itemId).eq('user_id', userId);
  if (error) throw error;
}
