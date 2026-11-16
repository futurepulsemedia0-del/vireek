import { supabase } from '@/lib/supabase';
import {
  parseCogsAiActions, parseCogsPlans, parseCogsTenants,
  type CogsAiActionRow, type CogsPlanRow, type CogsTenantRow,
} from '@/lib/cogs';

/** Thrown for any RPC failure; `forbidden` = the caller is not Vireek staff (SQLSTATE 42501). */
export class CogsError extends Error {
  constructor(message: string, readonly forbidden: boolean) {
    super(message);
  }
}

function fail(error: { message: string; code?: string }): never {
  throw new CogsError(error.message, error.code === '42501');
}

/** Every RPC re-checks is_vireek_staff server-side; the views themselves have no client grants. */
export async function fetchCogsByPlan(month: string): Promise<CogsPlanRow[]> {
  const { data, error } = await supabase.rpc('staff_cogs_by_plan', { p_month: month });
  if (error) fail(error);
  return parseCogsPlans(data);
}

export async function fetchCogsTenants(month: string, limit = 200): Promise<{ rows: CogsTenantRow[]; truncated: boolean }> {
  const { data, error } = await supabase.rpc('staff_cogs_tenants', { p_month: month, p_limit: limit });
  if (error) fail(error);
  return parseCogsTenants(data);
}

export async function fetchCogsAiActions(month: string): Promise<CogsAiActionRow[]> {
  const { data, error } = await supabase.rpc('staff_cogs_ai_actions', { p_month: month });
  if (error) fail(error);
  return parseCogsAiActions(data);
}
