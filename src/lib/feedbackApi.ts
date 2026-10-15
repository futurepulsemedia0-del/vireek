// src/lib/feedbackApi.ts
//
// Data access for the NPS/CSAT panel. The account-wide feed comes from the
// get_feedback_records RPC (it resolves the account server-side and enforces
// the permission). The job drill-down is a normal query scoped by
// accountOwnerId, with RLS as the backstop.

import { supabase } from './supabase';
import type { FeedbackRecord, Period } from './feedbackAnalytics';

export const FEEDBACK_ROW_LIMIT = 5000;

export interface FeedbackFeed {
  records: FeedbackRecord[];
  /** true when the row limit was hit, so older responses in the window were cut off */
  truncated: boolean;
}

/** Loads the current window plus the equally long previous one (for period-over-period deltas). */
export async function fetchFeedbackRecords(period: Period): Promise<FeedbackFeed> {
  const span = period.to - period.from;
  const { data, error } = await supabase.rpc('get_feedback_records', {
    p_from: new Date(period.from - span).toISOString(),
    p_to: new Date(period.to).toISOString(),
    p_limit: FEEDBACK_ROW_LIMIT,
  });
  if (error) {
    if (error.code === '42501') throw new Error('You don’t have permission to view customer feedback analytics.');
    throw new Error(error.message);
  }
  const records = ((data ?? []) as FeedbackRecord[]).map((r) => ({ ...r, rating: Number(r.rating) }));
  return { records, truncated: records.length >= FEEDBACK_ROW_LIMIT };
}

export interface FeedbackJob {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  job_status: string;
  invoice_amount: number | null;
  invoice_status: string;
  assigned_technician_id: string | null;
}

export async function fetchFeedbackJob(accountOwnerId: string, jobId: string): Promise<FeedbackJob | null> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id,customer_name,customer_phone,service_type,address,scheduled_datetime,job_status,invoice_amount,invoice_status,assigned_technician_id')
    .eq('user_id', accountOwnerId)
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as FeedbackJob | null) ?? null;
}
