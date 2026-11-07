// Tenant-facing ROI: conservative, auditable. Inputs come from tenant_roi_inputs() (the caller's OWN attributed outcomes);
// the math and every exclusion rule live in supabase/functions/_shared/economics/roi.ts. Cost side = the LIST monthly price of
// the tenant's plan (annual billing is cheaper, so ROI is understated, never overstated). Not enough data -> no number.
import { supabase } from '@/lib/supabase';
import { PRICING_PLANS } from '@/lib/pricing';
import { computeRoi, type AttributedOutcome, type RoiResult } from '../../supabase/functions/_shared/economics/roi';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function planCostCents(planId: string, days: number): number | null {
  const monthly = PRICING_PLANS.find((p) => p.id === planId)?.monthly;
  if (monthly == null || monthly <= 0 || !(days > 0)) return null; // free / enterprise / unknown: no ROI figure
  return Math.round(monthly * 100 * (days / 30));
}

export function parseRoiInputs(raw: unknown): { outcomes: AttributedOutcome[]; outcomesTotal: number } {
  if (!isObj(raw)) return { outcomes: [], outcomesTotal: 0 };
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const outcomes: AttributedOutcome[] = [];
  for (const r of rows) {
    if (!isObj(r) || typeof r.id !== 'string') continue;
    outcomes.push({
      id: r.id, actionAt: String(r.action_at ?? ''), outcomeAt: String(r.outcome_at ?? ''),
      valueCents: typeof r.value_cents === 'number' ? r.value_cents : Number.NaN, confidence: Number(r.confidence),
      rule: `agent_action_outcome:${String(r.action_slug ?? 'unknown')}`,
    });
  }
  return { outcomes, outcomesTotal: typeof raw.outcomes_total === 'number' ? raw.outcomes_total : Number(raw.outcomes_total ?? 0) || 0 };
}

export interface TenantRoi { result: RoiResult; outcomes: AttributedOutcome[]; outcomesTotal: number; days: number; planId: string }

export async function fetchTenantRoi(planId: string, days = 90): Promise<TenantRoi> {
  const end = new Date(); const start = new Date(end.getTime() - days * 86_400_000);
  const { data, error } = await supabase.rpc('tenant_roi_inputs', { p_start: start.toISOString(), p_end: end.toISOString() });
  if (error) throw new Error(error.message);
  const { outcomes, outcomesTotal } = parseRoiInputs(data);
  return { result: computeRoi(outcomes, planCostCents(planId, days)), outcomes, outcomesTotal, days, planId };
}
