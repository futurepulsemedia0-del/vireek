import { supabase } from '@/lib/supabase';
import type { CommentEntityType, CommentRow, MentionCandidate } from '@/lib/comments';

const COLUMNS =
  'id, user_id, entity_type, entity_id, parent_id, author_id, author_name, body, mentions, resolved_at, resolved_by, resolved_by_name, edited_at, deleted_at, created_at, updated_at';

/** Hard cap per record; a record with more than this many comments is not a conversation any more. */
const FETCH_LIMIT = 500;

export async function fetchComments(type: CommentEntityType, entityId: string): Promise<CommentRow[]> {
  const { data, error } = await supabase
    .from('entity_comments')
    .select(COLUMNS)
    .eq('entity_type', type)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: true })
    .limit(FETCH_LIMIT);
  if (error) throw error;
  return (data ?? []) as CommentRow[];
}

export async function postComment(args: {
  type: CommentEntityType;
  entityId: string;
  body: string;
  parentId?: string | null;
}): Promise<CommentRow> {
  // user_id / author_id default server-side; the BEFORE trigger also overrides them.
  const { data, error } = await supabase
    .from('entity_comments')
    .insert({
      entity_type: args.type,
      entity_id: args.entityId,
      parent_id: args.parentId ?? null,
      body: args.body,
    })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as CommentRow;
}

export async function editComment(id: string, body: string): Promise<CommentRow> {
  const { data, error } = await supabase.from('entity_comments').update({ body }).eq('id', id).select(COLUMNS).single();
  if (error) throw error;
  return data as CommentRow;
}

export async function setThreadResolved(id: string, resolved: boolean): Promise<CommentRow> {
  const { data, error } = await supabase
    .from('entity_comments')
    .update({ resolved_at: resolved ? new Date().toISOString() : null })
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as CommentRow;
}

/** Soft delete — the server blanks the body and stamps deleted_at / deleted_by. */
export async function deleteComment(id: string): Promise<CommentRow> {
  const { data, error } = await supabase
    .from('entity_comments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as CommentRow;
}

interface CandidateRow {
  member_id: string;
  display_name: string | null;
  member_role: string | null;
}

/** People who can be @mentioned on this record (they can all open it). */
export async function fetchMentionCandidates(type: CommentEntityType, entityId: string): Promise<MentionCandidate[]> {
  const { data, error } = await supabase.rpc('comment_mention_candidates', {
    p_entity_type: type,
    p_entity_id: entityId,
  });
  if (error) throw error;
  return ((data ?? []) as CandidateRow[]).map((r) => ({
    userId: r.member_id,
    name: r.display_name?.trim() || 'Teammate',
    role: r.member_role ?? '',
  }));
}
