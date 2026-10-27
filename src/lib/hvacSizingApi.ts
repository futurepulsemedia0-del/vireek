import { supabase } from '@/lib/supabase';
import {
  parseMatchupRow,
  type AhriMatchup,
  type DoeRegion,
  type MatchupInput,
} from '@/lib/ahriMatchup';

/**
 * Thin RPC layer for the HVAC sizing panel on /dashboard/quotes/:id.
 * Every write goes through a SECURITY DEFINER function that re-checks the
 * caller's account and can_view_billing, so a missing client gate can never leak
 * or alter data.
 */

type Failure = { message?: string; code?: string } | null;

export type SizingFailureReason = 'forbidden' | 'not_found' | 'invalid_state' | 'failed';
export type Result<T> = { ok: true; data: T } | { ok: false; reason: SizingFailureReason; detail?: string };

function isForbidden(err: Failure): boolean {
  return err?.code === '42501' || /forbidden/i.test(err?.message ?? '');
}
function isNotFound(err: Failure): boolean {
  return err?.code === 'P0002' || /(quote|matchup)_not_found/i.test(err?.message ?? '');
}

function fail(err: Failure): { ok: false; reason: SizingFailureReason; detail?: string } {
  if (isForbidden(err)) return { ok: false, reason: 'forbidden' };
  if (isNotFound(err)) return { ok: false, reason: 'not_found' };
  const msg = err?.message ?? '';
  if (/quote_not_editable|quote_is_tiered|no_selection|price_required/i.test(msg)) {
    return { ok: false, reason: 'invalid_state', detail: (/(quote_not_editable|quote_is_tiered|no_selection|price_required)/i.exec(msg)?.[1] ?? '').toLowerCase() };
  }
  return { ok: false, reason: 'failed' };
}

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export interface SavedSizing {
  load_inputs: unknown;
  load_result: unknown;
  duct_inputs: unknown;
  duct_result: unknown;
  region: DoeRegion | null;
  selected_matchup_id: string | null;
  selection_snapshot: AhriMatchup | null;
  updated_at: string | null;
}

export interface QuoteSizingState {
  quoteStatus: string;
  tiered: boolean;
  sizing: SavedSizing | null;
}

export interface ImportOutcome {
  inserted: number;
  updated: number;
  rejected: { index: number; reason: string }[];
}

const MATCHUP_COLUMNS =
  'id, ahri_ref_number, manufacturer, brand, system_type, staging, outdoor_model, indoor_model, furnace_model, cooling_btuh, seer2, eer2, hspf2, heating_47_btuh, heating_17_btuh, furnace_output_btuh, shr, airflow_cfm, refrigerant, sell_price_cents, ahri_status, verified_at, active, notes, created_at, updated_at';

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseQuoteSizingState(raw: unknown): QuoteSizingState | null {
  if (!isRec(raw)) return null;
  const s = raw.sizing;
  let sizing: SavedSizing | null = null;
  if (isRec(s)) {
    const region = s.region === 'north' || s.region === 'south' || s.region === 'southwest' ? s.region : null;
    sizing = {
      load_inputs: s.load_inputs ?? null,
      load_result: s.load_result ?? null,
      duct_inputs: s.duct_inputs ?? null,
      duct_result: s.duct_result ?? null,
      region,
      selected_matchup_id: typeof s.selected_matchup_id === 'string' ? s.selected_matchup_id : null,
      selection_snapshot: parseMatchupRow(s.selection_snapshot),
      updated_at: typeof s.updated_at === 'string' ? s.updated_at : null,
    };
  }
  return {
    quoteStatus: typeof raw.quote_status === 'string' ? raw.quote_status : 'draft',
    tiered: raw.tiered === true,
    sizing,
  };
}

// ------------------------------------------------------------
// Catalog
// ------------------------------------------------------------

export async function fetchMatchups(): Promise<Result<AhriMatchup[]>> {
  const { data, error } = await supabase
    .from('hvac_ahri_matchups')
    .select(MATCHUP_COLUMNS)
    .order('cooling_btuh', { ascending: true })
    .order('seer2', { ascending: false })
    .limit(2000);
  if (error) return fail(error);
  const rows = (Array.isArray(data) ? data : []).map(parseMatchupRow).filter((m): m is AhriMatchup => m !== null);
  return { ok: true, data: rows };
}

export async function importMatchups(rows: MatchupInput[]): Promise<Result<ImportOutcome>> {
  const { data, error } = await supabase.rpc('hvac_upsert_matchups', { p_rows: rows });
  if (error) return fail(error);
  if (!isRec(data)) return { ok: false, reason: 'failed' };
  const rejected = Array.isArray(data.rejected)
    ? data.rejected.filter(isRec).map((r) => ({
        index: typeof r.index === 'number' ? r.index : 0,
        reason: typeof r.reason === 'string' ? r.reason : 'The row could not be saved.',
      }))
    : [];
  return {
    ok: true,
    data: {
      inserted: typeof data.inserted === 'number' ? data.inserted : 0,
      updated: typeof data.updated === 'number' ? data.updated : 0,
      rejected,
    },
  };
}

async function boolRpc(fn: string, args: Record<string, unknown>): Promise<Result<true>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return fail(error);
  return data === true ? { ok: true, data: true } : { ok: false, reason: 'not_found' };
}

export const setMatchupVerified = (id: string, verified: boolean) =>
  boolRpc('hvac_set_matchup_verified', { p_id: id, p_verified: verified });
export const setMatchupActive = (id: string, active: boolean) =>
  boolRpc('hvac_set_matchup_active', { p_id: id, p_active: active });
export const deleteMatchup = (id: string) => boolRpc('hvac_delete_matchup', { p_id: id });

// ------------------------------------------------------------
// Per-quote sizing
// ------------------------------------------------------------

export async function fetchQuoteSizing(quoteId: string): Promise<Result<QuoteSizingState>> {
  const { data, error } = await supabase.rpc('get_quote_hvac_sizing', { p_quote_id: quoteId });
  if (error) return fail(error);
  if (data == null) return { ok: false, reason: 'not_found' };
  const parsed = parseQuoteSizingState(data);
  return parsed ? { ok: true, data: parsed } : { ok: false, reason: 'failed' };
}

export interface SizingPayload {
  loadInputs?: unknown;
  loadResult?: unknown;
  ductInputs?: unknown;
  ductResult?: unknown;
  region?: DoeRegion | null;
}

/** Omitted fields keep whatever is already saved. */
export async function saveQuoteSizing(quoteId: string, p: SizingPayload): Promise<Result<string>> {
  const { data, error } = await supabase.rpc('save_quote_hvac_sizing', {
    p_quote_id: quoteId,
    p_load_inputs: p.loadInputs ?? null,
    p_load_result: p.loadResult ?? null,
    p_duct_inputs: p.ductInputs ?? null,
    p_duct_result: p.ductResult ?? null,
    p_region: p.region ?? null,
  });
  if (error) return fail(error);
  return { ok: true, data: typeof data === 'string' ? data : new Date().toISOString() };
}

export const selectQuoteMatchup = (quoteId: string, matchupId: string | null) =>
  boolRpc('select_quote_hvac_matchup', { p_quote_id: quoteId, p_matchup_id: matchupId });

export async function applyMatchupToQuote(
  quoteId: string,
  unitPriceCents: number | null,
): Promise<Result<{ added: boolean }>> {
  const { data, error } = await supabase.rpc('apply_hvac_matchup_to_quote', {
    p_quote_id: quoteId,
    p_unit_price_cents: unitPriceCents,
  });
  if (error) return fail(error);
  return isRec(data) ? { ok: true, data: { added: data.added === true } } : { ok: false, reason: 'failed' };
}
