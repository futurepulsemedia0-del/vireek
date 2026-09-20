import { supabase } from '@/lib/supabase';

/**
 * Customer review submission — client library.
 * Same token-gated SECURITY DEFINER pattern as reschedule/quote/portal.
 * See supabase/migrations/20261109000000_customer_review_referral.sql.
 */

export interface ReviewRequestPublic {
  business_name: string | null;
  google_review_url: string | null;
  status: 'sent' | 'completed' | 'declined';
  rating: number | null;
}

export async function fetchReviewRequest(token: string): Promise<ReviewRequestPublic | null> {
  const { data, error } = await supabase.rpc('get_review_request', { p_token: token });
  if (error || !data) return null;
  return data as ReviewRequestPublic;
}

export interface SubmitReviewResult {
  ok: boolean;
  reason?: string;
  suggest_public_review?: boolean;
  google_review_url?: string | null;
}

export async function submitReview(token: string, rating: number, feedback: string): Promise<SubmitReviewResult> {
  const { data, error } = await supabase.rpc('submit_customer_review', {
    p_token: token,
    p_rating: rating,
    p_feedback: feedback,
  });
  if (error || !data) return { ok: false, reason: 'network_error' };
  return data as SubmitReviewResult;
}
