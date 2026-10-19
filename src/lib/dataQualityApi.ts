/**
 * Data Quality Center — data access.
 *
 * Reads existing tables only (customers, jobs, leads, equipment, job_equipment,
 * customer_preference_events, job_profitability) — no new table, no AI call.
 * The Business Reality Engine is reused as the "operational reality" dimension.
 * All reads are RLS-scoped to the account by the database; nothing here widens that.
 */

import { supabase } from '@/lib/supabase';
import { getPublicOrigin } from '@/lib/appOrigin';
import { buildRealityReport, type RealityReport } from '@/lib/businessReality';
import {
  assembleHealth,
  buildCostCheck,
  buildCustomerChecks,
  buildEquipmentCheck,
  isBlank,
  mergeFixes,
  type CostJobRow,
  type CustomerRow,
  type DataHealth,
  type DqFix,
  type EquipmentRow,
  type JobRow,
  type LeadRow,
} from '@/lib/dataQuality';

const CUSTOMER_LIMIT = 2000;
const JOB_LIMIT = 3000;
const LEAD_LIMIT = 3000;
const EQUIPMENT_LIMIT = 2000;
const LINK_LIMIT = 5000;
const EVENT_LIMIT = 5000;
const COST_LIMIT = 2000;

export async function buildDataHealth(): Promise<DataHealth> {
  const [customers, jobs, leads, equipment, links, events, costs, reality] = await Promise.all([
    supabase.from('customers').select('id, name, phone, email, address, marketing_opt_in').order('created_at', { ascending: false }).limit(CUSTOMER_LIMIT),
    supabase.from('jobs').select('id, customer_id, customer_name, address, job_status, scheduled_datetime, created_at').order('created_at', { ascending: false }).limit(JOB_LIMIT),
    supabase.from('leads').select('customer_id, phone, email, created_at').not('customer_id', 'is', null).order('created_at', { ascending: false }).limit(LEAD_LIMIT),
    supabase.from('equipment').select('id, customer_id, equipment_type, make, model, install_job_id').eq('status', 'active').limit(EQUIPMENT_LIMIT),
    supabase.from('job_equipment').select('equipment_id').limit(LINK_LIMIT),
    supabase.from('customer_preference_events').select('customer_id').eq('source', 'customer').limit(EVENT_LIMIT),
    supabase.from('job_profitability').select('job_id, customer_name, cost_entry_count').eq('job_status', 'completed').limit(COST_LIMIT),
    buildRealityReport().catch((): RealityReport | null => null),
  ]);

  // Core tables must load; optional evidence tables degrade to "no evidence" rather than hide the page.
  if (customers.error) throw customers.error;
  if (jobs.error) throw jobs.error;

  const customerRows = (customers.data ?? []) as CustomerRow[];
  const jobRows = (jobs.data ?? []) as JobRow[];
  const leadRows = (leads.error ? [] : leads.data ?? []) as LeadRow[];
  const equipmentRows = (equipment.error ? [] : equipment.data ?? []) as EquipmentRow[];
  const linkedIds = new Set((links.error ? [] : links.data ?? []).map((l) => l.equipment_id as string));
  const consentIds = new Set((events.error ? [] : events.data ?? []).map((e) => e.customer_id as string));
  const costRows = (costs.error ? [] : (costs.data ?? []).map((c) => ({
    job_id: c.job_id as string,
    customer_name: (c.customer_name as string) || 'Unnamed customer',
    cost_entry_count: Number(c.cost_entry_count) || 0,
  }))) as CostJobRow[];

  const names = new Map(customerRows.map((c) => [c.id, c.name] as const));
  const customerChecks = buildCustomerChecks({ customers: customerRows, jobs: jobRows, leads: leadRows, consentEvidenceIds: consentIds });
  const checks = [
    ...customerChecks,
    ...[buildEquipmentCheck(equipmentRows, linkedIds, jobRows, names), buildCostCheck(costRows)].filter((c): c is NonNullable<typeof c> => c !== null),
  ];

  return assembleHealth({
    customerCount: customerRows.length,
    reachableCount: customerRows.filter((c) => !isBlank(c.phone) || !isBlank(c.email)).length,
    equipmentCount: equipmentRows.length,
    completedJobCount: costRows.length,
    checks,
    reality,
    truncated:
      customerRows.length >= CUSTOMER_LIMIT || jobRows.length >= JOB_LIMIT || equipmentRows.length >= EQUIPMENT_LIMIT || costRows.length >= COST_LIMIT,
  });
}

// ============================================================
// APPLY FIXES
// ============================================================

export type FixResult =
  | { ok: true; link?: string }
  | { ok: false; reason: 'duplicate' | 'failed' };

const UNIQUE_VIOLATION = '23505';

export async function applyFix(fix: DqFix): Promise<FixResult> {
  switch (fix.type) {
    case 'backfill_customer': {
      const { error } = await supabase.from('customers').update(fix.patch).eq('id', fix.customerId);
      if (!error) return { ok: true };
      return { ok: false, reason: error.code === UNIQUE_VIOLATION ? 'duplicate' : 'failed' };
    }
    case 'link_equipment': {
      const { error } = await supabase.from('job_equipment').insert({ job_id: fix.jobId, equipment_id: fix.equipmentId });
      // Already linked (e.g. fixed in another tab) is the desired end state.
      if (!error || error.code === UNIQUE_VIOLATION) return { ok: true };
      return { ok: false, reason: 'failed' };
    }
    case 'consent_link': {
      const { data, error } = await supabase.rpc('ensure_customer_preference_token', { p_customer_id: fix.customerId });
      if (error || !data) return { ok: false, reason: 'failed' };
      return { ok: true, link: `${getPublicOrigin()}/preferences/${String(data)}` };
    }
    case 'open':
      return { ok: true };
  }
}

export interface BulkSummary {
  applied: number;
  duplicates: number;
  failed: number;
}

/** Applies automatic fixes in small batches so a big backlog doesn't hammer the API. */
export async function applyBulkFixes(fixes: readonly DqFix[], batchSize = 5): Promise<BulkSummary> {
  const queue = mergeFixes(fixes).filter((f) => f.type === 'backfill_customer' || f.type === 'link_equipment');
  const summary: BulkSummary = { applied: 0, duplicates: 0, failed: 0 };
  for (let i = 0; i < queue.length; i += batchSize) {
    const results = await Promise.all(queue.slice(i, i + batchSize).map((f) => applyFix(f)));
    for (const r of results) {
      if (r.ok) summary.applied += 1;
      else if (r.reason === 'duplicate') summary.duplicates += 1;
      else summary.failed += 1;
    }
  }
  return summary;
}
