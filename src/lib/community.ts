import { supabase } from '@/lib/supabase';

export interface CommunityCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon_name: string;
  sort_order: number;
}

export type CommunityThreadStatus = 'open' | 'answered' | 'closed';

export interface CommunityThread {
  id: string;
  category_id: string;
  author_id: string | null;
  author_name: string;
  title: string;
  body: string;
  status: CommunityThreadStatus;
  is_pinned: boolean;
  accepted_reply_id: string | null;
  reply_count: number;
  upvote_count: number;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface CommunityReply {
  id: string;
  thread_id: string;
  author_id: string | null;
  author_name: string;
  body: string;
  is_accepted: boolean;
  upvote_count: number;
  created_at: string;
}

export async function fetchCommunityCategories(): Promise<CommunityCategory[]> {
  const { data, error } = await supabase.from('community_categories').select('*').order('sort_order');
  if (error) throw error;
  return (data as CommunityCategory[]) ?? [];
}

export async function fetchCommunityThreads(filters?: {
  categoryId?: string;
  search?: string;
}): Promise<CommunityThread[]> {
  let query = supabase
    .from('community_threads')
    .select('*')
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(100);
  if (filters?.categoryId) query = query.eq('category_id', filters.categoryId);
  if (filters?.search) query = query.ilike('title', `%${filters.search}%`);
  const { data, error } = await query;
  if (error) throw error;
  return (data as CommunityThread[]) ?? [];
}

export async function fetchCommunityThread(threadId: string): Promise<CommunityThread | null> {
  const { data, error } = await supabase.from('community_threads').select('*').eq('id', threadId).maybeSingle();
  if (error) throw error;
  return (data as CommunityThread) ?? null;
}

export async function fetchCommunityReplies(threadId: string): Promise<CommunityReply[]> {
  const { data, error } = await supabase
    .from('community_replies')
    .select('*')
    .eq('thread_id', threadId)
    .order('is_accepted', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as CommunityReply[]) ?? [];
}

export async function fetchMyCommunityVotes(targetType: 'thread' | 'reply', targetIds: string[]): Promise<Set<string>> {
  if (targetIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from('community_votes')
    .select('target_id')
    .eq('target_type', targetType)
    .in('target_id', targetIds);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.target_id as string));
}

export async function createCommunityThread(input: {
  categoryId: string;
  title: string;
  body: string;
  authorName: string;
}): Promise<CommunityThread> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('community_threads')
    .insert({
      category_id: input.categoryId,
      title: input.title,
      body: input.body,
      author_name: input.authorName,
      author_id: userData.user?.id ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as CommunityThread;
}

export async function createCommunityReply(threadId: string, body: string, authorName: string): Promise<CommunityReply> {
  const { data, error } = await supabase.rpc('create_community_reply', {
    p_thread_id: threadId,
    p_body: body,
    p_author_name: authorName,
  });
  if (error) throw error;
  return data as CommunityReply;
}

export async function toggleCommunityVote(targetType: 'thread' | 'reply', targetId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('toggle_community_vote', { p_target_type: targetType, p_target_id: targetId });
  if (error) throw error;
  return Boolean(data);
}

export async function acceptCommunityReply(replyId: string): Promise<void> {
  const { error } = await supabase.rpc('accept_community_reply', { p_reply_id: replyId });
  if (error) throw error;
}

export async function updateCommunityThread(threadId: string, title: string, body: string): Promise<void> {
  const { error } = await supabase.rpc('update_community_thread', { p_thread_id: threadId, p_title: title, p_body: body });
  if (error) throw error;
}

export function incrementCommunityThreadViews(threadId: string): void {
  // fire-and-forget؛ شکست این نباید UX رو بلاک کنه
  void supabase.rpc('increment_community_thread_views', { p_thread_id: threadId });
}
