/**
 * AI Pre-Arrival Intelligence — client domain logic.
 *
 * Before a technician leaves for a job, the `generate-mission-brief` Edge
 * Function builds a "Mission Brief": predicted issue + confidence, last
 * service history, warranty status, likely parts (cross-referenced against
 * the technician's own van stock), whether the customer has previously
 * declined a similar repair, an estimated job value + duration, and a
 * before-leaving / on-arrival checklist. One brief per job, upserted on
 * regenerate.
 *
 * Server counterpart: supabase/functions/generate-mission-brief
 * (index.ts, normalize.ts). Keep the types below in sync with normalize.ts.
 */

import { supabase } from '@/lib/supabase';

export type PartNecessity = 'likely' | 'possible' | 'if_confirmed';
export type WarrantyStatus = 'active' | 'expired' | 'unknown';

export interface MissionBriefPart {
  name: string;
  necessity: PartNecessity;
  quantity: number;
  in_van_stock: boolean;
  stock_qty: number | null;
  van_location_name: string | null;
}

export interface MissionBrief {
  id: string;
  job_id: string;
  equipment_id: string | null;
  predicted_issue: string;
  confidence: number;
  reasoning: string | null;
  last_service_summary: string | null;
  last_service_days_ago: number | null;
  warranty_status: WarrantyStatus;
  warranty_expires_at: string | null;
  customer_previously_declined: boolean;
  customer_decline_context: string | null;
  estimated_value: number | null;
  estimated_value_sample_size: number;
  estimated_duration_minutes: number | null;
  parts: MissionBriefPart[];
  risk_flags: string[];
  before_leaving_checklist: string[];
  on_arrival_checklist: string[];
  model: string | null;
  generated_at: string;
  created_at: string;
}

export const PART_NECESSITY_LABELS: Record<PartNecessity, string> = {
  likely: 'Likely needed',
  possible: 'Possible',
  if_confirmed: 'If confirmed',
};

export const WARRANTY_STATUS_META: Record<WarrantyStatus, { label: string; className: string }> = {
  active: { label: 'Warranty active', className: 'bg-success-500/10 text-success-500' },
  expired: { label: 'Warranty expired', className: 'bg-bg-tertiary text-text-secondary' },
  unknown: { label: 'Warranty unknown', className: 'bg-bg-tertiary text-text-secondary' },
};

/** Jobs a mission brief is useful for — before or during the visit, not after it's done. */
export const MISSION_BRIEF_ELIGIBLE_STATUSES = new Set(['scheduled', 'en_route', 'in_progress']);

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

/** The current brief for a job, if one has been generated. Null if none exists yet. */
export async function fetchMissionBrief(jobId: string): Promise<MissionBrief | null> {
  const { data, error } = await supabase.from('job_mission_briefs').select('*').eq('job_id', jobId).maybeSingle();
  if (error) throw error;
  return (data as MissionBrief) ?? null;
}

/** Generates (or regenerates) the mission brief for a job. */
export async function generateMissionBrief(jobId: string): Promise<MissionBrief> {
  const { data, error } = await supabase.functions.invoke('generate-mission-brief', { body: { jobId } });
  if (error) {
    throw new Error(await functionErrorMessage(error, 'Could not reach AI pre-arrival intelligence. Check your connection and try again.'));
  }
  if (data?.error) throw new Error(String(data.error));
  return data as MissionBrief;
}

export function formatEstimatedValue(amount: number | null): string {
  if (amount === null || amount === undefined) return 'No comparable jobs yet';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

export function formatEstimatedDuration(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return 'No estimate yet';
  const hours = minutes / 60;
  return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(minutes)} min`;
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}
