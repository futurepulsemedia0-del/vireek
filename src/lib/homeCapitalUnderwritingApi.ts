import { supabase } from '@/lib/supabase';
import { createFinancingOffer } from '@/lib/financing';
import { fetchHomeLifetimeGraph } from '@/lib/homeLifetimeGraphApi';
import { fetchEnergyReadings } from '@/lib/homeIntelligenceGraphApi';
import type { HomeLifetimeGraph } from '@/lib/homeLifetimeGraph';
import type { EnergyReading } from '@/lib/homeIntelligenceGraph';
import type { CapitalAction, CapitalItem, HomeCapitalUnderwriting } from '@/lib/homeCapitalUnderwriting';

/**
 * IO layer for the Home Risk & Capital Underwriting Engine. Keeps
 * src/lib/homeCapitalUnderwriting.ts pure. Every hand-off (quote, job, financing,
 * warranty) is recorded in home_capital_actions so the plan can show what became of
 * each recommendation. Tables come from
 * supabase/migrations/20270410000000_home_capital_underwriting.sql.
 */

type DbError = { code?: string; message?: string };

export function errorMessage(e: unknown): string {
  const m = (e as { message?: string } | null)?.message;
  return m && m.trim() ? m : 'Something went wrong.';
}

function isMissingRelation(e: DbError): boolean {
  return e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? '');
}

// ------------------------------------------------------------------- types

export type ActionStatus = 'open' | 'quoted' | 'scheduled' | 'financing' | 'completed' | 'dismissed';
export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  open: 'Open', quoted: 'Quoted', scheduled: 'Scheduled', financing: 'Financing offered', completed: 'Completed', dismissed: 'Dismissed',
};

export interface CapitalActionRow {
  id: string;
  site_id: string;
  plan_id: string | null;
  equipment_id: string | null;
  item_key: string;
  action: CapitalAction;
  title: string;
  status: ActionStatus;
  est_cost_cents: number | null;
  target_date: string | null;
  quote_id: string | null;
  job_id: string | null;
  financing_offer_id: string | null;
  warranty_claim_id: string | null;
  completed_on: string | null;
}

export interface CapitalPlanHistoryRow {
  id: string;
  created_at: string;
  risk_index: number;
  grade: string;
  ten_year_total_cents: number;
  engine_version: string;
}

export interface CapitalInputs {
  graph: HomeLifetimeGraph;
  energyReadings: EnergyReading[];
}

// -------------------------------------------------------------------- reads

export async function fetchCapitalInputs(siteId: string): Promise<CapitalInputs | null> {
  const graph = await fetchHomeLifetimeGraph(siteId);
  if (!graph) return null;
  let energyReadings: EnergyReading[] = [];
  try {
    energyReadings = await fetchEnergyReadings(siteId);
  } catch { /* the energy table is optional; the model reports it as a data gap */ }
  return { graph, energyReadings };
}

export async function fetchCapitalActions(siteId: string): Promise<{ rows: CapitalActionRow[]; schemaReady: boolean }> {
  const { data, error } = await supabase.from('home_capital_actions').select('*').eq('site_id', siteId);
  if (error) {
    if (isMissingRelation(error)) return { rows: [], schemaReady: false };
    throw error;
  }
  return { rows: (data as CapitalActionRow[] | null) ?? [], schemaReady: true };
}

export async function fetchPlanHistory(siteId: string): Promise<CapitalPlanHistoryRow[]> {
  const { data, error } = await supabase
    .from('home_capital_plans')
    .select('id, created_at, risk_index, grade, ten_year_total_cents, engine_version')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) {
    if (isMissingRelation(error)) return [];
    throw error;
  }
  return (data as CapitalPlanHistoryRow[] | null) ?? [];
}

// ------------------------------------------------------------------- writes

async function ownerId(): Promise<string> {
  const { data, error } = await supabase.rpc('get_account_owner_id');
  if (error) throw error;
  if (!data) throw new Error('You must be signed in.');
  return data as string;
}

/** Saves an immutable snapshot of the plan. Returns its id. */
export async function saveCapitalPlan(siteId: string, plan: HomeCapitalUnderwriting, inputs: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase
    .from('home_capital_plans')
    .insert({
      site_id: siteId,
      engine_version: plan.engineVersion,
      risk_index: plan.summary.riskIndex,
      grade: plan.summary.grade,
      risk_tolerance: plan.riskTolerance,
      ten_year_total_cents: Math.round(plan.summary.capital.tenYear * 100),
      summary: plan.summary,
      items: plan.items,
      years: plan.years,
      inputs,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function upsertAction(siteId: string, planId: string | null, item: CapitalItem, patch: Partial<CapitalActionRow>): Promise<CapitalActionRow> {
  const { data, error } = await supabase
    .from('home_capital_actions')
    .upsert(
      {
        site_id: siteId,
        plan_id: planId,
        equipment_id: item.equipmentId,
        item_key: item.key,
        action: item.action,
        title: item.title.slice(0, 200),
        est_cost_cents: Math.round(item.costMid * 100),
        target_date: item.timing.target,
        ...patch,
      },
      { onConflict: 'site_id,item_key' },
    )
    .select('*')
    .single();
  if (error) throw error;
  return data as CapitalActionRow;
}

export async function setActionStatus(siteId: string, planId: string | null, item: CapitalItem, status: ActionStatus): Promise<void> {
  await upsertAction(siteId, planId, item, { status, completed_on: status === 'completed' ? new Date().toISOString().slice(0, 10) : null });
}

interface CustomerLite { id: string; name: string; phone: string | null; email: string | null; address: string | null }

async function fetchCustomer(customerId: string): Promise<CustomerLite> {
  const { data, error } = await supabase.from('customers').select('id, name, phone, email, address').eq('id', customerId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('The customer on this home could not be found.');
  return data as CustomerLite;
}

export interface HandoffContext {
  siteId: string;
  planId: string | null;
  customerId: string;
  siteAddress: string | null;
}

/** Service: a draft Quote carrying the recommendation as a line item. */
export async function createQuoteFromItem(ctx: HandoffContext, item: CapitalItem): Promise<string> {
  const [owner, customer] = await Promise.all([ownerId(), fetchCustomer(ctx.customerId)]);
  const { data, error } = await supabase
    .from('quotes')
    .insert({
      user_id: owner,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_phone: customer.phone,
      customer_email: customer.email,
      line_items: [item.connect.quoteLine],
      tax_percent: 0,
      source: 'home_capital_plan',
      notes: `${item.title} — ${item.rationale}`.slice(0, 1000),
    })
    .select('id')
    .single();
  if (error) throw error;
  const quoteId = (data as { id: string }).id;
  await upsertAction(ctx.siteId, ctx.planId, item, { status: 'quoted', quote_id: quoteId });
  return quoteId;
}

/** Service: a scheduled Job on the recommended date, priced at the planning estimate. */
export async function createJobFromItem(ctx: HandoffContext, item: CapitalItem): Promise<string> {
  const [owner, customer] = await Promise.all([ownerId(), fetchCustomer(ctx.customerId)]);
  const when = new Date(`${item.timing.target}T09:00:00`);
  const scheduled = when.getTime() < Date.now() ? new Date(Date.now() + 86_400_000) : when;
  const { data, error } = await supabase
    .from('jobs')
    .insert({
      user_id: owner,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_phone: customer.phone,
      site_id: ctx.siteId,
      address: ctx.siteAddress ?? customer.address,
      service_type: item.connect.serviceType,
      scheduled_datetime: scheduled.toISOString(),
      job_status: 'scheduled',
      invoice_amount: item.costMid,
    })
    .select('id')
    .single();
  if (error) throw error;
  const jobId = (data as { id: string }).id;
  // Repair/replace jobs are NOT linked to the unit yet: a scheduled repair visit would count as a failure
  // in the unit's own history and inflate its risk. Link them from the job once the work is done.
  if (item.equipmentId && (item.action === 'maintain' || item.action === 'inspect')) {
    const { error: linkError } = await supabase.from('job_equipment').insert({ job_id: jobId, equipment_id: item.equipmentId, service_type: item.action });
    if (linkError) throw linkError; // the job exists; the caller reports a partial result
  }
  await upsertAction(ctx.siteId, ctx.planId, item, { status: 'scheduled', job_id: jobId });
  return jobId;
}

/** Financing: needs a job with an invoice amount; creates one first when the item has none. */
export async function createFinancingFromItem(ctx: HandoffContext, item: CapitalItem, existing: CapitalActionRow | undefined): Promise<string> {
  const customer = await fetchCustomer(ctx.customerId);
  if (!customer.email && !customer.phone) throw new Error('Add an email or phone number to the customer first — the offer is sent there.');
  const jobId = existing?.job_id ?? (await createJobFromItem(ctx, item));
  const offer = await createFinancingOffer({ job_id: jobId, customer_email: customer.email ?? undefined, customer_phone: customer.phone ?? undefined });
  await upsertAction(ctx.siteId, ctx.planId, item, { status: 'financing', job_id: jobId, financing_offer_id: offer.offer_id });
  return offer.application_url;
}

/** Warranty: opens a claim packet prefilled from the unit and the failure signal. */
export async function createWarrantyClaimFromItem(
  ctx: HandoffContext,
  item: CapitalItem,
  unit: { make: string | null; model: string | null; serial_number: string | null; install_date: string | null; warranty_expires_at: string | null },
): Promise<string> {
  if (!item.equipmentId) throw new Error('Warranty claims need a unit on record.');
  const [owner, customer] = await Promise.all([ownerId(), fetchCustomer(ctx.customerId)]);
  const { data, error } = await supabase
    .from('warranty_claims')
    .insert({
      user_id: owner,
      equipment_id: item.equipmentId,
      job_id: (await fetchCapitalActionJob(ctx.siteId, item.key)) ?? null,
      customer_name: customer.name,
      customer_phone: customer.phone,
      property_address: ctx.siteAddress ?? customer.address,
      manufacturer: unit.make,
      model_number: unit.model,
      serial_number: unit.serial_number,
      failure_description: `${item.title}. ${item.rationale}`.slice(0, 1000),
      install_date: unit.install_date,
      warranty_expires_at: unit.warranty_expires_at,
      status: 'eligible',
    })
    .select('id')
    .single();
  if (error) throw error;
  const claimId = (data as { id: string }).id;
  await upsertAction(ctx.siteId, ctx.planId, item, { warranty_claim_id: claimId });
  return claimId;
}

async function fetchCapitalActionJob(siteId: string, itemKey: string): Promise<string | null> {
  const { data } = await supabase.from('home_capital_actions').select('job_id').eq('site_id', siteId).eq('item_key', itemKey).maybeSingle();
  return (data as { job_id: string | null } | null)?.job_id ?? null;
}
