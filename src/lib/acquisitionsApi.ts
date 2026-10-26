import { supabase } from '@/lib/supabase';
import {
  normalizeAcquisition, normalizeActual, normalizeCheck, normalizeControl, normalizeDep, normalizeList, normalizePortfolio, normalizeReport,
  normalizeSynergy, normalizeWorkstream, num, parseMoneyToCents,
  type Acquisition, type AcquisitionStatus, type ControlKey, type DataCheck, type Dep, type KpiKey, type KpiReport, type NewAcquisitionDraft,
  type Portfolio, type SourceControl, type Synergy, type SynergyActual, type SynergyDraft, type Workstream, type WorkstreamStatus,
} from '@/lib/acquisitions';

/**
 * Data access for /dashboard/acquisitions. RLS (user_id = get_account_owner_id() AND can_manage_acquisitions()) is the real
 * gate; every query is ALSO scoped to the account owner id so a mistake here can never widen it.
 * Schema + rules: supabase/migrations/20271115000000_acquisition_integration_toolkit.sql
 */

const ACQ_COLUMNS = 'id, name, legal_name, status, close_date, scope_kind, franchise_location_id, brand_id, location_id, purchase_price_cents, currency, target_jobs_per_tech_day, notes';
const WS_COLUMNS = 'id, acquisition_id, kind, title, description, phase, owner_member_id, owner_label, due_date, status, sort_order, notes, completed_at';
const CTL_COLUMNS = 'id, acquisition_id, metric_key, source_value, tolerance_pct, source_label, as_of';
const CHK_COLUMNS = 'id, run_id, check_key, label, status, source_value, actual_value, diff, diff_pct, tolerance_pct, detail, checked_at';
const SYN_COLUMNS = 'id, acquisition_id, kind, category, title, plan_annual_cents, start_date, status, notes';
const ACT_COLUMNS = 'id, synergy_id, period_month, actual_cents, note';

const emptyToNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());
function must<T>(row: T | null | undefined, what: string): T {
  if (row == null) throw new Error(`acq_not_found: ${what}`);
  return row;
}

// ------------------------------------------------------------------------------------------------ reads
export async function fetchPortfolio(): Promise<Portfolio> {
  const { data, error } = await supabase.rpc('acq_portfolio');
  if (error) throw error;
  return normalizePortfolio(data);
}

export interface AcquisitionBundle {
  acquisition: Acquisition;
  workstreams: Workstream[];
  deps: Dep[];
  controls: SourceControl[];
  checks: DataCheck[];
  synergies: Synergy[];
  actuals: SynergyActual[];
  linkedImportIds: string[];
}

export async function fetchAcquisition(id: string, ownerId: string): Promise<AcquisitionBundle | null> {
  const head = await supabase.from('acquisitions').select(ACQ_COLUMNS).eq('id', id).eq('user_id', ownerId).maybeSingle();
  if (head.error) throw head.error;
  const acquisition = normalizeAcquisition(head.data);
  if (!acquisition) return null;

  const [ws, ctl, chk, syn, links] = await Promise.all([
    supabase.from('acquisition_workstreams').select(WS_COLUMNS).eq('acquisition_id', id).eq('user_id', ownerId).order('sort_order', { ascending: true }).limit(500),
    supabase.from('acquisition_source_controls').select(CTL_COLUMNS).eq('acquisition_id', id).eq('user_id', ownerId).limit(20),
    supabase.from('acquisition_data_checks').select(CHK_COLUMNS).eq('acquisition_id', id).eq('user_id', ownerId).order('checked_at', { ascending: false }).limit(300),
    supabase.from('acquisition_synergies').select(SYN_COLUMNS).eq('acquisition_id', id).eq('user_id', ownerId).order('created_at', { ascending: true }).limit(300),
    supabase.from('acquisition_import_links').select('import_job_id').eq('acquisition_id', id).eq('user_id', ownerId).limit(200),
  ]);
  for (const r of [ws, ctl, chk, syn, links]) if (r.error) throw r.error;

  const workstreams = normalizeList(ws.data, normalizeWorkstream);
  const synergies = normalizeList(syn.data, normalizeSynergy);
  const wsIds = workstreams.map((w) => w.id);
  const synIds = synergies.map((s) => s.id);
  const [deps, acts] = await Promise.all([
    wsIds.length ? supabase.from('acquisition_workstream_deps').select('workstream_id, depends_on_id').eq('user_id', ownerId).in('workstream_id', wsIds).limit(2000) : Promise.resolve({ data: [], error: null }),
    synIds.length ? supabase.from('acquisition_synergy_actuals').select(ACT_COLUMNS).eq('user_id', ownerId).in('synergy_id', synIds).order('period_month', { ascending: true }).limit(5000) : Promise.resolve({ data: [], error: null }),
  ]);
  if (deps.error) throw deps.error;
  if (acts.error) throw acts.error;

  return {
    acquisition, workstreams, synergies,
    deps: normalizeList(deps.data, normalizeDep),
    controls: normalizeList(ctl.data, normalizeControl),
    checks: normalizeList(chk.data, normalizeCheck),
    actuals: normalizeList(acts.data, normalizeActual),
    linkedImportIds: ((links.data ?? []) as { import_job_id?: unknown }[]).map((l) => l.import_job_id).filter((v): v is string => typeof v === 'string'),
  };
}

/** Slow (cross-tenant aggregation) so it is fetched separately from the bundle. */
export async function fetchKpiReport(id: string): Promise<KpiReport> {
  const { data, error } = await supabase.rpc('acq_kpi_report', { p_acq: id });
  if (error) throw error;
  const report = normalizeReport(data);
  if (!report) throw new Error('acq_not_found: report');
  return report;
}

export interface LinkOptions {
  brands: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  franchiseLocations: { id: string; label: string }[];
  members: { id: string; name: string }[];
  /** import_job_id -> acquisition_id for every link in the account (a run can belong to only one acquisition). */
  allLinks: Record<string, string>;
}

export async function fetchLinkOptions(ownerId: string): Promise<LinkOptions> {
  const [brands, locations, franchise, members, links] = await Promise.all([
    supabase.from('business_brands').select('id, name').eq('user_id', ownerId).order('name', { ascending: true }).limit(200),
    supabase.from('business_locations').select('id, name').eq('user_id', ownerId).neq('status', 'archived').order('name', { ascending: true }).limit(200),
    supabase.from('franchise_locations').select('id, label, status, franchise_groups!inner(owner_id)').eq('status', 'active').eq('franchise_groups.owner_id', ownerId).limit(200),
    supabase.from('team_members').select('id, member_name, member_email').eq('account_owner_id', ownerId).limit(200),
    supabase.from('acquisition_import_links').select('import_job_id, acquisition_id').eq('user_id', ownerId).limit(1000),
  ]);
  // Franchise is HQ-owner only; a team member simply sees no linkable accounts, which is not an error.
  for (const r of [brands, locations, members, links]) if (r.error) throw r.error;
  const pick = <T,>(rows: unknown, fn: (r: Record<string, unknown>) => T | null): T[] => {
    const out: T[] = [];
    for (const r of Array.isArray(rows) ? rows : []) { if (r && typeof r === 'object') { const v = fn(r as Record<string, unknown>); if (v) out.push(v); } }
    return out;
  };
  const allLinks: Record<string, string> = {};
  for (const l of (links.data ?? []) as { import_job_id?: unknown; acquisition_id?: unknown }[]) {
    if (typeof l.import_job_id === 'string' && typeof l.acquisition_id === 'string') allLinks[l.import_job_id] = l.acquisition_id;
  }
  return {
    brands: pick(brands.data, (r) => (typeof r.id === 'string' && typeof r.name === 'string' ? { id: r.id, name: r.name } : null)),
    locations: pick(locations.data, (r) => (typeof r.id === 'string' && typeof r.name === 'string' ? { id: r.id, name: r.name } : null)),
    franchiseLocations: franchise.error ? [] : pick(franchise.data, (r) => (typeof r.id === 'string' && typeof r.label === 'string' ? { id: r.id, label: r.label } : null)),
    members: pick(members.data, (r) => (typeof r.id === 'string' ? { id: r.id, name: (typeof r.member_name === 'string' && r.member_name) || (typeof r.member_email === 'string' ? r.member_email : 'Team member') } : null)),
    allLinks,
  };
}

// ------------------------------------------------------------------------------------------------ acquisitions
export async function createAcquisition(d: NewAcquisitionDraft): Promise<string> {
  const price = d.purchase_price.trim() === '' ? null : parseMoneyToCents(d.purchase_price);
  const { data, error } = await supabase.rpc('create_acquisition', {
    p_name: d.name.trim(), p_legal_name: emptyToNull(d.legal_name), p_close_date: d.close_date, p_scope_kind: d.scope_kind,
    p_franchise_location_id: d.scope_kind === 'linked_account' && d.franchise_location_id ? d.franchise_location_id : null,
    p_brand_id: d.brand_id || null, p_location_id: d.location_id || null, p_purchase_price_cents: price,
    p_currency: d.currency.trim().toUpperCase() || 'USD', p_notes: emptyToNull(d.notes),
  });
  if (error) throw error;
  if (typeof data !== 'string') throw new Error('acq_not_found: acquisition');
  return data;
}

export interface AcquisitionPatch {
  name?: string; status?: AcquisitionStatus; brand_id?: string | null; location_id?: string | null; notes?: string | null; target_jobs_per_tech_day?: number;
}
export async function updateAcquisition(id: string, ownerId: string, patch: AcquisitionPatch): Promise<Acquisition> {
  const { data, error } = await supabase.from('acquisitions').update(patch).eq('id', id).eq('user_id', ownerId).select(ACQ_COLUMNS);
  if (error) throw error;
  return must(normalizeAcquisition(data?.[0]), 'acquisition');
}
export async function deleteAcquisition(id: string, ownerId: string): Promise<void> {
  const { error } = await supabase.from('acquisitions').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
}

// ------------------------------------------------------------------------------------------------ workstreams
export async function setWorkstreamStatus(id: string, ownerId: string, status: WorkstreamStatus): Promise<Workstream> {
  const { data, error } = await supabase.from('acquisition_workstreams').update({ status }).eq('id', id).eq('user_id', ownerId).select(WS_COLUMNS);
  if (error) throw error;
  return must(normalizeWorkstream(data?.[0]), 'workstream');
}
export async function updateWorkstream(id: string, ownerId: string, patch: { owner_member_id?: string | null; owner_label?: string | null; due_date?: string | null; notes?: string | null }): Promise<Workstream> {
  const { data, error } = await supabase.from('acquisition_workstreams').update(patch).eq('id', id).eq('user_id', ownerId).select(WS_COLUMNS);
  if (error) throw error;
  return must(normalizeWorkstream(data?.[0]), 'workstream');
}
export async function createWorkstream(ownerId: string, acquisitionId: string, draft: { title: string; phase: Workstream['phase']; due_date: string }, sortOrder: number): Promise<Workstream> {
  const { data, error } = await supabase.from('acquisition_workstreams')
    .insert({ user_id: ownerId, acquisition_id: acquisitionId, kind: 'custom', title: draft.title.trim(), phase: draft.phase, due_date: draft.due_date || null, sort_order: sortOrder })
    .select(WS_COLUMNS).single();
  if (error) throw error;
  return must(normalizeWorkstream(data), 'workstream');
}
export async function deleteWorkstream(id: string, ownerId: string): Promise<void> {
  const { error } = await supabase.from('acquisition_workstreams').delete().eq('id', id).eq('user_id', ownerId).eq('kind', 'custom');
  if (error) throw error;
}
export async function addDependency(ownerId: string, workstreamId: string, dependsOnId: string): Promise<void> {
  const { error } = await supabase.from('acquisition_workstream_deps').insert({ user_id: ownerId, workstream_id: workstreamId, depends_on_id: dependsOnId });
  if (error) throw error;
}
export async function removeDependency(ownerId: string, workstreamId: string, dependsOnId: string): Promise<void> {
  const { error } = await supabase.from('acquisition_workstream_deps').delete().eq('user_id', ownerId).eq('workstream_id', workstreamId).eq('depends_on_id', dependsOnId);
  if (error) throw error;
}
/** Re-read the acquisition status (the database completes / re-opens it when workstreams change). */
export async function fetchAcquisitionStatus(id: string, ownerId: string): Promise<AcquisitionStatus | null> {
  const { data, error } = await supabase.from('acquisitions').select(ACQ_COLUMNS).eq('id', id).eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return normalizeAcquisition(data)?.status ?? null;
}

// ------------------------------------------------------------------------------------------------ data checks
export async function saveControl(ownerId: string, acquisitionId: string, key: ControlKey, value: number, tolerance: number, label: string, asOf: string): Promise<SourceControl> {
  const { data, error } = await supabase.from('acquisition_source_controls')
    .upsert({ user_id: ownerId, acquisition_id: acquisitionId, metric_key: key, source_value: value, tolerance_pct: tolerance, source_label: emptyToNull(label), as_of: asOf || null }, { onConflict: 'acquisition_id,metric_key' })
    .select(CTL_COLUMNS).single();
  if (error) throw error;
  return must(normalizeControl(data), 'control');
}
export async function deleteControl(id: string, ownerId: string): Promise<void> {
  const { error } = await supabase.from('acquisition_source_controls').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
}
export async function runDataChecks(id: string): Promise<{ pass: number; warn: number; fail: number; skip: number }> {
  const { data, error } = await supabase.rpc('acq_run_data_checks', { p_acq: id });
  const d = (data ?? {}) as Record<string, unknown>;
  if (error) throw error;
  return { pass: num(d.pass) ?? 0, warn: num(d.warn) ?? 0, fail: num(d.fail) ?? 0, skip: num(d.skip) ?? 0 };
}
export async function linkImportJob(ownerId: string, acquisitionId: string, importJobId: string): Promise<void> {
  const { error } = await supabase.from('acquisition_import_links').insert({ user_id: ownerId, acquisition_id: acquisitionId, import_job_id: importJobId });
  if (error) throw error;
}
export async function unlinkImportJob(ownerId: string, importJobId: string): Promise<void> {
  const { error } = await supabase.from('acquisition_import_links').delete().eq('user_id', ownerId).eq('import_job_id', importJobId);
  if (error) throw error;
}

// ------------------------------------------------------------------------------------------------ baseline
export async function saveBaseline(id: string, metrics: Partial<Record<KpiKey, number>>, asOf: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('acq_save_baseline', { p_acq: id, p_metrics: metrics, p_as_of: asOf, p_note: emptyToNull(note) });
  if (error) throw error;
}
export async function captureBaseline(id: string): Promise<void> {
  const { error } = await supabase.rpc('acq_capture_baseline', { p_acq: id });
  if (error) throw error;
}

// ------------------------------------------------------------------------------------------------ synergies
export async function createSynergy(ownerId: string, acquisitionId: string, d: SynergyDraft): Promise<Synergy> {
  const { data, error } = await supabase.from('acquisition_synergies')
    .insert({ user_id: ownerId, acquisition_id: acquisitionId, kind: d.kind, category: d.category, title: d.title.trim(), plan_annual_cents: parseMoneyToCents(d.plan_annual) ?? 0, start_date: d.start_date, status: d.status, notes: emptyToNull(d.notes) })
    .select(SYN_COLUMNS).single();
  if (error) throw error;
  return must(normalizeSynergy(data), 'synergy');
}
export async function setSynergyStatus(id: string, ownerId: string, status: Synergy['status']): Promise<Synergy> {
  const { data, error } = await supabase.from('acquisition_synergies').update({ status }).eq('id', id).eq('user_id', ownerId).select(SYN_COLUMNS);
  if (error) throw error;
  return must(normalizeSynergy(data?.[0]), 'synergy');
}
export async function deleteSynergy(id: string, ownerId: string): Promise<void> {
  const { error } = await supabase.from('acquisition_synergies').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
}
export async function saveActual(ownerId: string, synergyId: string, month: string, cents: number, note: string): Promise<SynergyActual> {
  const { data, error } = await supabase.from('acquisition_synergy_actuals')
    .upsert({ user_id: ownerId, synergy_id: synergyId, period_month: `${month}-01`, actual_cents: cents, note: emptyToNull(note) }, { onConflict: 'synergy_id,period_month' })
    .select(ACT_COLUMNS).single();
  if (error) throw error;
  return must(normalizeActual(data), 'actual');
}
export async function deleteActual(id: string, ownerId: string): Promise<void> {
  const { error } = await supabase.from('acquisition_synergy_actuals').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
}

// ------------------------------------------------------------------------------------------------ errors
interface ErrorLike { message?: unknown; code?: unknown; details?: unknown }
/** Turns a Supabase / Postgres error into a sentence a manager can act on. */
export function describeAcquisitionError(error: unknown): string {
  const e = (error && typeof error === 'object' ? error : {}) as ErrorLike;
  const text = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.details === 'string' ? e.details : ''}`.toLowerCase();
  const code = typeof e.code === 'string' ? e.code : '';
  if (text.includes('failed to fetch') || text.includes('networkerror') || text.includes('network request failed')) return 'Network problem. Check your connection and try again.';
  if (text.includes('acq_forbidden') || code === '42501' || text.includes('row-level security')) return 'You need the “edit business profile” permission (or to be the account owner) to use Acquisitions.';
  if (text.includes('uq_acquisitions_name')) return 'You already have an acquisition with this name.';
  if (text.includes('uq_acquisitions_franchise_location')) return 'That linked account is already used by another acquisition.';
  if (text.includes('acq_dependency_open')) return 'Finish the workstreams this one depends on first.';
  if (text.includes('acq_dependency_cycle')) return 'That dependency would create a loop.';
  if (text.includes('acq_dependency_cross')) return 'Dependencies must stay inside one acquisition.';
  if (text.includes('uq_acq_workstream_kind')) return 'This acquisition already has that workstream.';
  if (text.includes('acq_invalid_name')) return 'Enter a name up to 120 characters.';
  if (text.includes('acq_invalid_close_date')) return 'The closing date must be within the last 10 years or the next 2.';
  if (text.includes('acq_invalid_franchise_location')) return 'That linked account is not active or does not belong to you.';
  if (text.includes('acq_invalid_reference')) return 'The selected brand or location no longer exists.';
  if (text.includes('acq_invalid_baseline')) return 'Check the baseline numbers and date.';
  if (text.includes('acq_no_live_data')) return 'There is no live data to capture yet. Link an import run or a franchise account first.';
  if (text.includes('acq_not_found') || code === 'P0002') return 'This record no longer exists. Refresh the page and try again.';
  if (text.includes('acq_invalid')) return 'Some values are not allowed. Check the form and try again.';
  if (code === '23514') return 'Some values are not allowed. Check the form and try again.';
  if (code === '23505') return 'That record already exists.';
  return 'Something went wrong. Please try again.';
}
