import { supabase } from '@/lib/supabase';

/**
 * Promise Tracker — dashboard client library.
 *
 * Rows are written only by the webhook's service-role client (see
 * supabase/functions/_shared/ai-core/promiseExtraction.ts, wired into
 * end-of-call-report). This module reads them and handles the one thing
 * a human does here: marking a promise fulfilled, broken, or cancelled.
 */

export type PromiseCategory = 'callback' | 'arrival_time' | 'pricing' | 'follow_up' | 'documentation' | 'other';
export type PromiseStatus = 'pending' | 'fulfilled' | 'broken' | 'cancelled';

export interface Promise_ {
  id: string;
  user_id: string;
  call_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  promise_text: string;
  category: PromiseCategory;
  due_description: string | null;
  due_at: string | null;
  status: PromiseStatus;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

export const CATEGORY_LABELS: Record<PromiseCategory, string> = {
  callback: 'Callback',
  arrival_time: 'Arrival Time',
  pricing: 'Pricing / Discount',
  follow_up: 'Follow-Up',
  documentation: 'Documentation',
  other: 'Other',
};

export async function fetchPromises(): Promise<Promise_[]> {
  const { data, error } = await supabase
    .from('promises')
    .select('*')
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(500);
  if (error) throw error;
  return (data as Promise_[]) ?? [];
}

export async function resolvePromise(
  id: string,
  status: Extract<PromiseStatus, 'fulfilled' | 'broken' | 'cancelled'>,
  note: string,
): Promise<void> {
  const { error } = await supabase
    .from('promises')
    .update({ status, resolved_at: new Date().toISOString(), resolution_note: note || null })
    .eq('id', id);
  if (error) throw error;
}

export async function reopenPromise(id: string): Promise<void> {
  const { error } = await supabase
    .from('promises')
    .update({ status: 'pending', resolved_at: null, resolution_note: null })
    .eq('id', id);
  if (error) throw error;
}

/** Client-side only — never persisted. See migration note on why. */
export function isOverdue(p: Promise_): boolean {
  return p.status === 'pending' && p.due_at !== null && new Date(p.due_at).getTime() < Date.now();
}
