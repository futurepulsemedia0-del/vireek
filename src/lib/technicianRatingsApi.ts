import { supabase } from '@/lib/supabase';
import type { SubmitReviewResult } from '@/lib/customerReview';
import {
  buildRatingSummaryMap,
  type TechnicianRatingSummary,
  type TechnicianRatingValue,
} from '@/lib/technicianRatings';

export interface TechnicianReviewContext {
  available: boolean;
  technician_first_name: string | null;
  already_rated: boolean;
}

/** Public, token-gated. Null = invalid token or network error (page simply hides the technician section). */
export async function fetchTechnicianReviewContext(token: string): Promise<TechnicianReviewContext | null> {
  const { data, error } = await supabase.rpc('get_technician_review_context', { p_token: token });
  if (error || !data) return null;
  return data as TechnicianReviewContext;
}

/** Overall rating (required by the page) + optional technician rating, submitted atomically. */
export async function submitReviewWithTechnician(
  token: string,
  rating: number | null,
  feedback: string,
  technician: TechnicianRatingValue | null,
): Promise<SubmitReviewResult> {
  const hasTech = technician !== null && technician.rating >= 1;
  const { data, error } = await supabase.rpc('submit_customer_review_v2', {
    p_token: token,
    p_rating: rating,
    p_feedback: feedback,
    p_tech_rating: hasTech ? technician.rating : null,
    p_tech_tags: hasTech ? technician.tags : null,
    p_tech_comment: hasTech ? technician.comment : null,
  });
  if (error || !data) return { ok: false, reason: 'network_error' };
  return data as SubmitReviewResult;
}

/** Owner-scoped summaries for dispatch. Failure is non-fatal: dispatch just ranks without ratings. */
export async function fetchTechnicianRatingSummaries(days = 180): Promise<Record<string, TechnicianRatingSummary>> {
  const { data, error } = await supabase.rpc('technician_rating_summaries', { p_days: days });
  if (error || !data) return {};
  const rows = (data as Array<Record<string, unknown>>).map((r) => ({
    technician_id: String(r.technician_id),
    responses: Number(r.responses),
    avg_rating: Number(r.avg_rating),
    low_count: Number(r.low_count),
    recent_avg: r.recent_avg === null || r.recent_avg === undefined ? null : Number(r.recent_avg),
    tags: Array.isArray(r.tags) ? (r.tags as TechnicianRatingSummary['tags']) : [],
  }));
  return buildRatingSummaryMap(rows);
}
