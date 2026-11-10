/**
 * Solar pack — Supabase API + hooks. Every query is scoped to the ACCOUNT OWNER id on top of RLS and the DB guards.
 * Status moves go through the SECURITY DEFINER RPCs (clients cannot UPDATE `status` directly).
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAccountOwnerId } from '@/lib/customFieldsApi';
import type { ClaimResolution, ClaimStatus, ClaimCoverage, SolarStageKey, StageStatus } from '@/lib/tradePacks/solarPipeline';
import { emitSolarFinancingEvent, stageEventId } from '@/lib/tradePacks/solarFinancing';

/* ------------------------------ types ------------------------------ */

export interface SolarModuleState {
  flag_on: boolean;
  entitled: boolean;
  active: boolean;
}

export interface SolarJurisdiction {
  id: string;
  name: string;
  ahj_name: string | null;
  utility_name: string | null;
  region: string | null;
  stage_review_days: Partial<Record<SolarStageKey, number>>;
  notes: string | null;
  verified_at: string | null;
  verification_note: string | null;
  archived_at: string | null;
}

export interface SolarProject {
  id: string;
  name: string;
  customer_id: string | null;
  jurisdiction_id: string | null;
  site_address: string | null;
  system_size_kw: number | null;
  status: 'active' | 'on_hold' | 'completed' | 'cancelled';
  monitoring_provider: 'none' | 'mock';
  monitoring_site_ref: string | null;
  financing_ref: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface SolarStage {
  id: string;
  project_id: string;
  stage_key: SolarStageKey;
  position: number;
  status: StageStatus;
  owner_id: string | null;
  due_date: string | null;
  reference_number: string | null;
  notes: string | null;
  started_at: string | null;
  submitted_at: string | null;
  decided_at: string | null;
}

export interface SolarUnit {
  id: string;
  project_id: string;
  component_kind: 'panel' | 'inverter' | 'battery' | 'optimizer' | 'meter' | 'other';
  make: string | null;
  model: string | null;
  quantity: number;
  serials: string[];
  installed_on: string | null;
  warranty_start: string | null;
  product_warranty_years: number | null;
  performance_warranty_years: number | null;
  product_warranty_expires_on: string | null;
  performance_warranty_expires_on: string | null;
  warranty_expires_override: string | null;
  warranty_terms: string | null;
  status: 'active' | 'replaced' | 'removed';
  archived_at: string | null;
}

export interface SolarClaim {
  id: string;
  project_id: string;
  unit_id: string;
  serial: string | null;
  failure_date: string;
  description: string;
  status: ClaimStatus;
  resolution: ClaimResolution | null;
  warranty_state: ClaimCoverage;
  coverage_expires_on: string | null;
  goodwill: boolean;
  manufacturer_reference: string | null;
  owner_id: string | null;
  due_date: string | null;
  recovery_claim_id: string | null;
  created_at: string;
}

export interface WorkflowEvent {
  id: number;
  entity_type: 'stage' | 'claim' | 'project';
  entity_id: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  created_at: string;
}

/* ------------------------------ errors ------------------------------ */

const KNOWN: Array<[RegExp, string]> = [
  [/solar_module_not_available/, 'The Solar module is not enabled for this account.'],
  [/not_permitted/, 'You do not have permission to do that.'],
  [/solar_duplicate_serial/, ''],
  [/solar_(stage|claim|unit|project|jurisdiction)_(invalid|blocked)/, ''],
  [/solar_claim_coverage_(unknown|expired)/, ''],
  [/solar_project_incomplete/, ''],
  [/uq_solar_jurisdiction_name/, 'A jurisdiction profile with that name already exists.'],
  [/duplicate key/, 'That already exists.'],
];

/** Turns database exceptions into short, human messages. */
export function friendlySolarError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : '';
  if (!raw) return fallback;
  for (const [re, msg] of KNOWN) {
    if (re.test(raw)) {
      if (msg) return msg;
      const i = raw.indexOf(':');
      return i >= 0 ? raw.slice(i + 1).trim() : raw;
    }
  }
  return fallback;
}

function owner(id: string | null | undefined): string {
  if (!id) throw new Error('Not signed in.');
  return id;
}

/* ------------------------------ module state ------------------------------ */

export async function fetchSolarModuleState(): Promise<SolarModuleState> {
  const { data, error } = await supabase.rpc('get_solar_module_state');
  if (error) throw error;
  const d = (data ?? {}) as Partial<SolarModuleState>;
  return { flag_on: !!d.flag_on, entitled: !!d.entitled, active: !!d.active };
}

/** Fail-closed: any error means the module is treated as OFF. */
export function useSolarModule() {
  const [state, setState] = useState<SolarModuleState | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    fetchSolarModuleState()
      .then((s) => live && setState(s))
      .catch(() => live && setState({ flag_on: false, entitled: false, active: false }))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);
  return { state, active: !!state?.active, loading };
}

/* ------------------------------ jurisdictions ------------------------------ */

const J_COLS = 'id, name, ahj_name, utility_name, region, stage_review_days, notes, verified_at, verification_note, archived_at';

export async function fetchJurisdictions(ownerId: string | null | undefined): Promise<SolarJurisdiction[]> {
  const { data, error } = await supabase.from('solar_jurisdiction_profiles').select(J_COLS).eq('user_id', owner(ownerId)).is('archived_at', null).order('name');
  if (error) throw error;
  return (data as SolarJurisdiction[]) ?? [];
}

export async function saveJurisdiction(
  ownerId: string | null | undefined,
  input: { name: string; ahj_name: string; utility_name: string; region: string; stage_review_days: Partial<Record<SolarStageKey, number>>; notes: string },
  id?: string,
): Promise<void> {
  const o = owner(ownerId);
  const payload = {
    name: input.name.trim(),
    ahj_name: input.ahj_name.trim() || null,
    utility_name: input.utility_name.trim() || null,
    region: input.region.trim() || null,
    stage_review_days: input.stage_review_days,
    notes: input.notes.trim() || null,
  };
  const { error } = id
    ? await supabase.from('solar_jurisdiction_profiles').update(payload).eq('id', id).eq('user_id', o)
    : await supabase.from('solar_jurisdiction_profiles').insert({ ...payload, user_id: o });
  if (error) throw error;
}

/** Records that the tenant's own team / counsel reviewed the profile. Not a Vireek compliance statement. */
export async function verifyJurisdiction(ownerId: string | null | undefined, id: string, note: string): Promise<void> {
  const { error } = await supabase.from('solar_jurisdiction_profiles').update({ verified_at: new Date().toISOString(), verification_note: note.trim() }).eq('id', id).eq('user_id', owner(ownerId));
  if (error) throw error;
}

/* ------------------------------ projects + stages ------------------------------ */

const P_COLS = 'id, name, customer_id, jurisdiction_id, site_address, system_size_kw, status, monitoring_provider, monitoring_site_ref, financing_ref, notes, archived_at, created_at';
const S_COLS = 'id, project_id, stage_key, position, status, owner_id, due_date, reference_number, notes, started_at, submitted_at, decided_at';

export async function fetchProjects(ownerId: string | null | undefined): Promise<SolarProject[]> {
  const { data, error } = await supabase.from('solar_projects').select(P_COLS).eq('user_id', owner(ownerId)).is('archived_at', null).order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return (data as SolarProject[]) ?? [];
}

export async function createProject(
  ownerId: string | null | undefined,
  input: { name: string; site_address: string; system_size_kw: string; jurisdiction_id: string },
): Promise<string> {
  const kw = Number(input.system_size_kw);
  const { data, error } = await supabase
    .from('solar_projects')
    .insert({
      user_id: owner(ownerId),
      name: input.name.trim(),
      site_address: input.site_address.trim() || null,
      system_size_kw: input.system_size_kw.trim() && Number.isFinite(kw) ? kw : null,
      jurisdiction_id: input.jurisdiction_id || null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function updateProject(ownerId: string | null | undefined, id: string, patch: Partial<Pick<SolarProject, 'status' | 'jurisdiction_id' | 'monitoring_provider' | 'monitoring_site_ref' | 'financing_ref' | 'notes' | 'archived_at'>>): Promise<void> {
  const { error } = await supabase.from('solar_projects').update(patch).eq('id', id).eq('user_id', owner(ownerId));
  if (error) throw error;
}

export async function fetchStages(ownerId: string | null | undefined, projectId: string): Promise<SolarStage[]> {
  const { data, error } = await supabase.from('solar_pipeline_stages').select(S_COLS).eq('user_id', owner(ownerId)).eq('project_id', projectId).order('position');
  if (error) throw error;
  return (data as SolarStage[]) ?? [];
}

export async function updateStageMeta(ownerId: string | null | undefined, id: string, patch: { owner_id?: string | null; due_date?: string | null; reference_number?: string | null; notes?: string | null }): Promise<void> {
  const { error } = await supabase.from('solar_pipeline_stages').update(patch).eq('id', id).eq('user_id', owner(ownerId));
  if (error) throw error;
}

/** Moves a stage via the RPC, then notifies financing hooks (failures there never fail the move). */
export async function setStageStatus(stage: Pick<SolarStage, 'id' | 'project_id' | 'stage_key' | 'status'>, to: StageStatus, note?: string, reference?: string): Promise<void> {
  const { error } = await supabase.rpc('solar_set_stage_status', { p_stage_id: stage.id, p_to: to, p_note: note?.trim() || null, p_reference: reference?.trim() || null });
  if (error) throw error;
  const at = new Date().toISOString();
  void emitSolarFinancingEvent({ type: 'stage_changed', eventId: stageEventId(stage.id, to, at), projectId: stage.project_id, stageKey: stage.stage_key, from: stage.status, to, at });
}

export async function fetchEvents(ownerId: string | null | undefined, projectId: string): Promise<WorkflowEvent[]> {
  const { data, error } = await supabase.from('solar_workflow_events').select('id, entity_type, entity_id, from_status, to_status, note, created_at').eq('user_id', owner(ownerId)).eq('project_id', projectId).order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return (data as WorkflowEvent[]) ?? [];
}

/* ------------------------------ equipment ------------------------------ */

const U_COLS = 'id, project_id, component_kind, make, model, quantity, serials, installed_on, warranty_start, product_warranty_years, performance_warranty_years, product_warranty_expires_on, performance_warranty_expires_on, warranty_expires_override, warranty_terms, status, archived_at';

export async function fetchUnits(ownerId: string | null | undefined, projectId: string): Promise<SolarUnit[]> {
  const { data, error } = await supabase.from('solar_equipment_units').select(U_COLS).eq('user_id', owner(ownerId)).eq('project_id', projectId).is('archived_at', null).order('component_kind');
  if (error) throw error;
  return (data as SolarUnit[]) ?? [];
}

export interface UnitInput {
  component_kind: SolarUnit['component_kind'];
  make: string;
  model: string;
  quantity: string;
  serials: string;
  installed_on: string;
  warranty_start: string;
  product_warranty_years: string;
  performance_warranty_years: string;
  warranty_expires_override: string;
  warranty_terms: string;
}

const toInt = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
};

/** Serials are entered one per line or comma-separated. */
export const parseSerials = (s: string): string[] => s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

export function unitPayload(i: UnitInput) {
  return {
    component_kind: i.component_kind,
    make: i.make.trim() || null,
    model: i.model.trim() || null,
    quantity: toInt(i.quantity) ?? 1,
    serials: parseSerials(i.serials),
    installed_on: i.installed_on || null,
    warranty_start: i.warranty_start || null,
    product_warranty_years: toInt(i.product_warranty_years),
    performance_warranty_years: toInt(i.performance_warranty_years),
    warranty_expires_override: i.warranty_expires_override || null,
    warranty_terms: i.warranty_terms.trim() || null,
  };
}

export async function saveUnit(ownerId: string | null | undefined, projectId: string, input: UnitInput, id?: string): Promise<void> {
  const o = owner(ownerId);
  const payload = unitPayload(input);
  const { error } = id
    ? await supabase.from('solar_equipment_units').update(payload).eq('id', id).eq('user_id', o)
    : await supabase.from('solar_equipment_units').insert({ ...payload, user_id: o, project_id: projectId });
  if (error) throw error;
}

export async function archiveUnit(ownerId: string | null | undefined, id: string): Promise<void> {
  const { error } = await supabase.from('solar_equipment_units').update({ archived_at: new Date().toISOString() }).eq('id', id).eq('user_id', owner(ownerId));
  if (error) throw error;
}

/* ------------------------------ claims ------------------------------ */

const C_COLS = 'id, project_id, unit_id, serial, failure_date, description, status, resolution, warranty_state, coverage_expires_on, goodwill, manufacturer_reference, owner_id, due_date, recovery_claim_id, created_at';

export async function fetchClaims(ownerId: string | null | undefined, projectId: string): Promise<SolarClaim[]> {
  const { data, error } = await supabase.from('solar_warranty_claims').select(C_COLS).eq('user_id', owner(ownerId)).eq('project_id', projectId).order('created_at', { ascending: false });
  if (error) throw error;
  return (data as SolarClaim[]) ?? [];
}

export async function createClaim(ownerId: string | null | undefined, input: { project_id: string; unit_id: string; serial: string; failure_date: string; description: string; goodwill: boolean }): Promise<void> {
  const { error } = await supabase.from('solar_warranty_claims').insert({
    user_id: owner(ownerId),
    project_id: input.project_id,
    unit_id: input.unit_id,
    serial: input.serial.trim() || null,
    failure_date: input.failure_date,
    description: input.description.trim(),
    goodwill: input.goodwill,
  });
  if (error) throw error;
}

export async function setClaimStatus(claimId: string, to: ClaimStatus, opts: { note?: string; resolution?: ClaimResolution | null; reference?: string } = {}): Promise<void> {
  const { error } = await supabase.rpc('solar_set_claim_status', { p_claim_id: claimId, p_to: to, p_note: opts.note?.trim() || null, p_resolution: opts.resolution ?? null, p_reference: opts.reference?.trim() || null });
  if (error) throw error;
}

/* ------------------------------ team lookup ------------------------------ */

export function useSolarOwner() {
  return useAccountOwnerId();
}

/** Small reload helper shared by the panels. */
export function useAsyncData<T>(loader: () => Promise<T>, deps: unknown[], failMsg: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await loader());
      setError(null);
    } catch (e) {
      setError(friendlySolarError(e, failMsg));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, loading, error, reload };
}
