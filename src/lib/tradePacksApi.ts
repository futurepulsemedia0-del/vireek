/**
 * Trade Packs — Supabase API + hooks.
 * Every call is scoped to the ACCOUNT OWNER id (for a team member that is NOT their own user id),
 * on top of RLS and the database guards.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAccountOwnerId } from '@/lib/customFieldsApi';
import {
  cleanLogData,
  getPack,
  type LogData,
  type PackKey,
  type ProductKind,
  type ProductUnit,
  type RateOverrides,
  type TradePack,
  type ChemId,
} from '@/lib/tradePacks';
/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface PackInstall {
  id: string;
  pack_key: PackKey;
  enabled: boolean;
  enforce_credentials: boolean;
  config: { rates?: Record<string, RateOverrides> } & Record<string, unknown>;
  installed_at: string;
}

export interface RegulatedProduct {
  id: string;
  pack_key: PackKey;
  name: string;
  kind: ProductKind;
  unit: ProductUnit;
  epa_reg_number: string | null;
  epa_exempt_25b: boolean;
  active_ingredient: string | null;
  restricted_use: boolean;
  signal_word: 'danger' | 'warning' | 'caution' | null;
  label_max_rate: number | null;
  reentry_hours: number | null;
  sds_url: string | null;
  notes: string | null;
  archived_at: string | null;
  /** Pool pack: which chemical this product is, so dosing recommendations can use it. */
  chem_key: ChemId | null;
  /** Strength of that chemical in percent (e.g. 12.5 for 12.5% liquid chlorine). */
  strength_pct: number | null;
}

export interface ProductInput {
  name: string;
  kind: ProductKind;
  unit: ProductUnit;
  epa_reg_number: string;
  epa_exempt_25b: boolean;
  active_ingredient: string;
  restricted_use: boolean;
  signal_word: '' | 'danger' | 'warning' | 'caution';
  label_max_rate: string;
  reentry_hours: string;
  sds_url: string;
  notes: string;
  chem_key?: ChemId | '';
  strength_pct?: string;
}

export interface TradeLogEntry {
  id: string;
  pack_key: PackKey;
  entry_type: string;
  job_id: string | null;
  customer_id: string | null;
  equipment_id: string | null;
  technician_id: string | null;
  product_id: string | null;
  performed_at: string;
  data: LogData;
  notes: string | null;
  site_address: string | null;
  technician_name: string | null;
  equipment_label: string | null;
  product_name: string | null;
  product_epa_reg: string | null;
  product_restricted: boolean | null;
  reentry_until: string | null;
  credential_type: string | null;
  credential_number: string | null;
  retain_until: string;
  voided_at: string | null;
  void_reason: string | null;
}

export interface NewLogEntry {
  packKey: PackKey;
  entryType: string;
  jobId?: string | null;
  equipmentId?: string | null;
  technicianId?: string | null;
  productId?: string | null;
  performedAt?: string;
  data: LogData;
  notes?: string;
}

export interface TradeRoute {
  id: string;
  pack_key: PackKey;
  name: string;
  weekday: number;
  technician_id: string | null;
  start_time: string;
  active: boolean;
  notes: string | null;
}

export interface RouteStop {
  id: string;
  route_id: string;
  position: number;
  agreement_id: string | null;
  customer_id: string | null;
  label: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  est_minutes: number;
  notes: string | null;
}

export interface TeamOption {
  id: string;
  member_name: string | null;
}

export interface EquipmentOption {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
}

export interface PlanCandidate {
  id: string;
  customer_id: string | null;
  customer_name: string;
  address: string;
  service_type: string | null;
  interval_unit: 'week' | 'month' | 'year';
  interval_count: number;
  start_date: string;
  preferred_technician_id: string | null;
  duration_minutes: number;
  status: string;
}

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

const KNOWN: Array<[RegExp, string]> = [
  [/trade_pack_not_enabled/, 'Turn this pack on first.'],
  [/trade_cert_required/, ''],
  [/trade_label_rate/, ''],
  [/trade_log_invalid/, ''],
  [/trade_product_invalid/, ''],
  [/not_permitted/, 'You do not have permission to manage trade packs.'],
  [/pack_not_installed/, 'This pack is not installed yet.'],
  [/invalid_schema|invalid_field|invalid_form|invalid_payload|unknown_pack/, 'The pack could not be installed (invalid definition).'],
  [/uq_trade_routes_name/, 'A route with that name already exists.'],
  [/uq_trade_products_active_name/, 'A product with that name already exists.'],
  [/duplicate key/, 'That already exists.'],
  [/Only the account owner/, 'Only the account owner can do that.'],
];

/** Turns database exceptions into short, human messages. */
export function friendlyTradePackError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
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

/* ------------------------------------------------------------------ */
/* Installs                                                             */
/* ------------------------------------------------------------------ */

export async function fetchInstalls(ownerId: string | null | undefined): Promise<PackInstall[]> {
  const { data, error } = await supabase
    .from('trade_pack_installs')
    .select('id, pack_key, enabled, enforce_credentials, config, installed_at')
    .eq('user_id', owner(ownerId));
  if (error) throw error;
  return (data as PackInstall[]) ?? [];
}

/** Installs (or re-enables) a pack and seeds its custom fields, forms and checklists atomically. */
export async function installPack(pack: TradePack): Promise<{ fields_added: number; fields_skipped: number; forms_added: number }> {
  const fields = pack.customFields.map((f) => ({
    entity: f.entity,
    key: f.key,
    label: f.label,
    field_type: f.field_type,
    options: f.options ?? [],
    required: !!f.required,
    show_in_table: !!f.show_in_table,
    show_in_filters: !!f.show_in_filters,
  }));
  const forms = pack.forms.map((f) => ({ slug: f.slug, title: f.title, description: f.description, fields: f.fields }));
  const { data, error } = await supabase.rpc('install_trade_pack', { p_pack: pack.key, p_fields: fields, p_forms: forms });
  if (error) throw error;
  return data as { fields_added: number; fields_skipped: number; forms_added: number };
}

export async function updatePack(
  packKey: PackKey,
  patch: { enabled?: boolean; enforceCredentials?: boolean; config?: PackInstall['config'] },
): Promise<void> {
  const { error } = await supabase.rpc('update_trade_pack', {
    p_pack: packKey,
    p_enabled: patch.enabled ?? null,
    p_enforce_credentials: patch.enforceCredentials ?? null,
    p_config: patch.config ?? null,
  });
  if (error) throw error;
}

/** Installs for the current account + a reload callback. `enabled` is the set of switched-on pack keys. */
export function useTradePacks() {
  const ownerId = useAccountOwnerId();
  const [installs, setInstalls] = useState<PackInstall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ownerId) return;
    try {
      setInstalls(await fetchInstalls(ownerId));
      setError(null);
    } catch (e) {
      setError(friendlyTradePackError(e, 'Could not load trade packs.'));
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const enabled = new Set(installs.filter((i) => i.enabled).map((i) => i.pack_key));
  return { ownerId, installs, enabled, loading, error, reload };
}

/* ------------------------------------------------------------------ */
/* Products                                                             */
/* ------------------------------------------------------------------ */

const PRODUCT_COLS =
  'id, pack_key, name, kind, unit, epa_reg_number, epa_exempt_25b, active_ingredient, restricted_use, signal_word, label_max_rate, reentry_hours, sds_url, notes, archived_at, chem_key, strength_pct';

export async function fetchProducts(ownerId: string | null | undefined, packKey: PackKey, includeArchived = false): Promise<RegulatedProduct[]> {
  let q = supabase.from('trade_regulated_products').select(PRODUCT_COLS).eq('user_id', owner(ownerId)).eq('pack_key', packKey).order('name');
  if (!includeArchived) q = q.is('archived_at', null);
  const { data, error } = await q;
  if (error) throw error;
  return (data as RegulatedProduct[]) ?? [];
}

const num = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function productPayload(input: ProductInput) {
  return {
    name: input.name.trim(),
    kind: input.kind,
    unit: input.unit,
    epa_reg_number: input.epa_reg_number.trim() || null,
    epa_exempt_25b: input.epa_exempt_25b,
    active_ingredient: input.active_ingredient.trim() || null,
    restricted_use: input.restricted_use,
    signal_word: input.signal_word || null,
    label_max_rate: num(input.label_max_rate),
    reentry_hours: num(input.reentry_hours),
    sds_url: input.sds_url.trim() || null,
    notes: input.notes.trim() || null,
    chem_key: input.chem_key || null,
    strength_pct: input.chem_key ? num(input.strength_pct ?? '') : null,
  };
}
export async function saveProduct(ownerId: string | null | undefined, packKey: PackKey, input: ProductInput, id?: string): Promise<void> {
  const o = owner(ownerId);
  const payload = productPayload(input);
  const { error } = id
    ? await supabase.from('trade_regulated_products').update(payload).eq('id', id).eq('user_id', o)
    : await supabase.from('trade_regulated_products').insert({ ...payload, user_id: o, pack_key: packKey });
  if (error) throw error;
}

export async function setProductArchived(ownerId: string | null | undefined, id: string, archived: boolean): Promise<void> {
  const { error } = await supabase
    .from('trade_regulated_products')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('user_id', owner(ownerId));
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Compliance log                                                       */
/* ------------------------------------------------------------------ */

const LOG_COLS =
  'id, pack_key, entry_type, job_id, customer_id, equipment_id, technician_id, product_id, performed_at, data, notes, site_address, technician_name, equipment_label, product_name, product_epa_reg, product_restricted, reentry_until, credential_type, credential_number, retain_until, voided_at, void_reason';

export interface LogQuery {
  packKey: PackKey;
  jobId?: string;
  customerId?: string;
  equipmentId?: string;
  productId?: string;
  entryType?: string;
  limit?: number;
}

export async function fetchLogEntries(ownerId: string | null | undefined, q: LogQuery): Promise<TradeLogEntry[]> {
  let query = supabase
    .from('trade_log_entries')
    .select(LOG_COLS)
    .eq('user_id', owner(ownerId))
    .eq('pack_key', q.packKey)
    .order('performed_at', { ascending: false })
    .limit(Math.min(q.limit ?? 200, 1000));
  if (q.jobId) query = query.eq('job_id', q.jobId);
  if (q.customerId) query = query.eq('customer_id', q.customerId);
  if (q.equipmentId) query = query.eq('equipment_id', q.equipmentId);
  if (q.productId) query = query.eq('product_id', q.productId);
  if (q.entryType) query = query.eq('entry_type', q.entryType);
  const { data, error } = await query;
  if (error) throw error;
  return (data as TradeLogEntry[]) ?? [];
}

export async function addLogEntry(ownerId: string | null | undefined, e: NewLogEntry): Promise<void> {
  const { error } = await supabase.from('trade_log_entries').insert({
    user_id: owner(ownerId),
    pack_key: e.packKey,
    entry_type: e.entryType,
    job_id: e.jobId ?? null,
    equipment_id: e.equipmentId ?? null,
    technician_id: e.technicianId ?? null,
    product_id: e.productId ?? null,
    performed_at: e.performedAt ?? new Date().toISOString(),
    data: cleanLogData(e.data),
    notes: e.notes?.trim() || null,
  });
  if (error) throw error;
}

export async function voidLogEntry(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_trade_log_entry', { p_id: id, p_reason: reason });
  if (error) throw error;
}

/** Plain-text export of a ledger for inspectors / audits (one row per entry, voided rows flagged). */
export function ledgerToCsv(entries: TradeLogEntry[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['performed_at', 'entry_type', 'site_address', 'technician', 'licence_type', 'licence_number', 'product', 'epa_reg_no', 'restricted_use', 'equipment', 'data', 'notes', 'retain_until', 'voided', 'void_reason'];
  const rows = entries.map((e) =>
    [e.performed_at, e.entry_type, e.site_address, e.technician_name, e.credential_type, e.credential_number, e.product_name, e.product_epa_reg, e.product_restricted, e.equipment_label, e.data, e.notes, e.retain_until, e.voided_at ? 'yes' : '', e.void_reason]
      .map(esc)
      .join(','),
  );
  return [head.join(','), ...rows].join('\n');
}

/* ------------------------------------------------------------------ */
/* Lookups                                                              */
/* ------------------------------------------------------------------ */

export async function fetchTeam(ownerId: string | null | undefined): Promise<TeamOption[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, member_name')
    .eq('account_owner_id', owner(ownerId))
    .eq('invite_status', 'active')
    .order('member_name');
  if (error) throw error;
  return (data as TeamOption[]) ?? [];
}

export async function fetchCustomerEquipment(ownerId: string | null | undefined, customerId: string): Promise<EquipmentOption[]> {
  const { data, error } = await supabase
    .from('equipment')
    .select('id, equipment_type, make, model, serial_number')
    .eq('user_id', owner(ownerId))
    .eq('customer_id', customerId)
    .eq('status', 'active')
    .order('equipment_type');
  if (error) throw error;
  return (data as EquipmentOption[]) ?? [];
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */

export async function fetchRoutes(ownerId: string | null | undefined, packKey: PackKey): Promise<{ routes: TradeRoute[]; stops: RouteStop[] }> {
  const o = owner(ownerId);
  const [r, s] = await Promise.all([
    supabase.from('trade_routes').select('id, pack_key, name, weekday, technician_id, start_time, active, notes').eq('user_id', o).eq('pack_key', packKey).order('weekday').order('name'),
    supabase.from('trade_route_stops').select('id, route_id, position, agreement_id, customer_id, label, address, lat, lng, est_minutes, notes').eq('user_id', o).order('position'),
  ]);
  if (r.error) throw r.error;
  if (s.error) throw s.error;
  const routes = (r.data as TradeRoute[]) ?? [];
  const ids = new Set(routes.map((x) => x.id));
  return { routes, stops: ((s.data as RouteStop[]) ?? []).filter((x) => ids.has(x.route_id)) };
}

export async function createRoute(
  ownerId: string | null | undefined,
  input: { packKey: PackKey; name: string; weekday: number; technicianId: string | null; startTime: string },
): Promise<string> {
  const { data, error } = await supabase
    .from('trade_routes')
    .insert({ user_id: owner(ownerId), pack_key: input.packKey, name: input.name.trim(), weekday: input.weekday, technician_id: input.technicianId, start_time: input.startTime })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function deleteRoute(ownerId: string | null | undefined, id: string): Promise<void> {
  const { error } = await supabase.from('trade_routes').delete().eq('id', id).eq('user_id', owner(ownerId));
  if (error) throw error;
}

export async function addStops(
  ownerId: string | null | undefined,
  routeId: string,
  startPosition: number,
  stops: Array<{ agreementId?: string | null; customerId?: string | null; label: string; address?: string | null; lat?: number | null; lng?: number | null; minutes: number }>,
): Promise<void> {
  if (!stops.length) return;
  const o = owner(ownerId);
  const { error } = await supabase.from('trade_route_stops').insert(
    stops.map((s, i) => ({
      user_id: o,
      route_id: routeId,
      position: startPosition + i,
      agreement_id: s.agreementId ?? null,
      customer_id: s.customerId ?? null,
      label: s.label,
      address: s.address ?? null,
      lat: s.lat ?? null,
      lng: s.lng ?? null,
      est_minutes: s.minutes,
    })),
  );
  if (error) throw error;
}

export async function removeStop(ownerId: string | null | undefined, stopId: string): Promise<void> {
  const { error } = await supabase.from('trade_route_stops').delete().eq('id', stopId).eq('user_id', owner(ownerId));
  if (error) throw error;
}

export async function reorderStops(routeId: string, orderedStopIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('reorder_trade_route_stops', { p_route_id: routeId, p_stop_ids: orderedStopIds });
  if (error) throw error;
}

export async function fetchPlanCandidates(ownerId: string | null | undefined): Promise<PlanCandidate[]> {
  const { data, error } = await supabase
    .from('recurring_agreements')
    .select('id, customer_id, customer_name, address, service_type, interval_unit, interval_count, start_date, preferred_technician_id, duration_minutes, status')
    .eq('user_id', owner(ownerId))
    .eq('status', 'active')
    .limit(1000);
  if (error) throw error;
  return (data as PlanCandidate[]) ?? [];
}

/** The pack a rate-override set belongs to is read from install.config.rates[modelKey]. */
export function ratesFor(install: PackInstall | undefined, modelKey: string): RateOverrides | undefined {
  return install?.config?.rates?.[modelKey];
}

export { getPack };
