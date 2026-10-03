/**
 * Vireek Real-World Context Engine — API + presentation helpers.
 *
 * The graph, flags and readiness score are computed server-side (deterministic, from the business's own
 * data + live weather). This file only calls the Edge Function, reads snapshots through RLS, and maps
 * values to labels and colors.
 */

import { supabase } from '@/lib/supabase';

export type NodeStatus = 'ok' | 'watch' | 'risk' | 'unknown';
export type FlagSeverity = 'info' | 'watch' | 'risk' | 'critical';
export type ContextRisk = 'low' | 'medium' | 'high' | 'critical';

export interface ContextNode {
  id: string;
  type: string;
  label: string;
  status: NodeStatus;
  detail: string;
}
export interface ContextEdge { from: string; to: string; relation: string }
export interface ContextFlag { code: string; severity: FlagSeverity; node: string; title: string; detail: string; action: string }
export interface ContextBrief { summary: string; tech_prep: string[]; customer_note: string; questions: string[] }

export interface JobContextSnapshot {
  id: string;
  job_id: string;
  readiness_score: number;
  coverage_pct: number;
  risk_level: ContextRisk;
  nodes: ContextNode[];
  edges: ContextEdge[];
  flags: ContextFlag[];
  sources: Record<string, 'live' | 'internal' | 'missing'>;
  brief: ContextBrief | null;
  ai_status: 'ok' | 'unavailable' | 'skipped';
  generated_at: string;
}

export interface PropertyProfile {
  id?: string;
  customer_id: string;
  site_id: string | null;
  year_built: number | null;
  square_feet: number | null;
  property_type: string | null;
  heating_fuel: string | null;
  utility_provider: string | null;
}

export const RISK_META: Record<ContextRisk, { label: string; text: string }> = {
  low: { label: 'Ready to dispatch', text: 'text-success-500' },
  medium: { label: 'Review before dispatch', text: 'text-warning-500' },
  high: { label: 'High risk', text: 'text-danger' },
  critical: { label: 'Not ready', text: 'text-danger' },
};

export const NODE_TEXT: Record<NodeStatus, string> = {
  ok: 'text-success-500',
  watch: 'text-warning-500',
  risk: 'text-danger',
  unknown: 'text-text-secondary',
};

export const SEVERITY_META: Record<FlagSeverity, { label: string; text: string }> = {
  critical: { label: 'Critical', text: 'text-danger' },
  risk: { label: 'Risk', text: 'text-danger' },
  watch: { label: 'Watch', text: 'text-warning-500' },
  info: { label: 'Info', text: 'text-text-secondary' },
};

export const PROPERTY_TYPES = ['single_family', 'multi_family', 'condo', 'townhouse', 'commercial', 'industrial', 'other'] as const;
export const HEATING_FUELS = ['gas', 'electric', 'oil', 'propane', 'heat_pump', 'other', 'unknown'] as const;

export const humanize = (v: string) => v.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** A snapshot older than this is shown as stale and should be refreshed before dispatch. */
export function isStale(snapshot: JobContextSnapshot, hours = 6): boolean {
  return Date.now() - Date.parse(snapshot.generated_at) > hours * 3_600_000;
}

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

export async function requestJobContext(
  jobId: string,
  opts: { force?: boolean; skipAi?: boolean } = {},
): Promise<{ snapshot: JobContextSnapshot; cached: boolean }> {
  const { data, error } = await supabase.functions.invoke('job-context-engine', {
    body: { jobId, force: opts.force === true, skipAi: opts.skipAi === true },
  });
  if (error) throw new Error(await functionErrorMessage(error, 'Could not build the job context. Please try again.'));
  if (data?.error) throw new Error(String(data.error));
  return { snapshot: data.snapshot as JobContextSnapshot, cached: data.cached === true };
}

export async function fetchLatestJobContext(jobId: string): Promise<JobContextSnapshot | null> {
  const { data, error } = await supabase
    .from('job_context_snapshots')
    .select('*')
    .eq('job_id', jobId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as JobContextSnapshot | null) ?? null;
}

/** Latest snapshot per job for the dashboard overview (one query, newest first, first-wins). */
export async function fetchLatestContextsForJobs(jobIds: string[]): Promise<Map<string, JobContextSnapshot>> {
  const map = new Map<string, JobContextSnapshot>();
  if (!jobIds.length) return map;
  const { data, error } = await supabase
    .from('job_context_snapshots')
    .select('*')
    .in('job_id', jobIds)
    .order('generated_at', { ascending: false })
    .limit(jobIds.length * 3);
  if (error) throw error;
  for (const row of (data ?? []) as JobContextSnapshot[]) if (!map.has(row.job_id)) map.set(row.job_id, row);
  return map;
}

export async function fetchPropertyProfile(customerId: string, siteId: string | null): Promise<PropertyProfile | null> {
  let q = supabase.from('property_context_profiles').select('*').eq('customer_id', customerId);
  q = siteId ? q.eq('site_id', siteId) : q.is('site_id', null);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return (data as PropertyProfile | null) ?? null;
}

export async function savePropertyProfile(p: PropertyProfile): Promise<void> {
  const fields = {
    year_built: p.year_built,
    square_feet: p.square_feet,
    property_type: p.property_type,
    heating_fuel: p.heating_fuel,
    utility_provider: p.utility_provider?.trim() || null,
  };
  const existing = await fetchPropertyProfile(p.customer_id, p.site_id);
  const { error } = existing?.id
    ? await supabase.from('property_context_profiles').update(fields).eq('id', existing.id)
    : await supabase.from('property_context_profiles').insert({ customer_id: p.customer_id, site_id: p.site_id, ...fields });
  if (error) throw error;
}
