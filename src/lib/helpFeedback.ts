import { supabase } from '@/lib/supabase';

export type HelpVote = 'helpful' | 'not_helpful';

export const MAX_COMMENT_LENGTH = 500;

const VISITOR_KEY = 'vireek.help.visitor.v1';
const VOTE_PREFIX = 'vireek.help.vote.v1:';

let memoryVisitorId: string | null = null;

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** Random per-browser id (no PII). Falls back to memory when storage is blocked. */
export function getVisitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_KEY);
    if (existing && existing.length >= 8 && existing.length <= 64) return existing;
    const fresh = randomId();
    localStorage.setItem(VISITOR_KEY, fresh);
    return fresh;
  } catch {
    memoryVisitorId ??= randomId();
    return memoryVisitorId;
  }
}

export function readStoredVote(slug: string): HelpVote | null {
  try {
    const v = localStorage.getItem(`${VOTE_PREFIX}${slug}`);
    return v === 'helpful' || v === 'not_helpful' ? v : null;
  } catch {
    return null;
  }
}

export function storeVote(slug: string, vote: HelpVote): void {
  try {
    localStorage.setItem(`${VOTE_PREFIX}${slug}`, vote);
  } catch {
    /* storage unavailable — the thank-you state still shows for this visit */
  }
}

export async function submitHelpFeedback(input: { slug: string; vote: HelpVote; comment?: string }): Promise<void> {
  const comment = input.comment?.trim().slice(0, MAX_COMMENT_LENGTH) || null;
  const { data, error } = await supabase.rpc('submit_help_feedback', {
    p_slug: input.slug,
    p_helpful: input.vote === 'helpful',
    p_comment: comment,
    p_visitor_id: getVisitorId(),
  });
  if (error) throw error;
  const result = data as { success?: boolean; error?: string } | null;
  if (!result?.success) throw new Error(result?.error ?? 'feedback_failed');
}
