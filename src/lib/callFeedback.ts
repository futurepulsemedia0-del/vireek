import { supabase } from '@/lib/supabase';

export async function submitCallFeedback(
  callId: string,
  userId: string,
  rating: number,
  comment?: string,
): Promise<{ ok: boolean }> {
  const { error } = await supabase
    .from('call_feedback')
    .upsert(
      { call_id: callId, user_id: userId, rating, comment: comment?.trim() || null },
      { onConflict: 'call_id' },
    );

  if (error) {
    console.error('submitCallFeedback failed:', error);
    return { ok: false };
  }
  return { ok: true };
}
