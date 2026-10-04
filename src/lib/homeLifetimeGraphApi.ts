import { supabase } from '@/lib/supabase';
import { fetchPropertyTwin } from '@/lib/propertyTwin';
import type {
  HomeContractor, HomeIntervention, HomeLifetimeGraph, HomeOwnershipPeriod, HomePermit,
  InterventionStatus, NewContractor, NewIntervention, NewPermit, PermitStatus, TransferReason, WarrantyClaimLite,
} from '@/lib/homeLifetimeGraph';

/**
 * IO layer for the Home Lifetime Graph. Keeps src/lib/homeLifetimeGraph.ts pure.
 * The home is resolved by site id alone — never by the current customer — so the
 * graph loads the same way before and after a change of owner.
 */

const CHUNK = 150;

type DbError = { code?: string; message?: string };

export function errorMessage(e: unknown): string {
  const m = (e as { message?: string } | null)?.message;
  return m && m.trim() ? m : 'Something went wrong.';
}

function isMissingRelation(e: DbError): boolean {
  return e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? '');
}

async function fetchChunked<T>(
  ids: string[],
  run: (slice: string[]) => PromiseLike<{ data: unknown; error: DbError | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await run(ids.slice(i, i + CHUNK));
    if (error) throw error;
    out.push(...(((data as T[] | null) ?? [])));
  }
  return out;
}

async function listForSite<T>(table: string, siteId: string, orderBy: string, ascending: boolean): Promise<{ rows: T[]; missing: boolean }> {
  const { data, error } = await supabase.from(table).select('*').eq('site_id', siteId).order(orderBy, { ascending });
  if (error) {
    if (isMissingRelation(error)) return { rows: [], missing: true };
    throw error;
  }
  return { rows: ((data as T[] | null) ?? []), missing: false };
}

export async function fetchHomeLifetimeGraph(siteId: string): Promise<HomeLifetimeGraph | null> {
  const { data: siteRow, error: siteError } = await supabase
    .from('customer_sites').select('customer_id, year_built').eq('id', siteId).maybeSingle();
  if (siteError) throw siteError;
  if (!siteRow) return null;
  const currentCustomerId = (siteRow as { customer_id: string }).customer_id;
  const rawYear = (siteRow as { year_built: number | null }).year_built;

  const twin = await fetchPropertyTwin(currentCustomerId, siteId);
  const equipmentIds = twin.equipment.map((e) => e.id);
  const jobIds = twin.jobs.map((j) => j.id);
  const techIds = [...new Set(twin.jobs.map((j) => j.assigned_technician_id).filter((x): x is string => !!x))];

  const [own, permits, contractors, interventions] = await Promise.all([
    listForSite<Omit<HomeOwnershipPeriod, 'ownerName'>>('home_ownership_periods', siteId, 'started_at', false),
    listForSite<HomePermit>('home_permits', siteId, 'created_at', false),
    listForSite<HomeContractor>('home_contractors', siteId, 'created_at', false),
    listForSite<HomeIntervention>('home_interventions', siteId, 'target_date', true),
  ]);

  const claimSelect = 'id, job_id, equipment_id, status, manufacturer, failure_date, claimed_amount_cents, approved_amount_cents, credit_received_cents, created_at';
  const [claimsByEq, claimsByJob] = await Promise.all([
    fetchChunked<WarrantyClaimLite>(equipmentIds, (s) => supabase.from('warranty_claims').select(claimSelect).in('equipment_id', s)),
    fetchChunked<WarrantyClaimLite>(jobIds, (s) => supabase.from('warranty_claims').select(claimSelect).in('job_id', s)),
  ]);
  const claimMap = new Map<string, WarrantyClaimLite>();
  [...claimsByEq, ...claimsByJob].forEach((c) => claimMap.set(c.id, c));

  const customerIds = [...new Set(own.rows.map((p) => p.customer_id).filter((x): x is string => !!x))];
  const ownerNames = new Map<string, string>();
  try {
    const rows = await fetchChunked<{ id: string; name: string }>(customerIds, (s) => supabase.from('customers').select('id, name').in('id', s));
    rows.forEach((r) => ownerNames.set(r.id, r.name));
  } catch { /* names are cosmetic */ }

  const technicianNames: Record<string, string> = {};
  try {
    const rows = await fetchChunked<{ id: string; member_name: string | null }>(techIds, (s) => supabase.from('team_members').select('id, member_name').in('id', s));
    rows.forEach((r) => { if (r.member_name) technicianNames[r.id] = r.member_name; });
  } catch { /* RLS may hide team members from some roles */ }

  return {
    twin,
    siteId,
    currentCustomerId,
    yearBuilt: typeof rawYear === 'number' ? rawYear : null,
    schemaReady: !(own.missing || permits.missing || contractors.missing || interventions.missing),
    ownership: own.rows.map((p) => ({ ...p, ownerName: p.customer_id ? ownerNames.get(p.customer_id) ?? null : null })),
    permits: permits.rows,
    contractors: contractors.rows,
    interventions: interventions.rows,
    warrantyClaims: [...claimMap.values()],
    technicianNames,
  };
}

// ---------------------------------------------------------------- mutations

async function insertRows(table: string, rows: object | object[]): Promise<void> {
  const { error } = await supabase.from(table).insert(rows);
  if (error) throw error;
}

async function updateRow(table: string, id: string, patch: object): Promise<void> {
  const { data, error } = await supabase.from(table).update(patch).eq('id', id).select('id');
  if (error) throw error;
  // RLS can turn a forbidden update into "0 rows, no error" — never report that as saved.
  if (!data || data.length === 0) throw new Error('Nothing was updated.');
}

async function deleteRow(table: string, id: string): Promise<void> {
  const { data, error } = await supabase.from(table).delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('Nothing was deleted.');
}

export const createPermit = (p: NewPermit & { user_id?: never }) => insertRows('home_permits', p);
export const setPermitStatus = (id: string, status: PermitStatus) => updateRow('home_permits', id, { status });
export const deletePermit = (id: string) => deleteRow('home_permits', id);

export const createContractor = (c: NewContractor & { user_id?: never }) => insertRows('home_contractors', c);
export const deleteContractor = (id: string) => deleteRow('home_contractors', id);

export const createInterventions = (rows: NewIntervention[]) => (rows.length ? insertRows('home_interventions', rows) : Promise.resolve());
export const deleteIntervention = (id: string) => deleteRow('home_interventions', id);
export function setInterventionStatus(id: string, status: InterventionStatus): Promise<void> {
  return updateRow('home_interventions', id, {
    status,
    completed_on: status === 'completed' ? new Date().toISOString().slice(0, 10) : null,
  });
}

// ----------------------------------------------------------------- transfer

export async function fetchTransferCandidates(excludeCustomerId: string): Promise<Array<{ id: string; name: string; phone: string | null }>> {
  const { data, error } = await supabase
    .from('customers').select('id, name, phone').neq('id', excludeCustomerId).order('name').limit(500);
  if (error) throw error;
  return (data as Array<{ id: string; name: string; phone: string | null }> | null) ?? [];
}

const TRANSFER_ERRORS: Record<string, string> = {
  not_allowed: 'Only an account owner or admin can transfer a home.',
  home_not_found: 'This home could not be found.',
  customer_not_found: 'The selected new owner could not be found.',
  already_current_owner: 'That customer already owns this home.',
  invalid_effective_date: 'The transfer date cannot be in the future.',
  invalid_reason: 'Choose a valid transfer reason.',
};

export async function transferHomeOwnership(input: {
  siteId: string; newCustomerId: string; effectiveDate: string; reason: TransferReason; notes: string;
}): Promise<{ equipmentMoved: number }> {
  const { data, error } = await supabase.rpc('transfer_home_ownership', {
    p_site_id: input.siteId,
    p_new_customer_id: input.newCustomerId,
    p_effective_date: input.effectiveDate,
    p_reason: input.reason,
    p_notes: input.notes.trim() || null,
  });
  if (error) {
    const key = Object.keys(TRANSFER_ERRORS).find((k) => (error.message ?? '').includes(k));
    throw new Error(key ? TRANSFER_ERRORS[key] : errorMessage(error));
  }
  return { equipmentMoved: Number((data as { equipment_moved?: number } | null)?.equipment_moved ?? 0) };
}
