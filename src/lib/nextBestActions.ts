/**
 * Proactive Customer Care / Next Best Action Engine — client domain logic.
 *
 * Reads the `next_best_actions` table (written only by the
 * `next-best-actions` Edge Function) and lets the technician/owner mark an
 * action done or dismiss it. Nothing here computes a priority itself.
 */

import { supabase } from '@/lib/supabase';

export type NextBestActionCategory = 'estimate_risk' | 'invoice_risk' | 'churn_risk' | 'capacity_gap';
export type NextBestActionStatus = 'open' | 'done' | 'dismissed';

export interface NextBestAction {
  id: string;
  action_date: string;
  category: NextBestActionCategory;
  title: string;
  reasoning: string;
  recommended_action: string;
  priority_score: number;
  amount_label: string | null;
  entity_type: string | null;
  entity_id: string | null;
  entity_label: string | null;
  cta_href: string | null;
  status: NextBestActionStatus;
  created_at: string;
}

export const CATEGORY_META: Record<NextBestActionCategory, { label: string; className: string }> = {
  estimate_risk: { label: 'Estimate at risk', className: 'bg-warning-500/10 text-warning-500' },
  invoice_risk: { label: 'Invoice at risk', className: 'bg-danger-500/10 text-danger-500' },
  churn_risk: { label: 'Churn risk', className: 'bg-accent/10 text-accent' },
  capacity_gap: { label: 'Open capacity', className: 'bg-bg-tertiary text-text-secondary' },
};

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

/** Today's ranked actions (any status), highest priority first. */
export async function fetchTodayActions(): Promise<NextBestAction[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('next_best_actions')
    .select('*')
    .eq('action_date', today)
    .order('priority_score', { ascending: false });
  if (error) throw error;
  return (data as NextBestAction[]) ?? [];
}

/** Triggers a fresh ranking run; replaces today's still-open auto-generated rows. */
export async function generateNextBestActions(): Promise<{ generated: number; actions: NextBestAction[] }> {
  const { data, error } = await supabase.functions.invoke('next-best-actions', { body: {} });
  if (error) {
    throw new Error(await functionErrorMessage(error, 'Could not refresh next best actions. Try again shortly.'));
  }
  if (data?.error) throw new Error(String(data.error));
  return data as { generated: number; actions: NextBestAction[] };
}

export async function updateActionStatus(id: string, status: Exclude<NextBestActionStatus, 'open'>): Promise<void> {
  const { error } = await supabase
    .from('next_best_actions')
    .update({ status, resolved_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
