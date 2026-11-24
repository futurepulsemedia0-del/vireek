/**
 * Sales pipeline — data access. Everything is account-scoped by RLS (user_id = get_account_owner_id()); the rules that
 * matter (discount approval level, self-approval, who may decide) are enforced by database triggers
 * (supabase/migrations/20290306000100_sales_pipeline.sql). This layer only maps database errors to stable codes.
 */
import { supabase } from '@/lib/supabase';
import type {
  DealDeskSettings, DiscountRequest, ForecastCategory, PipelineDeal, PipelineStage,
} from '@/lib/salesPipeline';

export type SalesPipelineErrorCode =
  | 'forbidden' | 'invalid' | 'discount_requires_approval' | 'deal_desk_disabled' | 'deal_not_found'
  | 'self_approval' | 'owner_required' | 'closed' | 'duplicate_pending' | 'note_required' | 'unknown';

export class SalesPipelineApiError extends Error {
  constructor(public readonly code: SalesPipelineErrorCode) {
    super(code);
    this.name = 'SalesPipelineApiError';
  }
}

interface PgError { code?: string; message?: string }

const BY_MESSAGE: Record<string, SalesPipelineErrorCode> = {
  discount_requires_approval: 'discount_requires_approval',
  deal_desk_disabled: 'deal_desk_disabled',
  deal_not_found: 'deal_not_found',
  self_approval_not_allowed: 'self_approval',
  owner_approval_required: 'owner_required',
  discount_request_closed: 'closed',
  decision_note_required: 'note_required',
};

export function toApiError(e: PgError): SalesPipelineApiError {
  const msg = e.message ?? '';
  for (const [needle, code] of Object.entries(BY_MESSAGE)) if (msg.includes(needle)) return new SalesPipelineApiError(code);
  if (e.code === '23505') return new SalesPipelineApiError('duplicate_pending');
  if (e.code === '42501') return new SalesPipelineApiError('forbidden');
  if (e.code === '23514' || e.code === '22023' || e.code === '22003' || e.code === '23502') return new SalesPipelineApiError('invalid');
  return new SalesPipelineApiError('unknown');
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

// ---- stages ----------------------------------------------------------------

const STAGE_COLUMNS = 'id, stage_key, label, position, win_probability_pct, forecast_category, match_names';

export async function fetchStages(): Promise<PipelineStage[]> {
  const { data, error } = await supabase.from('crm_pipeline_stages').select(STAGE_COLUMNS).order('position', { ascending: true });
  if (error) throw toApiError(error);
  return ((data ?? []) as unknown as PipelineStage[]).map((s) => ({ ...s, win_probability_pct: num(s.win_probability_pct), match_names: s.match_names ?? [] }));
}

/** Inserts the default stages that are missing. Returns how many were added. */
export async function seedDefaultStages(): Promise<number> {
  const { data, error } = await supabase.rpc('crm_seed_default_pipeline_stages');
  if (error) throw toApiError(error);
  return num(data);
}

export interface StagePatch { label: string; win_probability_pct: number; forecast_category: ForecastCategory; match_names: string[] }

export async function updateStage(id: string, patch: StagePatch): Promise<void> {
  const { data, error } = await supabase.from('crm_pipeline_stages').update(patch).eq('id', id).select('id');
  if (error) throw toApiError(error);
  // RLS filters silently: zero rows means "not allowed or gone".
  if (!data || data.length === 0) throw new SalesPipelineApiError('forbidden');
}

// ---- deals (existing crm_deals table) --------------------------------------

export const DEAL_LIMIT = 1000;
const DEAL_COLUMNS = 'id, title, amount, currency, status, stage, close_date, discount_pct, updated_at';

export async function fetchDeals(): Promise<{ deals: PipelineDeal[]; truncated: boolean }> {
  const { data, error } = await supabase
    .from('crm_deals')
    .select(DEAL_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(DEAL_LIMIT + 1);
  if (error) throw toApiError(error);
  const rows = ((data ?? []) as unknown as PipelineDeal[]).map((d) => ({
    ...d, amount: d.amount === null ? null : Number(d.amount), discount_pct: num(d.discount_pct),
  }));
  return { deals: rows.slice(0, DEAL_LIMIT), truncated: rows.length > DEAL_LIMIT };
}

export interface DealPayload {
  title: string;
  amount: number | null;
  currency: string | null;
  stage: string | null;
  close_date: string | null;
  status: 'open' | 'won' | 'lost';
}

export async function createDeal(payload: DealPayload): Promise<void> {
  const { error } = await supabase.from('crm_deals').insert(payload);
  if (error) throw toApiError(error);
}

export async function updateDeal(id: string, patch: Partial<DealPayload> & { discount_pct?: number }): Promise<void> {
  const { data, error } = await supabase.from('crm_deals').update(patch).eq('id', id).select('id');
  if (error) throw toApiError(error);
  if (!data || data.length === 0) throw new SalesPipelineApiError('forbidden');
}

// ---- deal desk ---------------------------------------------------------------

export async function fetchDealDeskSettings(): Promise<DealDeskSettings> {
  const { data, error } = await supabase
    .from('crm_deal_desk_settings')
    .select('enabled, auto_approve_max_pct, manager_max_pct')
    .maybeSingle();
  if (error) throw toApiError(error);
  if (!data) return { enabled: false, auto_approve_max_pct: 10, manager_max_pct: 20 };
  return { enabled: Boolean(data.enabled), auto_approve_max_pct: num(data.auto_approve_max_pct), manager_max_pct: num(data.manager_max_pct) };
}

/** Owner only (RLS). `ownerId` is the account owner's id, i.e. the row key. */
export async function saveDealDeskSettings(ownerId: string, s: DealDeskSettings): Promise<void> {
  const { error } = await supabase.from('crm_deal_desk_settings').upsert({ user_id: ownerId, ...s }, { onConflict: 'user_id' });
  if (error) throw toApiError(error);
}

const REQUEST_COLUMNS = 'id, deal_id, requested_pct, reason, required_level, status, requested_by, decided_by, decided_at, decision_note, created_at';
export const REQUEST_LIMIT = 300;

export async function fetchRequests(): Promise<DiscountRequest[]> {
  const { data, error } = await supabase
    .from('crm_deal_discount_requests')
    .select(REQUEST_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(REQUEST_LIMIT);
  if (error) throw toApiError(error);
  return ((data ?? []) as unknown as DiscountRequest[]).map((r) => ({ ...r, requested_pct: num(r.requested_pct) }));
}

export async function createDiscountRequest(dealId: string, pct: number, reason: string): Promise<void> {
  // required_level, status, requested_by and the account are decided by the database trigger.
  const { error } = await supabase.from('crm_deal_discount_requests').insert({ deal_id: dealId, requested_pct: pct, reason });
  if (error) throw toApiError(error);
}

export async function decideRequest(id: string, status: 'approved' | 'rejected', note: string): Promise<void> {
  const { data, error } = await supabase
    .from('crm_deal_discount_requests')
    .update({ status, decision_note: note.trim() || null })
    .eq('id', id)
    .select('id');
  if (error) throw toApiError(error);
  if (!data || data.length === 0) throw new SalesPipelineApiError('forbidden');
}

export async function withdrawRequest(id: string): Promise<void> {
  const { data, error } = await supabase.from('crm_deal_discount_requests').update({ status: 'withdrawn' }).eq('id', id).select('id');
  if (error) throw toApiError(error);
  if (!data || data.length === 0) throw new SalesPipelineApiError('forbidden');
}
