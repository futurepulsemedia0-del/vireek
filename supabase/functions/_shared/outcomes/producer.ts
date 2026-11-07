// supabase/functions/_shared/outcomes/producer.ts
//
// Canonical way for ANY agent/workflow to attach an outcome to an
// agent_action_log row. Thin, validated wrapper over the existing
// record_agent_action_business_outcome() RPC (single source of truth).
//
//   await attachOutcome(admin, auth.logId, {
//     outcome: "success", financialImpactCents: 12500,
//     evidenceRef: "invoices:<uuid>", confidence: 0.9,
//   });

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export type OutcomeKind = "success" | "partial" | "failure" | "no_effect" | "unknown";

export interface AttachOutcomeInput {
  outcome: OutcomeKind;
  /** Signed: positive = value gained, negative = value lost. Whole cents. */
  financialImpactCents?: number | null;
  /** 0..1. Use < 1 for heuristic measurements. */
  confidence?: number;
  /** Pointer such as "invoices:<id>". Never put PII or free text here. */
  evidenceRef?: string;
  recordedBy?: "system" | "human";
}

const OUTCOMES: readonly string[] = ["success", "partial", "failure", "no_effect", "unknown"];

export function validateOutcomeInput(i: AttachOutcomeInput): string | null {
  if (!OUTCOMES.includes(i.outcome)) return "invalid_outcome";
  if (i.confidence !== undefined && !(i.confidence >= 0 && i.confidence <= 1)) return "invalid_confidence";
  if (i.financialImpactCents != null && !Number.isInteger(i.financialImpactCents)) return "financial_impact_must_be_integer_cents";
  if (i.financialImpactCents != null && Math.abs(i.financialImpactCents) > 2_000_000_000) return "financial_impact_out_of_range";
  return null;
}

export async function attachOutcome(
  admin: SupabaseClient,
  logId: string,
  input: AttachOutcomeInput,
): Promise<{ ok: boolean; error?: string }> {
  const bad = validateOutcomeInput(input);
  if (bad) return { ok: false, error: bad };
  const { error } = await admin.rpc("record_agent_action_business_outcome", {
    p_log_id: logId,
    p_outcome: input.outcome,
    p_financial_impact_cents: input.financialImpactCents ?? null,
    p_confidence: input.confidence ?? 1,
    p_evidence: input.evidenceRef ? { evidence_ref: input.evidenceRef } : {},
    p_notes: null,
    p_recorded_by: input.recordedBy ?? "system",
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}
