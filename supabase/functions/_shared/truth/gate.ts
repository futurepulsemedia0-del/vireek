// supabase/functions/_shared/truth/gate.ts
//
// Data access + the gate every Vireek agent must pass before acting on an
// operational fact. Server-side only (takes a service-role client).
//
//   import { requireFreshTruth } from "../_shared/truth/gate.ts";
//
//   const truth = await requireFreshTruth(admin, accountId, "dispatch-auto-assign", {
//     subject_type: "technician",
//     subject_id: technicianId,
//     predicate: "credential.hvac_license",
//     expected: true,
//   });
//   if (!truth.allow) { /* do NOT act: truth.reason / truth.required_action explain why */ }
//
// Fail-closed: if the engine cannot evaluate (database error), the result is
// allow=false. A failure to WRITE the audit row is logged but never flips an
// otherwise-valid verdict.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  resolvePolicy,
  resolveTruth,
  type TruthFact,
  type TruthPolicy,
  type TruthResolution,
} from "./engine.ts";

export interface TruthQuery {
  subject_type: string;
  subject_id: string;
  predicate: string;
  expected?: unknown;
}

export const FACT_COLUMNS =
  "id, subject_type, subject_id, predicate, value, source_key, source_ref, verified_at, expires_at, base_confidence, truth_evidence(count)";

export type FactRow = Omit<TruthFact, "evidence_count"> & { truth_evidence?: Array<{ count: number }> | null };

export function toFact(row: FactRow): TruthFact {
  const { truth_evidence, ...rest } = row;
  return { ...rest, evidence_count: Number(truth_evidence?.[0]?.count ?? 0) };
}

export async function loadPolicies(admin: SupabaseClient, userId: string): Promise<TruthPolicy[]> {
  const { data, error } = await admin
    .from("truth_policies")
    .select("predicate, min_confidence, max_age_days, min_independent_sources, expiring_warning_days")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((p) => ({
    predicate: String(p.predicate),
    min_confidence: Number(p.min_confidence),
    max_age_days: Number(p.max_age_days),
    min_independent_sources: Number(p.min_independent_sources),
    expiring_warning_days: Number(p.expiring_warning_days),
  }));
}

export async function loadFacts(admin: SupabaseClient, userId: string, q: TruthQuery): Promise<TruthFact[]> {
  const { data, error } = await admin
    .from("truth_facts")
    .select(FACT_COLUMNS)
    .eq("user_id", userId)
    .eq("subject_type", q.subject_type)
    .eq("subject_id", q.subject_id)
    .eq("predicate", q.predicate)
    .eq("status", "current");
  if (error) throw error;
  return ((data ?? []) as unknown as FactRow[]).map(toFact);
}

export async function evaluateTruth(admin: SupabaseClient, userId: string, q: TruthQuery, now: Date = new Date()): Promise<TruthResolution> {
  const [facts, policies] = await Promise.all([loadFacts(admin, userId, q), loadPolicies(admin, userId)]);
  return resolveTruth(facts, resolvePolicy(q.predicate, policies), { expected: q.expected, now });
}

/** Keeps truth_conflicts in step with what the engine currently sees. */
export async function syncConflict(admin: SupabaseClient, userId: string, q: TruthQuery, res: TruthResolution): Promise<void> {
  if (res.verdict === "conflict" && res.conflict) {
    const { error } = await admin.from("truth_conflicts").insert({
      user_id: userId,
      subject_type: q.subject_type,
      subject_id: q.subject_id,
      predicate: q.predicate,
      fact_ids: res.conflict.fact_ids,
      detail: {
        leading_value: res.conflict.leading_value,
        leading_confidence: res.conflict.leading_confidence,
        competing_value: res.conflict.competing_value,
        competing_confidence: res.conflict.competing_confidence,
      },
    });
    // 23505 = an open conflict for this subject/predicate already exists.
    if (error && error.code !== "23505") console.error("truth conflict insert failed", error.message);
    return;
  }
  if (res.verdict !== "conflict") {
    const { error } = await admin
      .from("truth_conflicts")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution: { auto: true, verdict: res.verdict } })
      .eq("user_id", userId)
      .eq("subject_type", q.subject_type)
      .eq("subject_id", q.subject_id)
      .eq("predicate", q.predicate)
      .eq("status", "open");
    if (error) console.error("truth conflict auto-resolve failed", error.message);
  }
}

export async function recordDecision(admin: SupabaseClient, userId: string, agent: string, q: TruthQuery, res: TruthResolution): Promise<void> {
  const { error } = await admin.from("truth_decisions").insert({
    user_id: userId,
    agent: agent.slice(0, 80) || "unknown",
    subject_type: q.subject_type,
    subject_id: q.subject_id,
    predicate: q.predicate,
    verdict: res.verdict,
    allow: res.allow,
    confidence: res.confidence,
    reason: res.reason.slice(0, 500),
    fact_ids: res.winning_fact_ids,
  });
  if (error) console.error("truth decision audit write failed", error.message);
}

/** The gate. Evaluates, keeps conflicts in sync, writes the audit row, returns the verdict. */
export async function requireFreshTruth(admin: SupabaseClient, userId: string, agent: string, q: TruthQuery): Promise<TruthResolution> {
  let res: TruthResolution;
  try {
    res = await evaluateTruth(admin, userId, q);
  } catch (err) {
    console.error("truth evaluation failed (failing closed)", err instanceof Error ? err.message : err);
    const policy = resolvePolicy(q.predicate);
    return {
      verdict: "unverified",
      allow: false,
      reason: "The Truth Engine could not evaluate this fact, so the action was not allowed.",
      required_action: "Retry shortly; if it persists, check the operational-truth function logs.",
      resolved_value: null,
      confidence: 0,
      winning_fact_ids: [],
      conflict: null,
      assessments: [],
      warnings: [],
      policy,
      evaluated_at: new Date().toISOString(),
    };
  }
  await Promise.all([syncConflict(admin, userId, q, res), recordDecision(admin, userId, agent, q, res)]);
  return res;
}
