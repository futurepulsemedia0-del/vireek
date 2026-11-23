// supabase/functions/_shared/compliance/callRecordingLedger.ts
//
// DB glue for public.call_recording_consents (supabase/migrations/20290306000000_call_recording_consents.sql).
// Same contract as _shared/ai-disclosure/ledger.ts: best-effort, NEVER throws, so the ledger cannot break a call webhook.
// DRAFT - NOT LEGAL ADVICE (see callStartPlan.ts).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  decideStorage, inferConsentOutcome, noticeInFirstAssistantTurn, turnsFromProviderMessages,
  type CallStartPlan, type ConsentOutcome, type Decision, type GateMode, type SpokenKind, type StorageDecision,
} from "./callStartPlan.ts";
import type { ProfileLanguage } from "./recordingProfiles.ts";

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function warn(event: string, err: unknown): void {
  console.error(JSON.stringify({ event, error: err instanceof Error ? err.message : String(err) }));
}

/** Called from assistant-request: writes the 'pending' evidence row (idempotent per call). */
export async function recordCallStartPlan(
  admin: SupabaseClient,
  input: { userId: string; vapiCallId: string | null; plan: CallStartPlan; businessCountry: string | null; businessSubdivision?: string | null },
): Promise<boolean> {
  try {
    if (!input.vapiCallId) return false; // no call id yet: nothing to key the proof on
    const p = input.plan;
    const { error } = await admin.from("call_recording_consents").upsert(
      {
        user_id: input.userId,
        vapi_call_id: input.vapiCallId,
        business_country: input.businessCountry,
        business_subdivision: input.businessSubdivision ?? null,
        caller_state: p.callerState,
        caller_state_source: p.callerStateSource,
        profile_jurisdiction: p.profile.jurisdiction,
        profile_mode: p.profile.mode,
        effective_mode: p.effectiveMode,
        legal_review: p.profile.legalReview,
        language: p.language,
        language_supported: p.languageSupported,
        gate_mode: p.gateMode,
        would_block: p.wouldBlock,
        decision: p.decision,
        recording_enabled_requested: p.recordingEnabled,
        spoken_kind: p.spokenKind,
        notice_text: p.spokenText || null,
        notice_sha256: p.spokenText ? await sha256Hex(p.spokenText) : null,
        consent_outcome: "pending",
      },
      { onConflict: "user_id,vapi_call_id", ignoreDuplicates: true },
    );
    if (error) { warn("call_recording_plan_insert_failed", error.message); return false; }
    return true;
  } catch (err) {
    warn("call_recording_plan_threw", err);
    return false;
  }
}

export interface FinalizeResult {
  outcome: ConsentOutcome;
  storage: StorageDecision;
}

interface LedgerRow {
  consent_outcome: ConsentOutcome;
  decision: Decision;
  gate_mode: GateMode;
  recording_enabled_requested: boolean;
  spoken_kind: SpokenKind;
  language: ProfileLanguage;
  notice_text: string | null;
  recording_stored: boolean | null;
  transcript_stored: boolean | null;
}

/**
 * Called from end-of-call-report BEFORE the call row is written. Infers the caller's answer, decides what may be
 * stored and finalizes the evidence row. Returns null when there is no plan row (static assistant / assistant-request
 * never reached us): the caller must then keep today's behaviour. Idempotent on redelivery.
 */
export async function finalizeCallRecording(
  admin: SupabaseClient,
  input: { userId: string; vapiCallId: string; message: unknown },
): Promise<FinalizeResult | null> {
  try {
    const { data } = await admin
      .from("call_recording_consents")
      .select("consent_outcome, decision, gate_mode, recording_enabled_requested, spoken_kind, language, notice_text, recording_stored, transcript_stored")
      .eq("user_id", input.userId)
      .eq("vapi_call_id", input.vapiCallId)
      .maybeSingle();
    const row = data as LedgerRow | null;
    if (!row) return null;

    const plan = { decision: row.decision, gateMode: row.gate_mode, recordingEnabled: row.recording_enabled_requested, spokenKind: row.spoken_kind };

    // Redelivered report: the proof is final, only recompute the decision from it.
    if (row.consent_outcome !== "pending") return { outcome: row.consent_outcome, storage: decideStorage(plan, row.consent_outcome) };

    const msg = (input.message ?? {}) as { artifact?: { messages?: unknown }; messages?: unknown };
    const turns = turnsFromProviderMessages(msg.artifact?.messages ?? msg.messages);
    const inferred = inferConsentOutcome(turns, row.language, row.spoken_kind);
    const storage = decideStorage(plan, inferred.outcome);
    const inFirstTurn = row.notice_text ? noticeInFirstAssistantTurn(turns, row.notice_text) : null;

    const { error } = await admin
      .from("call_recording_consents")
      .update({
        consent_outcome: inferred.outcome,
        consent_method: "transcript_inferred",
        consent_turn_index: inferred.turnIndex,
        consent_excerpt: inferred.excerpt,
        notice_in_first_turn: inFirstTurn,
        recording_stored: storage.storeRecording,
        transcript_stored: storage.storeTranscript,
        storage_reason: storage.reason,
        provider_deletion_required: storage.providerDeletionRequired,
        finalized_at: new Date().toISOString(),
      })
      .eq("user_id", input.userId)
      .eq("vapi_call_id", input.vapiCallId)
      .eq("consent_outcome", "pending");
    if (error) warn("call_recording_finalize_failed", error.message);
    return { outcome: inferred.outcome, storage };
  } catch (err) {
    warn("call_recording_finalize_threw", err);
    return null;
  }
}
