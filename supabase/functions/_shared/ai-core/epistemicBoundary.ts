// supabase/functions/_shared/ai-core/epistemicBoundary.ts
//
// Epistemic Boundary Detector
// --------------------------------------------------------------------
// knowledge_gaps already catches "I know I don't know": zero search
// hits, logged and counted. What it doesn't catch is the more
// dangerous case — search_knowledge_articles returns SOMETHING,
// formatKnowledgeForVoice reads it out as a stated fact, and neither
// the AI nor the caller has any idea it was actually a weak, low-
// confidence guess. That's "not knowing that you don't know": the
// system is confident it answered, when it really just returned the
// least-bad match.
//
// Every search result gets classified into one of three tiers before
// anything is said out loud:
//
//   "confident"   - a real match: lexical AND semantic agree, or a
//                    high raw cosine similarity, or (no embedding
//                    provider configured at all, so there's no
//                    semantic signal to check against) a clean top
//                    lexical rank.
//   "weak_match"  - something came back, but it's a guess, not a
//                    known fact.
//   "no_coverage" - nothing came back at all (the pre-existing case).
//
// ACTIVE LEARNING TRIGGER: recordEpistemicBoundary() calls the same
// record_knowledge_gap() RPC either way (now boundary-aware — see
// supabase/migrations/20261204000000_epistemic_boundary_detector.sql).
// A trigger on knowledge_gaps fires append_activity_event
// ('knowledge.boundary_critical') the moment a gap first becomes a
// weak_match or first crosses asked_count >= 3 — the exact mechanism
// service-recovery-agent already uses to auto-enroll a playbook. No
// cron job has to notice; the boundary pushes itself into the
// existing activity fabric the instant it matters.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import type { KnowledgeSearchResult } from "../knowledge/search.ts";

export type EpistemicTier = "confident" | "weak_match" | "no_coverage";

export interface BoundaryClassification {
  tier: EpistemicTier;
  bestScore: number;
}

const CONFIDENT_SIMILARITY = 0.55;

/**
 * Classifies a search result. `semanticAvailable` should be
 * `result.semantic` from searchKnowledge() — without an embedding
 * provider configured there's no cosine similarity to check at all,
 * so a clean top lexical rank is treated as confident instead of
 * unfairly downgraded to a boundary case every time.
 */
export function classifyEpistemicBoundary(
  result: KnowledgeSearchResult,
  semanticAvailable: boolean,
): BoundaryClassification {
  if (result.hits.length === 0) return { tier: "no_coverage", bestScore: 0 };

  const best = result.hits[0];
  const bestScore = best.semantic_similarity ?? 0;

  const confident =
    bestScore >= CONFIDENT_SIMILARITY ||
    (best.lexical_rank === 1 && best.semantic_rank !== null) ||
    (!semanticAvailable && best.lexical_rank === 1);

  return { tier: confident ? "confident" : "weak_match", bestScore };
}

/**
 * Logs anything short of "confident" into knowledge_gaps — a true
 * miss and a shaky guess both mean the knowledge base needs work,
 * just in different ways (write a new article vs. fix an existing
 * one that's matching but not actually answering).
 */
export async function recordEpistemicBoundary(
  admin: SupabaseClient,
  userId: string,
  question: string,
  classification: BoundaryClassification,
  source: "voice" | "chat" | "dashboard" | "sms" = "voice",
  callId: string | null = null,
): Promise<void> {
  if (classification.tier === "confident") return;

  const { error } = await admin.rpc("record_knowledge_gap", {
    p_user_id: userId,
    p_question: question,
    p_source: source,
    p_call_id: callId,
    p_boundary_type: classification.tier,
    p_best_score: classification.bestScore,
  });
  if (error) {
    console.error(JSON.stringify({ event: "epistemic_boundary_record_failed", error: error.message }));
  }
}
