import { supabase } from '@/lib/supabase';

export interface MarginGuardrailResult {
  verdict: 'within_floor' | 'blocked' | 'overridden';
  revenue_cents: number;
  estimated_cost_cents: number;
  margin_pct: number | null;
  margin_floor_pct: number;
  breakdown: { description: string; revenue_cents: number; cost_cents: number; matched: boolean }[];
  can_send: boolean;
}

/**
 * Runs the deterministic margin guardrail check against a saved quote.
 * Pass overrideReason to authorize sending below the floor (requires the
 * caller to be the account owner or a team member with can_view_billing).
 * Throws with a user-facing message on error (including a 403 for an
 * unauthorized override attempt).
 */
export async function checkMarginGuardrail(
  quoteId: string,
  opts?: { overrideReason?: string; discountType?: 'percent' | 'flat'; discountValue?: number },
): Promise<MarginGuardrailResult> {
  const { data, error } = await supabase.functions.invoke('check-margin-guardrail', {
    body: {
      quoteId,
      overrideReason: opts?.overrideReason,
      discountType: opts?.discountType,
      discountValue: opts?.discountValue,
    },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as MarginGuardrailResult;
}
