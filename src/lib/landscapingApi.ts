/**
 * Landscaping pack — Supabase API + hooks.
 *
 * Every read is also filtered by the ACCOUNT OWNER id on top of RLS (team members share the owner's data), and every
 * write goes through RLS-gated tables or SECURITY DEFINER RPCs that re-check the flag + entitlement gate server-side.
 * The client-side gate (`useLandscapingAccess`) only decides what to SHOW; it is never the security boundary.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { useAccountOwnerId } from '@/lib/customFieldsApi';
import {
  LANDSCAPING_ENTITLEMENT,
  LANDSCAPING_FLAG,
  type AddonBilling,
  type AddonKind,
  type BillingContract,
  type ContractSchedule,
  type LandscapeAddon,
  type LandscapeContract,
  type VisitRow,
} from '@/lib/tradePacks/landscaping/index';
import { friendlyLandscapingError, toContract, type ContractListItem, type Pause } from '@/lib/landscapingMappers';

/* ------------------------------------------------------------------ */
/* Access gate                                                          */
/* ------------------------------------------------------------------ */

export interface LandscapingAccess {
  /** True while the flag or the entitlement is still being fetched. */
  loading: boolean;
  allowed: boolean;
}

let entCache: { uid: string; keys: string[] } | null = null;

export function useLandscapingAccess(): LandscapingAccess {
  const { user } = useAuth();
  const flagOn = useFeatureFlag(LANDSCAPING_FLAG);
  const uid = user?.id ?? null;
  const [keys, setKeys] = useState<string[] | null>(entCache && entCache.uid === uid ? entCache.keys : null);

  useEffect(() => {
    if (!uid || !flagOn) return;
    if (entCache && entCache.uid === uid) {
      setKeys(entCache.keys);
      return;
    }
    let cancelled = false;
    void supabase.rpc('get_my_entitlements').then(({ data, error }) => {
      if (cancelled) return;
      const list = !error && Array.isArray(data) ? (data as string[]) : [];
      entCache = { uid, keys: list };
      setKeys(list);
    });
    return () => {
      cancelled = true;
    };
  }, [uid, flagOn]);

  if (!uid) return { loading: false, allowed: false };
  if (!flagOn) return { loading: false, allowed: false };
  if (keys === null) return { loading: true, allowed: false };
  return { loading: false, allowed: keys.includes(LANDSCAPING_ENTITLEMENT) };
}

/* ------------------------------------------------------------------ */
/* Errors + mappers live in landscapingMappers.ts (pure)               */
/* ------------------------------------------------------------------ */

export { friendlyLandscapingError, toContract, contractSchedule, billingContract } from '@/lib/landscapingMappers';
export type { Pause, ContractListItem } from '@/lib/landscapingMappers';

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/* ------------------------------------------------------------------ */
/* Row types + mappers                                                  */
/* ------------------------------------------------------------------ */

export interface Crew {
  id: string;
  name: string;
  lead_technician_id: string | null;
  member_ids: string[];
  default_vehicle_id: string | null;
  active: boolean;
}

export interface Property {
  id: string;
  customer_id: string;
  label: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  lot_sqft: number | null;
  turf_sqft: number | null;
  bed_sqft: number | null;
  hardscape_sqft: number | null;
  edge_ft: number | null;
  slope: 'flat' | 'gentle' | 'steep' | null;
  access_notes: string | null;
  archived_at: string | null;
}

export interface PropertyArea {
  id: string;
  property_id: string;
  name: string;
  area_type: 'turf' | 'bed' | 'hardscape' | 'tree' | 'hedge' | 'driveway' | 'walkway' | 'other';
  sqft: number | null;
  linear_ft: number | null;
  measured_via: 'manual' | 'satellite' | 'wheel' | 'plan';
  measured_on: string | null;
  notes: string | null;
}

export interface VisitWithContext extends VisitRow {
  title: string;
  customer_name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  job_id: string | null;
  attention: string | null;
  weather: { decision?: string; reasons?: string[]; source?: string } | null;
}

export interface VisitTask {
  id: string;
  visit_id: string;
  task_key: string;
  label: string;
  required: boolean;
  state: 'todo' | 'done' | 'na';
  note: string | null;
}

export interface BillingRecord {
  id: string;
  contract_id: string;
  period: string;
  invoice_id: string;
  total_cents: number;
}

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

export async function listContracts(ownerId: string): Promise<ContractListItem[]> {
  const [{ data: rows, error }, { data: pauses, error: pe }] = await Promise.all([
    supabase.from('landscape_contracts').select('*, customer:customers(name)').eq('user_id', ownerId).order('created_at', { ascending: false }).limit(500),
    supabase.from('landscape_contract_pauses').select('id, contract_id, from_date, to_date, reason').eq('user_id', ownerId).limit(2000),
  ]);
  if (error) throw error;
  if (pe) throw pe;
  const byContract = new Map<string, Pause[]>();
  for (const p of (pauses ?? []) as Pause[]) byContract.set(p.contract_id, [...(byContract.get(p.contract_id) ?? []), p]);
  return ((rows ?? []) as Array<Record<string, unknown>>).map((r) => {
    const base = toContract(r);
    const ps = byContract.get(base.id) ?? [];
    return { ...base, pauses: ps.map((p) => ({ from: p.from_date, to: p.to_date })), pauseRows: ps, customer_name: (r.customer as { name?: string } | null)?.name ?? 'Customer' };
  });
}

export async function listCrews(ownerId: string): Promise<Crew[]> {
  const { data, error } = await supabase.from('landscape_crews').select('id, name, lead_technician_id, member_ids, default_vehicle_id, active').eq('user_id', ownerId).order('name').limit(200);
  if (error) throw error;
  return (data ?? []) as Crew[];
}

export async function listProperties(ownerId: string): Promise<Property[]> {
  const { data, error } = await supabase.from('landscape_properties').select('*').eq('user_id', ownerId).is('archived_at', null).order('label').limit(1000);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ...(r as unknown as Property),
    lat: num(r.lat),
    lng: num(r.lng),
    lot_sqft: num(r.lot_sqft),
    turf_sqft: num(r.turf_sqft),
    bed_sqft: num(r.bed_sqft),
    hardscape_sqft: num(r.hardscape_sqft),
    edge_ft: num(r.edge_ft),
  }));
}

export async function listAreas(ownerId: string, propertyId: string): Promise<PropertyArea[]> {
  const { data, error } = await supabase.from('landscape_property_areas').select('*').eq('user_id', ownerId).eq('property_id', propertyId).order('created_at').limit(200);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({ ...(r as unknown as PropertyArea), sqft: num(r.sqft), linear_ft: num(r.linear_ft) }));
}

export async function listAddons(ownerId: string, contractId: string): Promise<LandscapeAddon[]> {
  const { data, error } = await supabase.from('landscape_addons').select('*').eq('user_id', ownerId).eq('contract_id', contractId).order('created_at').limit(50);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    contract_id: r.contract_id as string,
    kind: r.kind as AddonKind,
    label: r.label as string,
    billing: r.billing as AddonBilling,
    price_cents: Number(r.price_cents),
    season_from_month: Number(r.season_from_month),
    season_to_month: Number(r.season_to_month),
    round_months: ((r.round_months as number[] | null) ?? []).map(Number),
    snow_trigger_cm: num(r.snow_trigger_cm),
    active: Boolean(r.active),
  }));
}

const VISIT_SELECT =
  'id, contract_id, addon_id, kind, status, skip_reason, visit_date, scheduled_at, crew_id, crew_size, route_position, planned_minutes, started_at, completed_at, price_cents, billed_invoice_id, job_id, attention, weather,' +
  ' contract:landscape_contracts(title, customer:customers(name, address), property:landscape_properties(address, lat, lng))';

/** Visits in [from, to] (inclusive) with task counts. Bounded: at most 1,500 rows. */
export async function listVisits(ownerId: string, from: string, to: string, crewId?: string | null): Promise<VisitWithContext[]> {
  let q = supabase.from('landscape_visits').select(VISIT_SELECT).eq('user_id', ownerId).gte('visit_date', from).lte('visit_date', to).order('visit_date').order('route_position', { nullsFirst: false }).order('scheduled_at').limit(1500);
  if (crewId) q = q.eq('crew_id', crewId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<Record<string, any>>;
  const ids = rows.map((r) => r.id as string);
  const counts = new Map<string, { total: number; done: number }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: tasks, error: te } = await supabase.from('landscape_visit_tasks').select('visit_id, state').in('visit_id', ids.slice(i, i + 200)).limit(5000);
    if (te) throw te;
    for (const t of (tasks ?? []) as Array<{ visit_id: string; state: string }>) {
      const c = counts.get(t.visit_id) ?? { total: 0, done: 0 };
      c.total += 1;
      if (t.state !== 'todo') c.done += 1;
      counts.set(t.visit_id, c);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    contract_id: r.contract_id,
    addon_id: r.addon_id ?? null,
    kind: r.kind,
    status: r.status,
    skip_reason: r.skip_reason ?? null,
    visit_date: r.visit_date,
    scheduled_at: r.scheduled_at,
    crew_id: r.crew_id ?? null,
    crew_size: Number(r.crew_size),
    route_position: r.route_position ?? null,
    planned_minutes: Number(r.planned_minutes),
    started_at: r.started_at ?? null,
    completed_at: r.completed_at ?? null,
    price_cents: Number(r.price_cents),
    billed_invoice_id: r.billed_invoice_id ?? null,
    tasks_total: counts.get(r.id)?.total ?? 0,
    tasks_done: counts.get(r.id)?.done ?? 0,
    title: r.contract?.title ?? 'Visit',
    customer_name: r.contract?.customer?.name ?? 'Customer',
    address: r.contract?.property?.address ?? r.contract?.customer?.address ?? null,
    lat: num(r.contract?.property?.lat),
    lng: num(r.contract?.property?.lng),
    job_id: r.job_id ?? null,
    attention: r.attention ?? null,
    weather: r.weather ?? null,
  }));
}

export async function listVisitTasks(ownerId: string, visitId: string): Promise<VisitTask[]> {
  const { data, error } = await supabase.from('landscape_visit_tasks').select('id, visit_id, task_key, label, required, state, note').eq('user_id', ownerId).eq('visit_id', visitId).order('label').limit(60);
  if (error) throw error;
  return (data ?? []) as VisitTask[];
}

export async function countVisitPhotos(ownerId: string, jobId: string): Promise<{ before: number; after: number }> {
  const { data, error } = await supabase.from('job_photos').select('kind').eq('user_id', ownerId).eq('job_id', jobId).in('kind', ['before', 'after']).limit(200);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ kind: string }>;
  return { before: rows.filter((r) => r.kind === 'before').length, after: rows.filter((r) => r.kind === 'after').length };
}

export async function listBillingRecords(ownerId: string, period: string): Promise<BillingRecord[]> {
  const { data, error } = await supabase.from('landscape_billing_records').select('id, contract_id, period, invoice_id, total_cents').eq('user_id', ownerId).eq('period', period).limit(1000);
  if (error) throw error;
  return (data ?? []) as BillingRecord[];
}

/** Completed, unbilled visits dated up to `periodEnd` — the input of the billing preview (planBatch). */
export async function listUnbilledVisits(ownerId: string, periodEnd: string): Promise<VisitRow[]> {
  const { data, error } = await supabase
    .from('landscape_visits')
    .select('id, contract_id, addon_id, kind, status, skip_reason, visit_date, scheduled_at, crew_id, crew_size, route_position, planned_minutes, started_at, completed_at, price_cents, billed_invoice_id')
    .eq('user_id', ownerId)
    .eq('status', 'completed')
    .is('billed_invoice_id', null)
    .lte('visit_date', periodEnd)
    .limit(5000);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, any>>).map((r) => ({ ...(r as VisitRow), tasks_total: 0, tasks_done: 0 }));
}

/* ------------------------------------------------------------------ */
/* Writes (RLS tables)                                                  */
/* ------------------------------------------------------------------ */

export type ContractInput = Omit<LandscapeContract, 'id' | 'status' | 'pauses'> & { status?: LandscapeContract['status'] };

function contractRow(c: ContractInput) {
  return {
    customer_id: c.customer_id,
    property_id: c.property_id,
    title: c.title.trim(),
    start_date: c.start_date,
    end_date: c.end_date,
    seasons: c.seasons,
    holiday_policy: c.holiday_policy,
    holiday_set: c.holiday_set,
    extra_holidays: c.extra_holidays,
    workdays: c.workdays,
    preferred_time: c.preferred_time,
    timezone: c.timezone,
    duration_minutes: c.duration_minutes,
    default_crew_id: c.default_crew_id,
    billing_mode: c.billing_mode,
    visit_price_cents: c.visit_price_cents,
    monthly_fee_cents: c.monthly_fee_cents,
    tax_percent: c.tax_percent,
    weather_policy: c.weather_policy,
    checklist: c.checklist,
    require_photos: c.require_photos,
    notes: c.notes?.trim() || null,
  };
}

export async function createContract(input: ContractInput): Promise<string> {
  const { data, error } = await supabase.from('landscape_contracts').insert(contractRow(input)).select('id').single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function updateContract(ownerId: string, id: string, input: ContractInput): Promise<void> {
  const { error } = await supabase.from('landscape_contracts').update(contractRow(input)).eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
}

export async function setContractStatus(ownerId: string, id: string, status: 'active' | 'ended'): Promise<void> {
  const { error } = await supabase.from('landscape_contracts').update({ status }).eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
  if (status === 'active') await generateVisits(id);
}

export async function saveCrew(ownerId: string, crew: Partial<Crew> & { name: string }): Promise<void> {
  const row = { name: crew.name.trim(), lead_technician_id: crew.lead_technician_id ?? null, member_ids: crew.member_ids ?? [], default_vehicle_id: crew.default_vehicle_id ?? null, active: crew.active ?? true };
  const { error } = crew.id ? await supabase.from('landscape_crews').update(row).eq('id', crew.id).eq('user_id', ownerId) : await supabase.from('landscape_crews').insert(row);
  if (error) throw error;
}

export async function saveProperty(ownerId: string, p: Partial<Property> & { customer_id: string; label: string }): Promise<string> {
  const row = {
    customer_id: p.customer_id,
    label: p.label.trim(),
    address: p.address?.trim() || null,
    lat: p.lat ?? null,
    lng: p.lng ?? null,
    lot_sqft: p.lot_sqft ?? null,
    turf_sqft: p.turf_sqft ?? null,
    bed_sqft: p.bed_sqft ?? null,
    hardscape_sqft: p.hardscape_sqft ?? null,
    edge_ft: p.edge_ft ?? null,
    slope: p.slope ?? null,
    access_notes: p.access_notes?.trim() || null,
  };
  if (p.id) {
    const { error } = await supabase.from('landscape_properties').update(row).eq('id', p.id).eq('user_id', ownerId);
    if (error) throw error;
    return p.id;
  }
  const { data, error } = await supabase.from('landscape_properties').insert(row).select('id').single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function saveArea(ownerId: string, a: Partial<PropertyArea> & { property_id: string; name: string }): Promise<void> {
  const row = { property_id: a.property_id, name: a.name.trim(), area_type: a.area_type ?? 'turf', sqft: a.sqft ?? null, linear_ft: a.linear_ft ?? null, measured_via: a.measured_via ?? 'manual', measured_on: a.measured_on ?? null, notes: a.notes?.trim() || null };
  const { error } = a.id ? await supabase.from('landscape_property_areas').update(row).eq('id', a.id).eq('user_id', ownerId) : await supabase.from('landscape_property_areas').insert(row);
  if (error) throw error;
}

export async function deleteArea(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('landscape_property_areas').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
}

export async function saveAddon(ownerId: string, a: Omit<LandscapeAddon, 'id'> & { id?: string }, durationMinutes = 30): Promise<void> {
  const row = {
    contract_id: a.contract_id,
    kind: a.kind,
    label: a.label.trim(),
    billing: a.billing,
    price_cents: a.price_cents,
    duration_minutes: durationMinutes,
    season_from_month: a.season_from_month,
    season_to_month: a.season_to_month,
    round_months: a.round_months,
    snow_trigger_cm: a.kind === 'snow' ? a.snow_trigger_cm : null,
    active: a.active,
  };
  const { error } = a.id ? await supabase.from('landscape_addons').update(row).eq('id', a.id).eq('user_id', ownerId) : await supabase.from('landscape_addons').insert(row);
  if (error) throw error;
}

export async function setEquipment(ownerId: string, crewId: string, date: string, asset: { kind: 'vehicle' | 'tool'; id: string }, assigned: boolean): Promise<void> {
  if (assigned) {
    const { error } = await supabase.from('landscape_equipment_assignments').insert({ crew_id: crewId, service_date: date, asset_kind: asset.kind, vehicle_id: asset.kind === 'vehicle' ? asset.id : null, tool_item_id: asset.kind === 'tool' ? asset.id : null });
    if (error) throw error;
  } else {
    const col = asset.kind === 'vehicle' ? 'vehicle_id' : 'tool_item_id';
    const { error } = await supabase.from('landscape_equipment_assignments').delete().eq('user_id', ownerId).eq('crew_id', crewId).eq('service_date', date).eq(col, asset.id);
    if (error) throw error;
  }
}

export interface EquipmentAssignmentRow {
  id: string;
  crew_id: string;
  asset_kind: 'vehicle' | 'tool';
  vehicle_id: string | null;
  tool_item_id: string | null;
}

export async function listEquipment(ownerId: string, date: string): Promise<EquipmentAssignmentRow[]> {
  const { data, error } = await supabase.from('landscape_equipment_assignments').select('id, crew_id, asset_kind, vehicle_id, tool_item_id').eq('user_id', ownerId).eq('service_date', date).limit(500);
  if (error) throw error;
  return (data ?? []) as EquipmentAssignmentRow[];
}

export async function listVehicles(ownerId: string): Promise<Array<{ id: string; label: string }>> {
  const { data, error } = await supabase.from('vehicles').select('id, label').eq('user_id', ownerId).order('label').limit(200);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; label: string }>;
}

export async function listTools(ownerId: string): Promise<Array<{ id: string; name: string; tool_number: string }>> {
  const { data, error } = await supabase.from('tool_crib_items').select('id, name, tool_number').eq('user_id', ownerId).order('name').limit(500);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; name: string; tool_number: string }>;
}

export async function listTechnicians(ownerId: string): Promise<Array<{ id: string; member_name: string | null; member_email: string }>> {
  const { data, error } = await supabase.from('team_members').select('id, member_name, member_email').eq('account_owner_id', ownerId).eq('invite_status', 'active').order('member_name').limit(200);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; member_name: string | null; member_email: string }>;
}

export async function listCustomers(ownerId: string): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabase.from('customers').select('id, name').eq('user_id', ownerId).order('name').limit(1000);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; name: string }>;
}

/* ------------------------------------------------------------------ */
/* RPCs                                                                 */
/* ------------------------------------------------------------------ */

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export const generateVisits = (contractId?: string, lookahead = 28) => rpc<number>('landscape_generate_my_visits', { p_contract_id: contractId ?? null, p_lookahead: lookahead });
export const pauseContract = (id: string, from: string, to: string | null, reason: string | null) => rpc<string>('landscape_pause_contract', { p_contract_id: id, p_from: from, p_to: to, p_reason: reason });
export const resumeContract = (id: string, resumeDate: string | null) => rpc<void>('landscape_resume_contract', { p_contract_id: id, p_resume_date: resumeDate });
export const cancelPause = (pauseId: string) => rpc<void>('landscape_cancel_pause', { p_pause_id: pauseId });
export const reorderDay = (crewId: string, date: string, ids: string[], reason: string | null) => rpc<{ changed: boolean; order: string[] }>('landscape_reorder_day', { p_crew_id: crewId, p_date: date, p_visit_ids: ids, p_reason: reason, p_buffer_minutes: 10 });
export const reassignVisits = (ids: string[], toCrew: string, reason: string | null) => rpc<number>('landscape_reassign_visits', { p_visit_ids: ids, p_to_crew: toCrew, p_reason: reason });
export const skipForWeather = (visitId: string, reason: string | null, makeupDate: string | null) => rpc<string>('landscape_skip_for_weather', { p_visit_id: visitId, p_reason: reason, p_makeup_date: makeupDate });
export const startVisit = (id: string) => rpc<void>('landscape_start_visit', { p_visit_id: id });
export const setTask = (visitId: string, key: string, state: 'todo' | 'done' | 'na', note: string | null) => rpc<void>('landscape_set_task', { p_visit_id: visitId, p_task_key: key, p_state: state, p_note: note });
export const skipVisit = (id: string, reason: 'manual' | 'crew_unavailable', note: string | null) => rpc<void>('landscape_skip_visit', { p_visit_id: id, p_reason: reason, p_note: note });
export const completeVisit = (id: string) => rpc<{ status: string }>('landscape_complete_visit', { p_visit_id: id });
export const recordSnowEvent = (date: string, cm: number) => rpc<number>('landscape_record_snow_event', { p_date: date, p_snow_cm: cm });
export const runBilling = (period: string, contractIds: string[] | null) =>
  rpc<{ created: number; skipped_existing: number; nothing_to_bill: number; skipped_no_customer: number; total_cents: number }>('landscape_run_billing', { p_period: period, p_contract_ids: contractIds });

/* ------------------------------------------------------------------ */
/* Tiny loader hook                                                     */
/* ------------------------------------------------------------------ */

export interface Loader<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Runs `fn(ownerId)` whenever `deps` change; ignores stale responses. */
export function useLandscapeLoader<T>(fn: (ownerId: string) => Promise<T>, deps: readonly unknown[]): Loader<T> {
  const ownerId = useAccountOwnerId();
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const seq = useRef(0);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!ownerId) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn(ownerId).then(
      (data) => {
        if (mine === seq.current) setState({ data, loading: false, error: null });
      },
      (e) => {
        if (mine === seq.current) setState((s) => ({ data: s.data, loading: false, error: friendlyLandscapingError(e) }));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, tick, ...deps]);

  return { ...state, reload };
}
